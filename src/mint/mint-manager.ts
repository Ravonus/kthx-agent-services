/**
 * MintManager: full bot-token mint lifecycle.
 *
 * Handles: request grant -> receive challenge -> solve -> confirm.
 * Includes retry with exponential backoff, failure streak tracking,
 * manual retry gating, and util-agent challenge solving.
 *
 * Ported from agent-runtime.mjs lines 8393-9425.
 */

import fs from "node:fs/promises";
import { nowIso, toAnswerPreview, sanitizeChallengePromptText } from "../lib/text.js";
import { isRecord } from "../lib/guards.js";
import { appendJsonLine } from "../lib/fs-helpers.js";
import { getBotToken, setBotTokenState } from "../auth/bot-token.js";
import {
  normalizeChallengeAnswerForSubmit, isMultipleChoiceChallengeInstruction,
  answerChallengeWithOpenClaw,
  parseMintChallengeRetryRequired,
} from "./challenge.js";
import type { ChallengeContext } from "./challenge.js";
import type { MintManagerLike, MintTrackingState } from "../runtime-context.js";

// ---------------------------------------------------------------------------
// Narrow context
// ---------------------------------------------------------------------------

export interface MintManagerContext {
  mint: MintTrackingState;
  config: {
    connectionId: string;
    challengeAnswerMaxChars: number;
    mintChallengeUseOpenClaw: boolean;
    rejectMultipleChoiceChallenges: boolean;
    mintChallengeAutoRetryEnabled: boolean;
    mintChallengeAutoRetryMaxAttempts: number;
    mintRetryMinBackoffMs: number;
    mintRetryMaxBackoffMs: number;
  };
  ipcPaths: {
    mintDebugPath: string;
    mintTracePath: string;
  };
  misc: { subscriptionResyncRequested: boolean; subscriptionResyncReason: string | null };
  memory: { recordWrite(payload: unknown): Promise<void> };
  trpc: { realtime: { mintBotToken: { mutate(input: unknown): Promise<unknown> } } } | null;
  wsClient: { activeConnection: { close(): Promise<void> } } | null;
  runBackendCall<T>(label: string, fn: () => Promise<T>): Promise<T>;
  markWsActivity(source: string): void;
  getRuntimeAttestation(connectionId: string): unknown;
  runUtilAgentPrompt?: (input: {
    prompt: string;
    purpose: string;
  }) => Promise<{ parsed: unknown; payloadText?: string | null; raw?: string | null } | null>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const errCode = (e: unknown): string | null => {
  if (!isRecord(e)) return null;
  const d = isRecord(e.data) ? e.data : null;
  if (d && typeof d.code === "string") return d.code as string;
  const s = isRecord(e.shape) ? e.shape : null;
  const sd = s && isRecord(s.data) ? s.data : null;
  return sd && typeof sd.code === "string" ? (sd.code as string) : null;
};

const errMsg = (e: unknown): string => {
  const baseMessage =
    e instanceof Error && e.message.trim().length > 0
      ? e.message.trim()
      : typeof e === "string" && e.trim().length > 0
        ? e.trim()
        : "";
  const shape = isRecord(e) && isRecord(e.shape) ? e.shape : null;
  const shapeMessage =
    shape && typeof shape.message === "string" && shape.message.trim().length > 0
      ? shape.message.trim()
      : "";
  const cause = isRecord(e) && isRecord(e.cause) ? e.cause : null;
  const causeMessage =
    cause && typeof cause.message === "string" && cause.message.trim().length > 0
      ? cause.message.trim()
      : "";
  const data = isRecord(e) && isRecord(e.data) ? e.data : null;
  const dataCode =
    data && typeof data.code === "string" && data.code.trim().length > 0
      ? data.code.trim()
      : "";
  const httpStatus =
    data && typeof data.httpStatus === "number" && Number.isFinite(data.httpStatus)
      ? Math.floor(data.httpStatus)
      : null;

  const bestMessage =
    (baseMessage && baseMessage.toLowerCase() !== "unknown error" ? baseMessage : "") ||
    shapeMessage ||
    causeMessage ||
    baseMessage;
  if (!bestMessage.length) return "unknown error";

  const suffixParts: string[] = [];
  if (dataCode.length > 0) suffixParts.push(`code=${dataCode}`);
  if (httpStatus !== null) suffixParts.push(`httpStatus=${httpStatus}`);
  if (suffixParts.length === 0) return bestMessage;
  return `${bestMessage} (${suffixParts.join(", ")})`;
};

const MINT_CHALLENGE_SOLVER_MAX_ATTEMPTS = 2;
const MINT_CHALLENGE_SOLVER_RETRY_DELAY_MS = 500;
const MINT_MAX_CHALLENGE_STEPS_PER_FLOW = 12;
const MINT_MAX_SOLVER_FLOW_FAILS_PER_CHALLENGE = 3;
const MINT_PENDING_CHALLENGE_EXPIRY_SKEW_MS = 1_000;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

interface MintDebug {
  updatedAt: string; inFlight: boolean; reason: string | null;
  challengeId: string | null; promptToken: string | null;
  pendingChallengeId: string | null; pendingPromptToken: string | null;
  pendingChallengeExpiresAt: string | null;
  pendingChallengeInstruction: string | null;
  pendingChallengeAnswerType: string | null;
  pendingChallengeAttemptsRemaining: number | null;
  pendingChallengeSolverFailures: number;
  attemptSerial: number; attemptsInCurrentFlow: number;
  lastRequest: Record<string, unknown> | null;
  lastResponse: Record<string, unknown> | null;
  lastError: Record<string, unknown> | null;
}

interface PendingMintChallenge {
  challengeId: string;
  promptToken: string | null;
  instruction: string;
  answerType: string | null;
  attemptsRemaining: number | null;
  expiresAt: string | null;
  expiresAtMs: number | null;
  solverFailures: number;
}

// ---------------------------------------------------------------------------
// MintManager
// ---------------------------------------------------------------------------

export class MintManager implements MintManagerLike {
  private readonly ctx: MintManagerContext;
  private readonly dbg: MintDebug = {
    updatedAt: nowIso(), inFlight: false, reason: null,
    challengeId: null, promptToken: null, attemptSerial: 0,
    pendingChallengeId: null, pendingPromptToken: null, pendingChallengeExpiresAt: null,
    pendingChallengeInstruction: null, pendingChallengeAnswerType: null,
    pendingChallengeAttemptsRemaining: null, pendingChallengeSolverFailures: 0,
    attemptsInCurrentFlow: 0, lastRequest: null, lastResponse: null, lastError: null,
  };
  private pendingChallenge: PendingMintChallenge | null = null;

