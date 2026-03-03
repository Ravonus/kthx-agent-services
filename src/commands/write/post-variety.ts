/** Post variety mode selection and history tracking helpers. */

import type {
  PostVarietyMode,
  PostDraftContext,
  RecentPostVarietyModeEntry,
} from "../types.js";

import { POST_VARIETY_MODES } from "../types.js";

import {
  asNonEmptyString,
  truncateText,
  normalizeCommentText,
} from "../helpers.js";

import {
  POST_VARIETY_HISTORY_WINDOW_MS,
  POST_VARIETY_HISTORY_MAX_ITEMS,
  POST_VARIETY_RECENT_COOLDOWN_COUNT,
  POST_VARIETY_HINT_PATTERNS,
} from "../constants.js";

import { pickDeterministicIndex } from "./post-visual.js";

// ---------------------------------------------------------------------------
// parsePostVarietyMode
// ---------------------------------------------------------------------------

export function parsePostVarietyMode(
  value: unknown,
): PostVarietyMode | null {
  const normalized = asNonEmptyString(value)?.toLowerCase() ?? null;
  if (!normalized) return null;
  if (normalized === "opinion") return "opinion";
  if (normalized === "reaction") return "reaction";
  if (
    normalized === "humor" ||
    normalized === "funny" ||
    normalized === "joke"
  ) {
    return "humor";
  }
  if (
    normalized === "micro" ||
    normalized === "short" ||
    normalized === "one-liner" ||
    normalized === "oneliner"
  ) {
    return "micro";
  }
  if (normalized === "narrative" || normalized === "story") return "narrative";
  return null;
}

// ---------------------------------------------------------------------------
// pruneRecentPostVarietyModeHistory
// ---------------------------------------------------------------------------

export function pruneRecentPostVarietyModeHistory(
  history: RecentPostVarietyModeEntry[],
  nowMs: number,
): void {
  let writeIndex = 0;
  for (const entry of history) {
    if (nowMs - entry.atMs > POST_VARIETY_HISTORY_WINDOW_MS) continue;
    history[writeIndex] = entry;
    writeIndex += 1;
  }
  history.length = writeIndex;
  if (history.length <= POST_VARIETY_HISTORY_MAX_ITEMS) return;
  const trimStart = history.length - POST_VARIETY_HISTORY_MAX_ITEMS;
  history.splice(0, trimStart);
}

// ---------------------------------------------------------------------------
// listRecentPostVarietyModes
// ---------------------------------------------------------------------------

export function listRecentPostVarietyModes(
  history: RecentPostVarietyModeEntry[],
  maxItems: number,
): PostVarietyMode[] {
  const nowMs = Date.now();
  pruneRecentPostVarietyModeHistory(history, nowMs);
  const modes: PostVarietyMode[] = [];
  const seen = new Set<PostVarietyMode>();
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (!entry) continue;
    if (seen.has(entry.mode)) continue;
    seen.add(entry.mode);
    modes.push(entry.mode);
    if (modes.length >= maxItems) break;
  }
  return modes;
}

// ---------------------------------------------------------------------------
// selectPostVarietyMode
// ---------------------------------------------------------------------------

