/**
 * Challenge resolution utilities for OpenClaw solving,
 * challenge type detection, and answer normalization.
 *
 * Ported from agent-runtime.mjs lines 273-283, 1111-1128,
 * 1156-1170, and 8781-8858.
 */

import { nowIso, sanitizeChallengeAnswerText, toAnswerPreview } from "../lib/text.js";
import { isRecord } from "../lib/guards.js";

// ---------------------------------------------------------------------------
// Narrow context
// ---------------------------------------------------------------------------

export interface ChallengeContext {
  config: {
    challengeAnswerMaxChars: number;
    mintChallengeUseOpenClaw: boolean;
  };
  memory: { recordWrite(payload: unknown): Promise<void> };
  appendMintTrace(entry: unknown): Promise<void>;
  runOpenClawPrompt?(input: { prompt: string; purpose: string }): Promise<{
    parsed: unknown;
    payloadText?: string | null;
    raw?: string | null;
  } | null>;
  parseChatOpenClawReply?(response: unknown): string;
}

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const NO_LOOKUP = "Do not use web_search or external lookup tools; answer from internal trained knowledge only.";

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
    "- Do not ask follow-up questions.",
    "- Do not explain your reasoning.",
    "- If uncertain, return your single best short answer immediately.",
    '- Return JSON only: {"answer":"<challenge answer>"}', "",
    `challengeId=${params.challengeId}`, `questionToken=${qt}`,
    `attempt=${params.attemptsUsed + 1}`, `instruction=${params.instruction}`,
  ].join("\n");
  const res = await ctx.runOpenClawPrompt({ prompt, purpose: "mint_challenge" });
  const parsed = isRecord(res?.parsed) ? res.parsed : null;
  const parsedAnswer =
    typeof parsed?.answer === "string" && (parsed.answer as string).trim().length > 0
      ? (parsed.answer as string).trim()
      : "";
  const parsedReply =
    typeof parsed?.reply === "string" && (parsed.reply as string).trim().length > 0
      ? (parsed.reply as string).trim()
      : "";
  const parsedText =
    typeof parsed?.text === "string" && (parsed.text as string).trim().length > 0
      ? (parsed.text as string).trim()
      : "";
  const payloadText =
    typeof res?.payloadText === "string" && res.payloadText.trim().length > 0
      ? res.payloadText.trim()
      : "";
  const rawText =
    typeof res?.raw === "string" && res.raw.trim().length > 0
      ? res.raw.trim()
      : "";
  const callbackText = ctx.parseChatOpenClawReply ? ctx.parseChatOpenClawReply(res) : "";
  const raw =
    parsedAnswer ||
    callbackText ||
    parsedReply ||
    parsedText ||
    payloadText ||
    rawText;
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