  constructor(ctx: MintManagerContext) { this.ctx = ctx }

  async initialize(): Promise<void> {
    await this.restorePendingChallengeFromDebug();
    await this.writeDbg();
  }

  // -- Public API ----------------------------------------------------------

  async attemptMint(reason = "runtime"): Promise<void> {
    const m = this.ctx.mint;
    if (reason === "console_mint_retry") {
      m.mintManualRetryRequired = false;
      m.mintManualRetryReason = null;
      m.lastMintManualWaitLogAtMs = 0;
    }
    if (m.mintManualRetryRequired && reason !== "console_mint_retry") {
      const now = Date.now();
      if (now - m.lastMintManualWaitLogAtMs >= 30_000) {
        m.lastMintManualWaitLogAtMs = now;
        await this.ctx.memory.recordWrite({
          type: "bot_token_mint_waiting_manual_retry", at: nowIso(), reason,
          mintManualRetryReason: m.mintManualRetryReason,
        });
      }
      return;
    }
    if (await getBotToken()) return;
    if (m.mintInFlightPromise) {
      await this.trace({ type: "mint_join_existing", reason, activeReason: m.activeMintReason, challengeId: m.activeMintChallengeId });
      if (Date.now() - m.lastMintJoinLogAtMs >= 5_000) {
        m.lastMintJoinLogAtMs = Date.now();
        await this.ctx.memory.recordWrite({ type: "bot_token_mint_waiting_existing", reason, at: nowIso(), challengeId: m.activeMintChallengeId });
      }
      await m.mintInFlightPromise;
      return;
    }
    if (Date.now() < m.nextMintAttemptAtMs) return;
    const attempt = this.runFlow(reason);
    m.mintInFlightPromise = attempt;
    try { await attempt } finally { if (m.mintInFlightPromise === attempt) m.mintInFlightPromise = null }
  }