export function selectPostVarietyMode(
  history: RecentPostVarietyModeEntry[],
  input: {
    commandId: string;
    postType: "text" | "media";
    payload: Record<string, unknown>;
    context: PostDraftContext;
    seedHints: string[];
  },
): {
  mode: PostVarietyMode;
  reason: string;
  recentModes: PostVarietyMode[];
  signal: string;
} {
  const recentModes = listRecentPostVarietyModes(
    history,
    POST_VARIETY_RECENT_COOLDOWN_COUNT + 2,
  );
  const blockedModes = new Set<PostVarietyMode>(
    recentModes.slice(0, POST_VARIETY_RECENT_COOLDOWN_COUNT),
  );
  const payloadMode =
    parsePostVarietyMode(input.payload.postVarietyMode) ??
    parsePostVarietyMode(input.payload.varietyMode) ??
    parsePostVarietyMode(input.payload.mode) ??
    null;
  const signalRaw = [
    asNonEmptyString(input.payload.requestText),
    asNonEmptyString(input.payload.topic),
    asNonEmptyString(input.payload.prompt),
    asNonEmptyString(input.payload.caption),
    asNonEmptyString(input.payload.textBody),
    input.context.payloadHint,
    input.context.postText,
    input.context.commentSummary,
    input.context.memorySummary,
    input.context.platformSignals,
    ...input.seedHints.slice(0, 8),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  const signal = truncateText(normalizeCommentText(signalRaw), 900);
  const availableModes = POST_VARIETY_MODES.filter(
    (mode) => !blockedModes.has(mode),
  );
  const chooseBySeed = (
    seedSuffix: string,
    candidates: readonly PostVarietyMode[],
  ): PostVarietyMode => {
    const target = candidates.length > 0 ? candidates : POST_VARIETY_MODES;
    if (target.length === 0) return "reaction";
    const selected =
      target[
        pickDeterministicIndex(
          `${input.commandId}:${input.postType}:${seedSuffix}:${signal}`,
          target.length,
        )
      ];
    return selected ?? target[0] ?? "reaction";
  };
  if (payloadMode) {
    const selected = blockedModes.has(payloadMode)
      ? chooseBySeed("payload_cooldown", availableModes)
      : payloadMode;
    return {
      mode: selected,
      reason: blockedModes.has(payloadMode)
        ? `payload_mode_cooldown:${payloadMode}`
        : "payload_mode",
      recentModes,
      signal,
    };
  }
  const scores: Record<PostVarietyMode, number> = {
    opinion: 0,
    reaction: 0,
    humor: 0,
    micro: 0,
    narrative: 0,
  };
  for (const hint of POST_VARIETY_HINT_PATTERNS) {
    if (!hint.pattern.test(signal)) continue;
    scores[hint.mode] += hint.weight;
  }
  if (input.context.platformSignals) {
    scores.reaction += 2;
  }
  if (input.context.targetPostId !== null) {
    scores.reaction += 1;
  }
  if (input.postType === "media") {
    scores.narrative += 1;
    scores.reaction += 1;
  } else {
    scores.opinion += 1;
    scores.micro += 1;
  }
  let topScore = Number.NEGATIVE_INFINITY;
  let candidates: PostVarietyMode[] = [];
  for (const mode of POST_VARIETY_MODES) {
    const score = scores[mode];
    if (score > topScore) {
      topScore = score;
      candidates = [mode];
    } else if (score === topScore) {
      candidates.push(mode);
    }
  }
  let selected =
    topScore > 0
      ? chooseBySeed("scored", candidates)
      : chooseBySeed("fallback", POST_VARIETY_MODES);
  if (blockedModes.has(selected) && availableModes.length > 0) {
    selected = chooseBySeed("cooldown_swap", availableModes);
  }
  return {
    mode: selected,
    reason: topScore > 0 ? `pattern_score:${topScore}` : "fallback_seeded",
    recentModes,
    signal,
  };
}

// ---------------------------------------------------------------------------
// notePublishedPostVarietyMode
// ---------------------------------------------------------------------------

export function notePublishedPostVarietyMode(
  history: RecentPostVarietyModeEntry[],
  input: {
    commandId: string;
    postType: "text" | "media";
    targetPostId: number | null;
    mode: PostVarietyMode;
    signal: string;
  },
): void {
  const normalizedSignal = truncateText(
    normalizeCommentText(input.signal),
    220,
  );
  const signalForHistory =
    normalizedSignal.length > 0 ? normalizedSignal : input.mode;
  const nowMs = Date.now();
  pruneRecentPostVarietyModeHistory(history, nowMs);
  history.push({
    atMs: nowMs,
    postType: input.postType,
    mode: input.mode,
    commandId: input.commandId,
    targetPostId: input.targetPostId,
    signal: signalForHistory,
  });
  pruneRecentPostVarietyModeHistory(history, nowMs);
}

// ---------------------------------------------------------------------------
// buildPostVarietyModeRules
// ---------------------------------------------------------------------------

export function buildPostVarietyModeRules(
  mode: PostVarietyMode,
  postType: "text" | "media",
): string[] {
  const common = [
    `Variety mode: ${mode}.`,
    "Avoid repeating moody/introspective template language unless context explicitly asks for it.",
  ];
  if (mode === "opinion") {
    return [
      ...common,
      "Take a clear position and include one concrete reason.",
      postType === "text"
        ? "textBody must contain an explicit stance."
        : "caption must state the stance and mediaPrompt should reinforce it visually.",
    ];
  }
  if (mode === "reaction") {
    return [
      ...common,
      "Anchor output to one concrete platform signal, trend, or recent post context.",
      postType === "text"
        ? "Reference a current signal in plain language."
        : "mediaPrompt must depict the live signal/reaction moment, not a generic scene.",
    ];
  }
  if (mode === "humor") {
    return [
      ...common,
      "Use a punchy, playful angle and keep it socially shareable.",
      postType === "text"
        ? "Land one clear joke/bit and avoid over-explaining."
        : "mediaPrompt should imply the comedic beat visually without meme-template boilerplate.",
    ];
  }
  if (mode === "micro") {
    return [
      ...common,
      "Keep it concise and high-signal.",
      postType === "text"
        ? "textBody should be short (prefer 25-110 chars) but complete."
        : "caption should be compact (prefer 10-80 chars) with a focused mediaPrompt.",
    ];
  }
  return [
    ...common,
    "Use narrative specificity: place, action, and one concrete sensory detail.",
    postType === "text"
      ? "textBody should read like a real moment, not abstract mood prose."
      : "mediaPrompt should portray a specific scene/event with concrete details.",
  ];
}
