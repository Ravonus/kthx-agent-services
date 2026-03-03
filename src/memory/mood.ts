/**
 * Mood system: default state, score derivation, signal application.
 *
 * Ported from agent-runtime.mjs lines 1537-1545 (defaultMoodState),
 * lines 1989-2072 (deriveMoodPrimary, deriveMoodSecondaries,
 * computeMoodDelta, applyMoodSignal).
 */

import type {
  MoodState,
  MoodDelta,
  MemoryEnvelope,
  ExtractedKeys,
} from "~/types/memory.js";
import { isRecord } from "~/lib/guards.js";
import { normalizeIso, clampNumber, unique } from "~/lib/time.js";
import { nowIso, toShortLine } from "~/lib/text.js";

// ---------------------------------------------------------------------------
// defaultMoodState
// ---------------------------------------------------------------------------

export const defaultMoodState = (): MoodState => ({
  version: 1,
  updatedAt: nowIso(),
  score: 0,
  volatility: 0,
  primary: "steady",
  secondary: ["focused"],
  recentSignals: [],
});

// ---------------------------------------------------------------------------
// deriveMoodPrimary
// ---------------------------------------------------------------------------

export const deriveMoodPrimary = (
  score: number,
  volatility: number,
): string => {
  if (score >= 5) return "energized";
  if (score >= 2) return volatility > 1.8 ? "stimulated" : "engaged";
  if (score <= -5) return "frustrated";
  if (score <= -2) return volatility > 1.8 ? "reactive" : "guarded";
  if (volatility >= 2) return "restless";
  return "steady";
};

// ---------------------------------------------------------------------------
// deriveMoodSecondaries
// ---------------------------------------------------------------------------

export const deriveMoodSecondaries = ({
  score,
  volatility,
  activityType,
}: {
  score: number;
  volatility: number;
  activityType: string;
}): string[] => {
  const labels: string[] = [];
  if (
    activityType === "comment" ||
    activityType === "like" ||
    activityType === "repost"
  ) {
    labels.push("social");
  }
  if (activityType === "read") labels.push("observant");
  if (activityType === "publish_result") labels.push("output-focused");
  if (activityType === "error") labels.push("cautious");
  if (volatility >= 2.5) labels.push("high-variance");
  if (Math.abs(score) < 1.25) labels.push("focused");
  return unique(labels).slice(0, 4);
};

// ---------------------------------------------------------------------------
// computeMoodDelta
// ---------------------------------------------------------------------------

export const computeMoodDelta = (
  envelope: MemoryEnvelope,
  keys: ExtractedKeys,
): MoodDelta => {
  const type = keys.type ?? "";
  const payload = isRecord(envelope.payload) ? envelope.payload : null;

  if (type === "post_comment")
    return { delta: 1.3, reason: "comment_interaction" };
  if (type === "post_like")
    return { delta: 0.7, reason: "like_interaction" };
  if (type === "post_repost")
    return { delta: 0.9, reason: "repost_interaction" };
  if (type === "post_view")
    return { delta: 0.2, reason: "reading_activity" };
  if (type === "post_created")
    return { delta: 0.8, reason: "post_created" };
  if (type === "publish_attempt_result") {
    const ok = payload?.ok === true;
    return ok
      ? { delta: 1.1, reason: "publish_success" }
      : { delta: -1.4, reason: "publish_failed" };
  }
  if (type === "intent_generation_empty")
    return { delta: -0.35, reason: "draft_empty" };
  if (type.endsWith("_failed") || type.includes("error")) {
    return { delta: -0.55, reason: "runtime_error" };
  }
  if (type === "directive_queue_executed")
    return { delta: 0.45, reason: "queue_progress" };
  if (type === "directive_staged_for_queue_execution") {
    return { delta: 0.15, reason: "queue_staged" };
  }
  return { delta: 0, reason: "neutral" };
};

// ---------------------------------------------------------------------------
// applyMoodSignal
// ---------------------------------------------------------------------------

export const applyMoodSignal = (
  moodState: MoodState,
  {
    delta,
    reason,
    at,
    activityType,
  }: {
    delta: number;
    reason: string;
    at: string;
    activityType: string;
  },
): MoodState => {
  const nextDelta = Number.isFinite(delta) ? delta : 0;
  const signalAt = normalizeIso(at);
  const prevUpdatedAtMs = Date.parse(moodState.updatedAt ?? "");
  const nowMs = Date.parse(signalAt);
  const elapsedHours =
    Number.isFinite(prevUpdatedAtMs) && Number.isFinite(nowMs)
      ? Math.max(0, (nowMs - prevUpdatedAtMs) / (1000 * 60 * 60))
      : 0;

  const decay = Math.exp(-elapsedHours / 72);
  const decayedScore =
    (Number.isFinite(moodState.score) ? moodState.score : 0) * decay;
  const score = clampNumber(decayedScore + nextDelta, -12, 12);

  const prevVolatility = Number.isFinite(moodState.volatility)
    ? moodState.volatility
    : 0;
  const volatility = clampNumber(
    prevVolatility * 0.84 + Math.abs(nextDelta) * 0.16,
    0,
    8,
  );

  const primary = deriveMoodPrimary(score, volatility);
  const secondary = deriveMoodSecondaries({
    score,
    volatility,
    activityType,
  });

  const recentSignals = Array.isArray(moodState.recentSignals)
    ? moodState.recentSignals.slice(-24)
    : [];
  recentSignals.push({
    at: signalAt,
    delta: Number.parseFloat(nextDelta.toFixed(3)),
    reason: toShortLine(reason, 60) || "neutral",
  });

  return {
    version: 1,
    updatedAt: signalAt,
    score: Number.parseFloat(score.toFixed(3)),
    volatility: Number.parseFloat(volatility.toFixed(3)),
    primary,
    secondary,
    recentSignals,
  };
};