  cancelActiveMint(): void {
    const m = this.ctx.mint;
    m.mintInFlightPromise = null;
    m.activeMintChallengeId = null;
    m.activeMintPromptToken = null;
    m.activeMintReason = null;
    this.clearPendingChallenge();
  }

  dispose(): void { this.cancelActiveMint() }

  // -- Core flow -----------------------------------------------------------

  private async runFlow(reason: string): Promise<void> {
    const m = this.ctx.mint;
    m.activeMintReason = reason;
    this.dbg.inFlight = true;
    this.dbg.reason = reason;
    this.dbg.attemptsInCurrentFlow = 0;
    await this.writeDbg();
    await this.trace({ type: "mint_flow_start", reason, challengeId: m.activeMintChallengeId });
    try {
      const result = await this.mintOverSocket(reason);
      const alreadyConnected = isRecord(result) && result.alreadyConnected === true;
      m.mintFailureStreak = 0;
      m.nextMintAttemptAtMs = 0;
      m.lastMintFailureAtIso = null;
      m.lastMintFailureMessage = null;
      m.mintManualRetryRequired = false;
      m.mintManualRetryReason = null;
      m.lastMintManualWaitLogAtMs = 0;
      this.dbg.lastError = null;
      await this.writeDbg();
      await this.trace({ type: alreadyConnected ? "mint_flow_already_connected" : "mint_flow_success", reason, challengeId: m.activeMintChallengeId });
      if (!alreadyConnected && this.ctx.wsClient) {
        this.ctx.misc.subscriptionResyncRequested = true;
        this.ctx.misc.subscriptionResyncReason = "mint_success_reconnect";
        await this.ctx.wsClient.activeConnection.close().catch(() => {});
      }
    } catch (error: unknown) {
      m.mintFailureStreak += 1;
      const manual = this.needsManualRetry(error);
      const backoff = Math.min(this.ctx.config.mintRetryMaxBackoffMs, this.ctx.config.mintRetryMinBackoffMs * m.mintFailureStreak);
      m.nextMintAttemptAtMs = manual ? 0 : Date.now() + backoff;
      m.lastMintFailureAtIso = nowIso();
      m.lastMintFailureMessage = errMsg(error);
      if (manual) { m.mintManualRetryRequired = true; m.mintManualRetryReason = m.lastMintFailureMessage }
      const retryAt = manual || m.nextMintAttemptAtMs <= 0 ? null : new Date(m.nextMintAttemptAtMs).toISOString();
      await this.ctx.memory.recordWrite({ type: "bot_token_mint_failed", reason, at: nowIso(), error: m.lastMintFailureMessage, retryAt, manualRetryRequired: manual });
      this.dbg.lastError = { code: errCode(error), message: m.lastMintFailureMessage, retryAt, manualRetryRequired: manual };
      await this.writeDbg();
      await this.trace({ type: "mint_flow_failed", reason, code: errCode(error), message: m.lastMintFailureMessage, manualRetryRequired: manual, challengeId: m.activeMintChallengeId });
    } finally {
      this.dbg.inFlight = false; this.dbg.reason = null;
      this.dbg.challengeId = null; this.dbg.promptToken = null;
      await this.writeDbg();
      m.activeMintChallengeId = null; m.activeMintPromptToken = null; m.activeMintReason = null;
    }
  }

  // -- Challenge loop ------------------------------------------------------

