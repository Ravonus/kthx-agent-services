/**
 * Challenge resolution: file-based answers, OpenClaw solving,
 * challenge type detection, and multiple-choice rejection.
 *
 * Ported from agent-runtime.mjs lines 273-283, 1111-1128,
 * 1156-1170, 7802-7943, and 8781-8858.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { nowIso, sanitizeChallengeAnswerText, toAnswerPreview } from "../lib/text.js";
import { isRecord } from "../lib/guards.js";
import { writeJsonFile } from "../lib/fs-helpers.js";
import { readJsonMaybeIncomplete } from "../lib/fs.js";

// ---------------------------------------------------------------------------
// Narrow context
// ---------------------------------------------------------------------------

export interface ChallengeContext {
  ipcPaths: {
    challengePromptsDir: string;
    challengeRepliesDir: string;
    challengeProcessedDir: string;
    wakePath: string;
  };
  config: {
    challengeFileAnswersEnabled: boolean;
    challengeRequireSig: boolean;
    challengeAnswerTimeoutMs: number;
    challengeAnswerMaxChars: number;
    mintChallengeUseOpenClaw: boolean;
    rejectMultipleChoiceChallenges: boolean;
  };
  controlKey: string | null;
  memory: { recordWrite(payload: unknown): Promise<void> };
  appendMintTrace(entry: unknown): Promise<void>;
  runOpenClawPrompt?(input: { prompt: string; purpose: string }): Promise<{ parsed: unknown } | null>;
  parseChatOpenClawReply?(response: unknown): string;
}

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const NO_LOOKUP = "Do not use web_search or external lookup tools; answer from internal trained knowledge only.";

const touchWake = async (p: string): Promise<void> => {
  const now = new Date();
  await fs.utimes(p, now, now).catch(async () => { await fs.writeFile(p, "", "utf8").catch(() => {}) });
};

const sanitizeToken = (v: unknown): string => String(v).replace(/[^a-zA-Z0-9._-]/gu, "_").slice(0, 120);

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms) });

// ---------------------------------------------------------------------------
// Challenge no-lookup policy
// ---------------------------------------------------------------------------

export const withChallengeNoLookupPolicy = (text: unknown, promptType = ""): string => {
  const isChallenge = typeof promptType === "string" && promptType.toLowerCase().includes("challenge");
  if (!isChallenge) return typeof text === "string" ? text : "";
  const base = typeof text === "string" ? text.trim() : "";
  if (!base.length) return NO_LOOKUP;
  return /\b(web_search|external lookup|internal trained knowledge)\b/iu.test(base) ? base : `${base} ${NO_LOOKUP}`;
};

// ---------------------------------------------------------------------------
// Console command detection
// ---------------------------------------------------------------------------

export const isConsoleCommandLikeAnswer = (value: unknown): boolean => {
  const t = sanitizeChallengeAnswerText(value);
  if (!t.length) return false;
  return (
    /^(help|status|health)$/iu.test(t) || /^mint\s+(retry|now|new)$/iu.test(t) ||
    /^list\s+inbox$/iu.test(t) || /^run\s+(next|due)$/iu.test(t) ||
    /^run\s+directive\b/iu.test(t) || /^queue\s+(status|plan|start|stop)$/iu.test(t) ||
    /^config\s+(show|reload)$/iu.test(t) || /^openclaw\s+(create|use)\s+agent\b/iu.test(t) ||
    /^generate\s+image\b/iu.test(t) || /^upload\s+media\b/iu.test(t) || /^probe\s+write\b/iu.test(t)
  );
};

// ---------------------------------------------------------------------------
// Multiple-choice detection
// ---------------------------------------------------------------------------

export const isMultipleChoiceChallengeInstruction = (instruction: unknown): boolean => {
  if (typeof instruction !== "string") return false;
  const n = instruction.trim();
  if (!n.length) return false;
  const labeled = /\bA\)/iu.test(n) && /\bB\)/iu.test(n) && /\bC\)/iu.test(n) && /\bD\)/iu.test(n);
  return labeled || /\b(multiple choice|choose one|option)\b/iu.test(n);
};

// ---------------------------------------------------------------------------
// Answer normalization
// ---------------------------------------------------------------------------

export const normalizeChallengeAnswerForSubmit = (value: unknown, maxChars: number): string => {
  const raw = sanitizeChallengeAnswerText(value);
  if (!raw.length || raw.length <= maxChars) return raw;
  const clipped = raw.slice(0, maxChars).trim();
  const wordTrim = clipped.replace(/\s+\S*$/u, "").trim();
  return wordTrim.length >= Math.floor(maxChars * 0.6) ? wordTrim : clipped;
};

// ---------------------------------------------------------------------------
// parseMintChallengeRetryRequired
// ---------------------------------------------------------------------------

export type MintChallengeRetryInfo = { attemptsRemaining: number | null };

export const parseMintChallengeRetryRequired = (message: unknown): MintChallengeRetryInfo | null => {
  if (typeof message !== "string" || !message.trim().length) return null;
  const m = /Mint challenge answer incorrect\.\s*Request retry explicitly before next attempt\.\s*attemptsRemaining=(\d+)\.?/iu.exec(message);
  if (!m) return null;
  const n = Number.parseInt(m[1] ?? "", 10);
  return { attemptsRemaining: Number.isFinite(n) && n >= 0 ? n : null };
};

// ---------------------------------------------------------------------------
// File-based challenge answer contract
// ---------------------------------------------------------------------------

export type ChallengeContract = {
  token: string; promptPath: string; replyPath: string;
  issuedAtIso: string; expiresAtIso: string;
};

export const createChallengeAnswerFileContract = async (
  ctx: ChallengeContext,
  params: { promptType: string; challengeId: string | null; instruction: string },
): Promise<ChallengeContract | null> => {
  if (!ctx.config.challengeFileAnswersEnabled) return null;
  const issuedAt = nowIso();
  const expiresAt = new Date(Date.now() + ctx.config.challengeAnswerTimeoutMs).toISOString();
  const token = crypto.randomUUID();
  const base = `${Date.now()}__${sanitizeToken(params.promptType)}__${sanitizeToken(params.challengeId ?? "none")}__${token}`;
  const promptPath = path.join(ctx.ipcPaths.challengePromptsDir, `${base}.json`);
  const replyPath = path.join(ctx.ipcPaths.challengeRepliesDir, `${base}.json`);
  const instr = withChallengeNoLookupPolicy(params.instruction, params.promptType);
  await writeJsonFile(promptPath, {
    type: "challenge_answer_request", token, promptType: params.promptType,
    challengeId: params.challengeId ?? null, issuedAt, expiresAt, instruction: instr, replyPath,
    expectedReply: { token, answer: "<string>", ...(ctx.config.challengeRequireSig && ctx.controlKey ? { sig: "hex-hmac-sha256" } : {}) },
  });
  await touchWake(ctx.ipcPaths.wakePath);
  await ctx.memory.recordWrite({
    type: "challenge_answer_file_issued", at: issuedAt, promptType: params.promptType,
    challengeId: params.challengeId ?? null, token, promptPath, replyPath, expiresAt,
    requireSig: ctx.config.challengeRequireSig && Boolean(ctx.controlKey),
  });
  return { token, promptPath, replyPath, issuedAtIso: issuedAt, expiresAtIso: expiresAt };
};

// ---------------------------------------------------------------------------
// moveChallengeReplyToProcessed
// ---------------------------------------------------------------------------

const moveReply = async (dir: string, replyPath: string, status: string): Promise<string> => {
  const target = path.join(dir, `${sanitizeToken(path.basename(replyPath))}.${sanitizeToken(status)}.${Date.now()}.json`);
  await fs.rename(replyPath, target).catch(async () => { await fs.rm(replyPath, { force: true }).catch(() => {}) });
  return target;
};

// ---------------------------------------------------------------------------
// waitForChallengeAnswerFromFile
// ---------------------------------------------------------------------------

export const waitForChallengeAnswerFromFile = async (
  ctx: ChallengeContext,
  params: { promptType: string; challengeId: string | null; instruction: string; rejectConsoleCommandLike: boolean },
): Promise<string | null> => {
  const contract = await createChallengeAnswerFileContract(ctx, params);
  if (!contract) return null;
  const deadline = Date.now() + ctx.config.challengeAnswerTimeoutMs;
  while (Date.now() < deadline) {
    const read = await readJsonMaybeIncomplete(contract.replyPath);
    if (read.status === "ok") {
      const p = isRecord(read.value) ? read.value : null;
      const tok = typeof p?.token === "string" ? (p.token as string).trim() : "";
      const rawAns = typeof p?.answer === "string" ? (p.answer as string) : "";
      const ans = sanitizeChallengeAnswerText(rawAns);
      if (tok !== contract.token || !ans.length) {
        const ip = await moveReply(ctx.ipcPaths.challengeProcessedDir, contract.replyPath, "invalid");
        await ctx.memory.recordWrite({ type: "challenge_answer_file_rejected", at: nowIso(), promptType: params.promptType, challengeId: params.challengeId ?? null, reason: tok !== contract.token ? "token_mismatch" : "missing_answer", path: ip, answerPreview: toAnswerPreview(rawAns) });
        await sleep(500); continue;
      }
      if (params.rejectConsoleCommandLike && isConsoleCommandLikeAnswer(ans)) {
        const rp = await moveReply(ctx.ipcPaths.challengeProcessedDir, contract.replyPath, "rejected_command");
        await ctx.memory.recordWrite({ type: "challenge_answer_file_rejected", at: nowIso(), promptType: params.promptType, challengeId: params.challengeId ?? null, reason: "console_command", path: rp, answerPreview: toAnswerPreview(ans) });
        await sleep(500); continue;
      }
      await moveReply(ctx.ipcPaths.challengeProcessedDir, contract.replyPath, "accepted");
      return ans;
    }
    await sleep(500);
  }
  return null;
};

// ---------------------------------------------------------------------------
// answerChallengeWithOpenClaw
// ---------------------------------------------------------------------------

export const answerChallengeWithOpenClaw = async (
  ctx: ChallengeContext,
  params: { challengeId: string; promptToken: string | null; instruction: string; attemptsUsed: number },
): Promise<string | null> => {
  if (!ctx.config.mintChallengeUseOpenClaw || !ctx.runOpenClawPrompt) return null;
  const qt = typeof params.promptToken === "string" && params.promptToken.trim().length > 0 ? params.promptToken.trim() : "n/a";
  const prompt = [
    "You are solving a Molkgram bot-session mint challenge.", "Rules:",
    "- Solve from provided prompt text only.", "- No web lookup, browsing, or external tool use.",
    `- Return answer with at most ${ctx.config.challengeAnswerMaxChars} characters.`,
    '- Return JSON only: {"answer":"<challenge answer>"}', "",
    `challengeId=${params.challengeId}`, `questionToken=${qt}`,
    `attempt=${params.attemptsUsed + 1}`, `instruction=${params.instruction}`,
  ].join("\n");
  const res = await ctx.runOpenClawPrompt({ prompt, purpose: "mint_challenge" });
  const parsed = isRecord(res?.parsed) ? res.parsed : null;
  const raw = typeof parsed?.answer === "string" && (parsed.answer as string).trim().length > 0
    ? (parsed.answer as string).trim()
    : ctx.parseChatOpenClawReply ? ctx.parseChatOpenClawReply(res) : "";
  const norm = normalizeChallengeAnswerForSubmit(raw, ctx.config.challengeAnswerMaxChars);
  if (!norm.length || isConsoleCommandLikeAnswer(norm)) {
    await ctx.appendMintTrace({ type: "mint_answer_openclaw_unusable", challengeId: params.challengeId, promptToken: params.promptToken ?? null, answerPreview: toAnswerPreview(raw) });
    await ctx.memory.recordWrite({ type: "bot_token_mint_challenge_openclaw_unusable", at: nowIso(), challengeId: params.challengeId, answerPreview: toAnswerPreview(raw) });
    return null;
  }
  await ctx.appendMintTrace({ type: "mint_answer_openclaw_generated", challengeId: params.challengeId, promptToken: params.promptToken ?? null, answerPreview: toAnswerPreview(norm) });
  await ctx.memory.recordWrite({ type: "bot_token_mint_challenge_openclaw_generated", at: nowIso(), challengeId: params.challengeId, answerPreview: toAnswerPreview(norm) });
  return norm;
};
