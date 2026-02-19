/**
 * MintManager: full bot-token mint lifecycle.
 *
 * Handles: request grant -> receive challenge -> solve -> confirm.
 * Includes retry with exponential backoff, failure streak tracking,
 * manual retry gating, and OpenClaw integration.
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
  runOpenClawPrompt?(input: { prompt: string; purpose: string }): Promise<{ parsed: unknown } | null>;
  parseChatOpenClawReply?(response: unknown): string;
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

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === "string" ? e : "unknown error";

interface MintDebug {
  updatedAt: string; inFlight: boolean; reason: string | null;
  challengeId: string | null; promptToken: string | null;
  attemptSerial: number; attemptsInCurrentFlow: number;
  lastRequest: Record<string, unknown> | null;
  lastResponse: Record<string, unknown> | null;
  lastError: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// MintManager
// ---------------------------------------------------------------------------

export class MintManager implements MintManagerLike {
  private readonly ctx: MintManagerContext;
  private readonly dbg: MintDebug = {
    updatedAt: nowIso(), inFlight: false, reason: null,
    challengeId: null, promptToken: null, attemptSerial: 0,
    attemptsInCurrentFlow: 0, lastRequest: null, lastResponse: null, lastError: null,
  };

  constructor(ctx: MintManagerContext) { this.ctx = ctx }

  async initialize(): Promise<void> { await this.writeDbg() }

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
    let issued = await this.reqMint(null, null, null, fresh, null);
    if (fresh) await this.trace({ type: "mint_fresh_challenge_explicit", reason });
    let answered = 0;

    while (issued && (issued as Record<string, unknown>).challengeRequired) {
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
      const answer = await answerChallengeWithOpenClaw(chCtx, {
        challengeId: cid,
        promptToken: cpt,
        instruction: instrTok,
        attemptsUsed: answered,
      });
      if (!answer) throw new Error("Mint challenge answer is required from OpenClaw.");
      await this.trace({ type: "mint_answer_submitted", challengeId: cid, answerPreview: toAnswerPreview(answer) });
      answered += 1;
      issued = await this.reqMint(cid, answer, cpt, false, instr);
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
          throw new Error("Mint challenge attempts exhausted by server. Run `mint retry`.");
        }
        if (exhausted) throw new Error(`Mint challenge not accepted after ${answered} attempt${answered === 1 ? "" : "s"}. Run \`mint retry\`.`);
        if ((issued as Record<string, unknown>).retryRequired === true) {
          issued = await this.reqMint(null, null, null, true, null);
        }
      }
    }
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
    const input = (): Record<string, unknown> => ({
      tokenTtlSeconds: m.runtimeMintTokenTtlSeconds,
      ...(typeof m.runtimeMintMaxUses === "number" ? { maxUses: m.runtimeMintMaxUses } : {}),
      ...(cid && normAns ? { challengeId: cid, answer: normAns } : {}),
      ...(cid && normAns && pt ? { promptToken: pt } : {}),
      ...(refresh ? { refreshChallenge: true } : {}),
      attestation: this.ctx.getRuntimeAttestation(this.ctx.config.connectionId),
    });
    const serial = ++m.mintAttemptSerial;
    await this.trace({ type: "mint_request", requestSerial: serial, challengeId: cid, hasAnswer: normAns.length > 0, refreshChallenge: refresh });
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
      || /Socket mint challenge required\./iu.test(m) || /Mint challenge missing challengeId/iu.test(m);
  }

  private chalCtx(): ChallengeContext {
    return {
      config: this.ctx.config,
      memory: this.ctx.memory,
      appendMintTrace: (e: unknown) => this.trace(e),
      ...(this.ctx.runOpenClawPrompt ? { runOpenClawPrompt: this.ctx.runOpenClawPrompt } : {}),
      ...(this.ctx.parseChatOpenClawReply ? { parseChatOpenClawReply: this.ctx.parseChatOpenClawReply } : {}),
    };
  }

  private async writeDbg(): Promise<void> {
    this.dbg.updatedAt = nowIso();
    await fs.writeFile(this.ctx.ipcPaths.mintDebugPath, JSON.stringify(this.dbg, null, 2), "utf8").catch(() => {});
  }

  private async trace(payload: unknown): Promise<void> {
    const entry = isRecord(payload) ? { at: nowIso(), ...payload } : { at: nowIso() };
    await appendJsonLine(this.ctx.ipcPaths.mintTracePath, entry).catch(() => {});
  }
}