  private async mintOverSocket(reason: string): Promise<{ token: string; alreadyConnected: boolean } | null> {
    if (!this.ctx.trpc) throw new Error("tRPC client not available for mintBotToken.");
    const fresh = reason === "console_mint_retry";
    if (fresh) {
      this.clearPendingChallenge();
    }
    let issued: unknown;
    const resumableChallenge = fresh ? null : this.getResumablePendingChallenge();
    if (resumableChallenge) {
      issued = {
        challengeRequired: true,
        challengeId: resumableChallenge.challengeId,
        promptToken: resumableChallenge.promptToken,
        instruction: resumableChallenge.instruction,
        challenge: resumableChallenge.answerType
          ? { answerType: resumableChallenge.answerType }
          : undefined,
        attemptsRemaining: resumableChallenge.attemptsRemaining,
      };
      await this.trace({
        type: "mint_challenge_resume_local",
        reason,
        challengeId: resumableChallenge.challengeId,
        promptToken: resumableChallenge.promptToken,
        expiresAt: resumableChallenge.expiresAt,
        attemptsRemaining: resumableChallenge.attemptsRemaining,
      });
    } else {
      issued = await this.reqMint(null, null, null, fresh, null);
    }
    if (fresh) await this.trace({ type: "mint_fresh_challenge_explicit", reason });
    let answered = 0;
    let challengeSteps = 0;

    while (issued && (issued as Record<string, unknown>).challengeRequired) {
      challengeSteps += 1;
      if (challengeSteps > MINT_MAX_CHALLENGE_STEPS_PER_FLOW) {
        throw new Error(
          `Mint challenge flow exceeded guard limit (${MINT_MAX_CHALLENGE_STEPS_PER_FLOW} steps). Run \`mint retry\`.`,
        );
      }
      const r = issued as Record<string, unknown>;
      const cid = typeof r.challengeId === "string" ? r.challengeId : null;
      const cpt = typeof r.promptToken === "string" ? r.promptToken
        : isRecord(r.challenge) && typeof (r.challenge as Record<string, unknown>).promptToken === "string"
          ? ((r.challenge as Record<string, unknown>).promptToken as string) : null;
      this.ctx.mint.activeMintChallengeId = cid;
      this.ctx.mint.activeMintPromptToken = cpt;
      const rawInstr = typeof r.instruction === "string" ? (r.instruction as string) : "Solve mint challenge";
      const instr = sanitizeChallengePromptText(rawInstr) || "Solve mint challenge";
      const ansType = isRecord(r.challenge) && typeof (r.challenge as Record<string, unknown>).answerType === "string"
        ? ((r.challenge as Record<string, unknown>).answerType as string).trim().toLowerCase() : null;
      this.capturePendingChallenge({
        challengeId: cid,
        promptToken: cpt,
        instruction: instr,
        answerType: ansType,
        attemptsRemaining:
          typeof r.attemptsRemaining === "number" && Number.isFinite(r.attemptsRemaining)
            ? Math.max(0, Math.floor(r.attemptsRemaining))
            : null,
        expiresAt: typeof r.expiresAt === "string" ? r.expiresAt : null,
      });
      await this.trace({
        type: "mint_challenge_received",
        challengeId: cid,
        promptToken: cpt ?? null,
        answerType: ansType,
        attemptsUsed: answered,
      });
      if (ansType === "multiple_choice" || isMultipleChoiceChallengeInstruction(instr)) {
        if (this.ctx.config.rejectMultipleChoiceChallenges) throw new Error("Multiple-choice challenges rejected by runtime config.");
        await this.ctx.memory.recordWrite({ type: "bot_token_mint_challenge_multiple_choice_compat", at: nowIso(), challengeId: cid, challengeAnswerType: ansType, instruction: toAnswerPreview(instr, 180) });
      }
      if (!cid) throw new Error("Socket mint challenge missing challengeId.");
      if (!this.ctx.config.mintChallengeUseOpenClaw) {
        throw new Error(`Socket mint challenge required (challengeId=${cid}). Enable OpenClaw challenge solving.`);
      }
      await this.ctx.memory.recordWrite({ type: "bot_token_mint_challenge_required", reason, at: nowIso(), challengeId: cid, instruction: instr });
      const chCtx = this.chalCtx();
      const instrTok = cpt?.trim().length ? `${instr} [questionToken: ${cpt.trim()}]` : instr;
      let answer: string | null = null;
      for (
        let solverAttempt = 1;
        solverAttempt <= MINT_CHALLENGE_SOLVER_MAX_ATTEMPTS && !answer;
        solverAttempt += 1
      ) {
        await this.trace({
          type: "mint_answer_generate_attempt",
          challengeId: cid,
          solverAttempt,
          attemptsUsed: answered,
        });
        answer = await answerChallengeWithOpenClaw(chCtx, {
          challengeId: cid,
          promptToken: cpt,
          instruction: instrTok,
          attemptsUsed: answered,
        });
        if (answer) {
          await this.trace({
            type: "mint_answer_generate_success",
            challengeId: cid,
            solverAttempt,
            answerPreview: toAnswerPreview(answer),
          });
          break;
        }
        await this.trace({
          type: "mint_answer_generate_empty",
          challengeId: cid,
          solverAttempt,
        });
        if (solverAttempt < MINT_CHALLENGE_SOLVER_MAX_ATTEMPTS) {
          await sleep(MINT_CHALLENGE_SOLVER_RETRY_DELAY_MS);
        }
      }
      if (!answer) {
        const solverFailures = this.bumpPendingSolverFailure(cid);
        await this.trace({
          type: "mint_answer_solver_guard",
          challengeId: cid,
          solverFailures,
          maxSolverFailures: MINT_MAX_SOLVER_FLOW_FAILS_PER_CHALLENGE,
        });
        if (solverFailures >= MINT_MAX_SOLVER_FLOW_FAILS_PER_CHALLENGE) {
          this.clearPendingChallenge();
          throw new Error(
            "Mint challenge solver failed repeatedly for active challenge. Run `mint retry`.",
          );
        }
        throw new Error(
          "Mint challenge answer unavailable from OpenClaw after solver retries.",
        );
      }
      this.resetPendingSolverFailure(cid);
      await this.trace({ type: "mint_answer_submitted", challengeId: cid, answerPreview: toAnswerPreview(answer) });
      answered += 1;
      await this.trace({
        type: "mint_verify_request",
        challengeId: cid,
        promptToken: cpt ?? null,
        hasAnswer: true,
      });
      issued = await this.reqMint(cid, answer, cpt, false, instr);
      await this.trace({
        type: "mint_verify_response",
        challengeId: cid,
        challengeRequired: Boolean(
          isRecord(issued) && (issued as Record<string, unknown>).challengeRequired,
        ),
      });
      if (issued && (issued as Record<string, unknown>).challengeRequired) {
        const attemptsRemainingRaw =
          typeof (issued as Record<string, unknown>).attemptsRemaining === "number"
            ? ((issued as Record<string, unknown>).attemptsRemaining as number)
            : null;
        const attemptsRemaining =
          attemptsRemainingRaw !== null && Number.isFinite(attemptsRemainingRaw)
            ? Math.max(0, Math.floor(attemptsRemainingRaw))
            : null;
        const exhausted = !this.ctx.config.mintChallengeAutoRetryEnabled || answered >= this.ctx.config.mintChallengeAutoRetryMaxAttempts;
        const attemptsExhaustedByServer =
          attemptsRemaining !== null && attemptsRemaining <= 0;
        await this.ctx.memory.recordWrite({
          type: "bot_token_mint_challenge_answer_rejected",
          at: nowIso(),
          challengeId: cid,
          submittedChallengeAnswers: answered,
          attemptsRemaining,
          attemptsExhausted: exhausted || attemptsExhaustedByServer,
        });
        if (attemptsExhaustedByServer) {
          this.clearPendingChallenge();
          throw new Error("Mint challenge attempts exhausted by server. Run `mint retry`.");
        }
        if (exhausted) throw new Error(`Mint challenge not accepted after ${answered} attempt${answered === 1 ? "" : "s"}. Run \`mint retry\`.`);
        if ((issued as Record<string, unknown>).retryRequired === true) {
          // Server asks for explicit retry; keep the current challenge flow
          // instead of forcing a new challenge issuance.
          issued = await this.reqMint(null, null, null, false, null);
        }
      }
    }
    this.clearPendingChallenge();
    // Already-connected shortcut.
    const ir = issued as Record<string, unknown> | null;
    if (ir && ir.challengeRequired === false && (ir.alreadyConnected === true || ir.done === true || ir.status === "already_connected")) {
      const issuedToken =
        typeof ir.sessionToken === "string" && ir.sessionToken.trim().length > 0
          ? ir.sessionToken.trim()
          : typeof ir.token === "string" && ir.token.trim().length > 0
            ? ir.token.trim()
            : null;
      const issuedExpiresAt =
        typeof ir.sessionExpiresAt === "string" && ir.sessionExpiresAt.trim().length > 0
          ? ir.sessionExpiresAt.trim()
          : typeof ir.expiresAt === "string" && ir.expiresAt.trim().length > 0
            ? ir.expiresAt.trim()
            : null;
      if (issuedToken) {
        await setBotTokenState({
          token: issuedToken,
          expiresAt: issuedExpiresAt,
        });
        await this.ctx.memory.recordWrite({
          type: "bot_token_mint_reissued_from_already_connected",
          reason,
          at: nowIso(),
          expiresAt: issuedExpiresAt,
        });
        return { token: issuedToken, alreadyConnected: true };
      }
      await this.ctx.memory.recordWrite({
        type: "bot_token_mint_skipped_already_connected",
        reason,
        at: nowIso(),
      });
      return { token: (await getBotToken()) ?? "", alreadyConnected: true };
    }
    const io = isRecord(issued) ? issued : null;
    const tok = (io && typeof io.sessionToken === "string" ? (io.sessionToken as string).trim()
      : io && typeof io.token === "string" ? (io.token as string).trim() : "") || null;
    if (!tok) throw new Error("realtime.mintBotToken returned no token.");
    const tokenExpiresAt =
      io && typeof io.sessionExpiresAt === "string" && io.sessionExpiresAt.trim().length > 0
        ? io.sessionExpiresAt.trim()
        : io && typeof io.expiresAt === "string" && io.expiresAt.trim().length > 0
          ? io.expiresAt.trim()
          : null;
    await setBotTokenState({ token: tok, expiresAt: tokenExpiresAt });
    return { token: tok, alreadyConnected: false };
  }

  // -- Single mint request -------------------------------------------------

  private async reqMint(
    cid: string | null,
    ans: string | null,
    pt: string | null,
    refresh: boolean,
    challengeInstruction: string | null,
  ): Promise<unknown> {
    if (!this.ctx.trpc) throw new Error("tRPC client not available.");
    const m = this.ctx.mint;
    const normAns = typeof ans === "string" ? normalizeChallengeAnswerForSubmit(ans, this.ctx.config.challengeAnswerMaxChars) : "";
    const hasVerifyPayload = Boolean(cid && normAns.length > 0);
    if (!hasVerifyPayload && !refresh) {
      const pending = this.getResumablePendingChallenge();
      if (pending) {
        await this.trace({
          type: "mint_request_guard_reuse_pending",
          challengeId: pending.challengeId,
          promptToken: pending.promptToken,
          attemptsRemaining: pending.attemptsRemaining,
          expiresAt: pending.expiresAt,
        });
        return this.toPendingChallengeIssued(pending);
      }
    }
    const input = (): Record<string, unknown> => ({
      tokenTtlSeconds: m.runtimeMintTokenTtlSeconds,
      ...(typeof m.runtimeMintMaxUses === "number" ? { maxUses: m.runtimeMintMaxUses } : {}),
      ...(cid && normAns ? { challengeId: cid, answer: normAns } : {}),
      ...(cid && normAns && pt ? { promptToken: pt } : {}),
      ...(refresh ? { refreshChallenge: true } : {}),
      attestation: this.ctx.getRuntimeAttestation(this.ctx.config.connectionId),
    });
    const serial = ++m.mintAttemptSerial;
    await this.trace({
      type: "mint_request",
      requestSerial: serial,
      challengeId: cid,
      hasAnswer: normAns.length > 0,
      answerLength: normAns.length,
      hasPromptToken:
        Boolean(cid && normAns.length > 0 && typeof pt === "string" && pt.trim().length > 0),
      refreshChallenge: refresh,
    });
    try {
      const res = await this.ctx.runBackendCall("realtime.mintBotToken.mutate", () => this.ctx.trpc!.realtime.mintBotToken.mutate(input()));
      this.ctx.markWsActivity("mint_response");
      await this.trace({ type: "mint_response", requestSerial: serial, challengeRequired: Boolean(isRecord(res) && res.challengeRequired) });
      return res;
    } catch (error: unknown) {
      const msg = errMsg(error);
      // TTL clamping retry.
      const ttlMatch = /tokenTtlSeconds must be <=\s*(\d+)/iu.exec(msg);
      if (ttlMatch) {
        const max = Number.parseInt(ttlMatch[1] ?? "", 10);
        if (Number.isFinite(max) && max >= 10) {
          m.runtimeMintTokenTtlSeconds = max;
          const r = await this.ctx.runBackendCall("realtime.mintBotToken.mutate", () => this.ctx.trpc!.realtime.mintBotToken.mutate(input()));
          this.ctx.markWsActivity("mint_response_retry");
          return r;
        }
      }
      // MaxUses rejection retry.
      if (typeof m.runtimeMintMaxUses === "number" && /maxUses must be <=/iu.test(msg)) {
        m.runtimeMintMaxUses = null;
        const r = await this.ctx.runBackendCall("realtime.mintBotToken.mutate", () => this.ctx.trpc!.realtime.mintBotToken.mutate(input()));
        this.ctx.markWsActivity("mint_response_retry");
        return r;
      }
      // Challenge retry required.
      const retry = cid && normAns && parseMintChallengeRetryRequired(msg);
      if (retry) {
        return {
          challengeRequired: true,
          challengeId: cid,
          promptToken: pt ?? null,
          attemptsRemaining: retry.attemptsRemaining,
          retryRequired: true,
          instruction: challengeInstruction ?? "Solve mint challenge",
        };
      }
      throw error;
    }
  }

  // -- Helpers -------------------------------------------------------------

  private needsManualRetry(e: unknown): boolean {
    const m = errMsg(e);
    if (parseMintChallengeRetryRequired(m)) return false;
    if (/competing bot tunnel rejected/iu.test(m) || /another tunnel for this bot is already active/iu.test(m)) return true;
    return /\bRun `mint retry`\b/iu.test(m) || /Mint challenge expired before answer entry/iu.test(m)
      || /Socket mint challenge required\./iu.test(m) || /Mint challenge missing challengeId/iu.test(m)
      || /Mint challenge solver failed repeatedly/iu.test(m)
      || /Mint challenge flow exceeded guard limit/iu.test(m)
      || /Mint challenge answer unavailable from OpenClaw/iu.test(m);
  }

  private chalCtx(): ChallengeContext {
    return {
      config: {
        challengeAnswerMaxChars: this.ctx.config.challengeAnswerMaxChars,
        mintChallengeUseOpenClaw: this.ctx.config.mintChallengeUseOpenClaw,
      },
      memory: this.ctx.memory,
      appendMintTrace: (e: unknown) => this.trace(e),
      ...(this.ctx.runUtilAgentPrompt
        ? { runUtilAgentPrompt: this.ctx.runUtilAgentPrompt }
        : {}),
    };
  }

  private async writeDbg(): Promise<void> {
    this.dbg.updatedAt = nowIso();
    this.dbg.pendingChallengeId = this.pendingChallenge?.challengeId ?? null;
    this.dbg.pendingPromptToken = this.pendingChallenge?.promptToken ?? null;
    this.dbg.pendingChallengeExpiresAt = this.pendingChallenge?.expiresAt ?? null;
    this.dbg.pendingChallengeInstruction = this.pendingChallenge?.instruction ?? null;
    this.dbg.pendingChallengeAnswerType = this.pendingChallenge?.answerType ?? null;
    this.dbg.pendingChallengeAttemptsRemaining = this.pendingChallenge?.attemptsRemaining ?? null;
    this.dbg.pendingChallengeSolverFailures = this.pendingChallenge?.solverFailures ?? 0;
    await fs.writeFile(this.ctx.ipcPaths.mintDebugPath, JSON.stringify(this.dbg, null, 2), "utf8").catch(() => {});
  }

  private capturePendingChallenge(input: {
    challengeId: string | null;
    promptToken: string | null;
    instruction: string;
    answerType: string | null;
    attemptsRemaining: number | null;
    expiresAt: string | null;
  }): void {
    if (!input.challengeId) return;
    const previous = this.pendingChallenge;
    const expiresAtTrimmed =
      typeof input.expiresAt === "string" && input.expiresAt.trim().length > 0
        ? input.expiresAt.trim()
        : null;
    const parsedExpiresAtMs =
      expiresAtTrimmed && Number.isFinite(Date.parse(expiresAtTrimmed))
        ? Date.parse(expiresAtTrimmed)
        : null;
    this.pendingChallenge = {
      challengeId: input.challengeId,
      promptToken: input.promptToken,
      instruction: input.instruction,
      answerType: input.answerType,
      attemptsRemaining: input.attemptsRemaining,
      expiresAt: expiresAtTrimmed,
      expiresAtMs: parsedExpiresAtMs,
      solverFailures:
        previous && previous.challengeId === input.challengeId
          ? previous.solverFailures
          : 0,
    };
  }

  private clearPendingChallenge(): void {
    this.pendingChallenge = null;
  }

  private getResumablePendingChallenge(): PendingMintChallenge | null {
    const pending = this.pendingChallenge;
    if (!pending) return null;
    if (
      pending.expiresAtMs !== null &&
      Date.now() >= pending.expiresAtMs - MINT_PENDING_CHALLENGE_EXPIRY_SKEW_MS
    ) {
      this.pendingChallenge = null;
      return null;
    }
    if (pending.attemptsRemaining !== null && pending.attemptsRemaining <= 0) {
      this.pendingChallenge = null;
      return null;
    }
    return pending;
  }

  private toPendingChallengeIssued(
    pending: PendingMintChallenge,
  ): Record<string, unknown> {
    return {
      challengeRequired: true,
      challengeId: pending.challengeId,
      promptToken: pending.promptToken,
      instruction: pending.instruction,
      attemptsRemaining: pending.attemptsRemaining,
      expiresAt: pending.expiresAt,
      challenge: pending.answerType
        ? { answerType: pending.answerType }
        : undefined,
    };
  }

  private bumpPendingSolverFailure(challengeId: string | null): number {
    if (!challengeId || !this.pendingChallenge) return 0;
    if (this.pendingChallenge.challengeId !== challengeId) return 0;
    this.pendingChallenge.solverFailures += 1;
    return this.pendingChallenge.solverFailures;
  }

  private resetPendingSolverFailure(challengeId: string | null): void {
    if (!challengeId || !this.pendingChallenge) return;
    if (this.pendingChallenge.challengeId !== challengeId) return;
    this.pendingChallenge.solverFailures = 0;
  }

  private async restorePendingChallengeFromDebug(): Promise<void> {
    const raw = await fs.readFile(this.ctx.ipcPaths.mintDebugPath, "utf8").catch(() => null);
    if (!raw || !raw.trim().length) return;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const challengeId =
      typeof parsed.pendingChallengeId === "string" && parsed.pendingChallengeId.trim().length > 0
        ? parsed.pendingChallengeId.trim()
        : null;
    if (!challengeId) return;
    const instruction =
      typeof parsed.pendingChallengeInstruction === "string" &&
      parsed.pendingChallengeInstruction.trim().length > 0
        ? parsed.pendingChallengeInstruction.trim()
        : null;
    if (!instruction) return;
    const promptToken =
      typeof parsed.pendingPromptToken === "string" && parsed.pendingPromptToken.trim().length > 0
        ? parsed.pendingPromptToken.trim()
        : null;
    const answerType =
      typeof parsed.pendingChallengeAnswerType === "string" &&
      parsed.pendingChallengeAnswerType.trim().length > 0
        ? parsed.pendingChallengeAnswerType.trim()
        : null;
    const attemptsRemaining =
      typeof parsed.pendingChallengeAttemptsRemaining === "number" &&
      Number.isFinite(parsed.pendingChallengeAttemptsRemaining)
        ? Math.max(0, Math.floor(parsed.pendingChallengeAttemptsRemaining))
        : null;
    const expiresAt =
      typeof parsed.pendingChallengeExpiresAt === "string" &&
      parsed.pendingChallengeExpiresAt.trim().length > 0
        ? parsed.pendingChallengeExpiresAt.trim()
        : null;
    const expiresAtMs =
      expiresAt && Number.isFinite(Date.parse(expiresAt))
        ? Date.parse(expiresAt)
        : null;
    if (
      expiresAtMs !== null &&
      Date.now() >= expiresAtMs - MINT_PENDING_CHALLENGE_EXPIRY_SKEW_MS
    ) {
      return;
    }
    const solverFailures =
      typeof parsed.pendingChallengeSolverFailures === "number" &&
      Number.isFinite(parsed.pendingChallengeSolverFailures)
        ? Math.max(0, Math.floor(parsed.pendingChallengeSolverFailures))
        : 0;
    this.pendingChallenge = {
      challengeId,
      promptToken,
      instruction,
      answerType,
      attemptsRemaining,
      expiresAt,
      expiresAtMs,
      solverFailures,
    };
    await this.trace({
      type: "mint_challenge_restored_from_debug",
      challengeId,
      promptToken,
      attemptsRemaining,
      expiresAt,
      solverFailures,
    });
  }

  private async trace(payload: unknown): Promise<void> {
    const entry = isRecord(payload) ? { at: nowIso(), ...payload } : { at: nowIso() };
    await appendJsonLine(this.ctx.ipcPaths.mintTracePath, entry).catch(() => {});
  }
}
