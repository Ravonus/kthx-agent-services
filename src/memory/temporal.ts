/**
 * Temporal context system: default state, tier summarization, refresh.
 *
 * Ported from agent-runtime.mjs lines 1290-1327, 1437-1460, 1547-1565,
 * and 2074-2348.
 */

import type {
  TemporalContext,
  TierSummary,
  TierRankedEntry,
  TierRankedPost,
  MemoryEnvelope,
  ExtractedKeys,
} from "~/types/memory.js";
import { isRecord } from "~/lib/guards.js";
import { unique } from "~/lib/time.js";
import { nowIso, toShortLine } from "~/lib/text.js";
import {
  extractKeysFromPayload,
  extractActorHintFromPayload,
  extractTextHintFromPayload,
} from "./extract.js";

// ---------------------------------------------------------------------------
// defaultTemporalContext
// ---------------------------------------------------------------------------

export const defaultTemporalContext = (): TemporalContext => ({
  version: 1,
  updatedAt: new Date(0).toISOString(),
  algorithmVersion: 1,
  tiers: {
    "24h": null,
    "7d": null,
    "30d": null,
    "365d": null,
  },
});

// ---------------------------------------------------------------------------
// rankCountMap
// ---------------------------------------------------------------------------

export const rankCountMap = (
  mapLike: Map<string, number>,
  limit = 5,
): Array<[string, number]> =>
  Array.from(mapLike.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    })
    .slice(0, limit);

// ---------------------------------------------------------------------------
// eventSignature / uniqueEventsBySignature
// ---------------------------------------------------------------------------

export const eventSignature = (event: unknown): string => {
  if (!isRecord(event)) return "";
  const keys = extractKeysFromPayload(event.payload);
  const type = keys.type ?? "event";
  const postToken =
    typeof keys.postId === "number" ? String(keys.postId) : "";
  const commentToken =
    typeof keys.commentId === "number" ? String(keys.commentId) : "";
  const sourceToken =
    typeof event.source === "string" ? event.source : "unknown";
  const topicToken =
    typeof event.topic === "string" ? event.topic : "unknown";
  const timeToken =
    typeof event.receivedAt === "string" ? event.receivedAt : "";
  return `${timeToken}|${sourceToken}|${topicToken}|${type}|${postToken}|${commentToken}`;
};

export const uniqueEventsBySignature = (
  events: MemoryEnvelope[],
): MemoryEnvelope[] => {
  const out: MemoryEnvelope[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const signature = eventSignature(event);
    if (!signature.length) continue;
    if (seen.has(signature)) continue;
    seen.add(signature);
    out.push(event);
  }
  return out;
};

// ---------------------------------------------------------------------------
// summarizeEventsForTier
// ---------------------------------------------------------------------------

export const summarizeEventsForTier = ({
  tier,
  label,
  events,
  maxBullets,
}: {
  tier: string;
  label: string;
  events: MemoryEnvelope[];
  maxBullets: number;
}): TierSummary => {
  const safeEvents = Array.isArray(events) ? events : [];
  const eventCount = safeEvents.length;
  const typeCounts = new Map<string, number>();
  const postCounts = new Map<string, number>();
  const actorCounts = new Map<string, number>();
  const freshHighlights: string[] = [];

  for (const event of safeEvents) {
    const keys = extractKeysFromPayload(event.payload);
    const type = keys.type ?? "event";
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    if (typeof keys.postId === "number") {
      const pid = String(keys.postId);
      postCounts.set(pid, (postCounts.get(pid) ?? 0) + 1);
    }
    const actor = extractActorHintFromPayload(event.payload);
    if (actor) actorCounts.set(actor, (actorCounts.get(actor) ?? 0) + 1);
    const textHint = extractTextHintFromPayload(event.payload);
    if (textHint) freshHighlights.push(textHint);
  }

  const topTypes = rankCountMap(typeCounts, 5);
  const topPosts = rankCountMap(postCounts, 5);
  const topActors = rankCountMap(actorCounts, 5);

  const bulletLimit = Math.max(4, Math.min(30, Math.floor(maxBullets)));
  const bullets: string[] = [];
  bullets.push(`${eventCount} events in ${label}.`);
  if (topTypes.length) {
    bullets.push(
      `Dominant activity: ${topTypes.map(([name, count]) => `${name} (${count})`).join(", ")}.`,
    );
  }
  if (topPosts.length) {
    bullets.push(
      `Most active posts: ${topPosts.map(([id, count]) => `#${id} (${count})`).join(", ")}.`,
    );
  }
  if (topActors.length) {
    bullets.push(
      `Most relevant people: ${topActors.map(([name, count]) => `${name} (${count})`).join(", ")}.`,
    );
  }
  freshHighlights
    .slice(-Math.max(1, bulletLimit - bullets.length))
    .forEach((line) => bullets.push(`Signal: ${toShortLine(line, 120)}.`));

  const normalizedBullets = unique(
    bullets
      .map((line) => toShortLine(line, 150))
      .filter((line) => line.length > 0),
  ).slice(0, bulletLimit);

  return {
    version: 1,
    tier,
    updatedAt: nowIso(),
    windowLabel: label,
    eventCount,
    topTypes: topTypes.map(
      ([name, count]): TierRankedEntry => ({ name, count }),
    ),
    topPosts: topPosts.map(
      ([id, count]): TierRankedPost => ({ id: Number(id), count }),
    ),
    topActors: topActors.map(
      ([name, count]): TierRankedEntry => ({ name, count }),
    ),
    bullets: normalizedBullets,
    algorithmBullets: normalizedBullets,
    compressedBy: "algorithm",
  };
};

// ---------------------------------------------------------------------------
// summarizeTargetFocus
// ---------------------------------------------------------------------------

export const summarizeTargetFocus = ({
  request,
  targetEvents,
}: {
  request: { postId?: number; commentId?: number };
  targetEvents: MemoryEnvelope[];
}): { counterparties: TierRankedEntry[]; bullets: string[] } => {
  const events = Array.isArray(targetEvents) ? targetEvents : [];
  if (events.length === 0) {
    return { counterparties: [], bullets: [] };
  }

  const actorCounts = new Map<string, number>();
  const typeCounts = new Map<string, number>();
  const textHints: string[] = [];

  for (const event of events) {
    const actor = extractActorHintFromPayload(event.payload);
    if (actor) actorCounts.set(actor, (actorCounts.get(actor) ?? 0) + 1);
    const keys = extractKeysFromPayload(event.payload);
    const type = keys.type ?? "event";
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    const textHint = extractTextHintFromPayload(event.payload);
    if (textHint) textHints.push(textHint);
  }

  const counterparties = rankCountMap(actorCounts, 4).map(
    ([name, count]): TierRankedEntry => ({ name, count }),
  );
  const typeSummary = rankCountMap(typeCounts, 4).map(
    ([name, count]) => `${name} (${count})`,
  );

  const bullets: string[] = [];
  if (typeof request.postId === "number") {
    bullets.push(
      `Target thread/post #${request.postId} has ${events.length} related events in memory.`,
    );
  }
  if (counterparties.length) {
    bullets.push(
      `Primary counterparties: ${counterparties.map((item) => `${item.name} (${item.count})`).join(", ")}.`,
    );
  }
  if (typeSummary.length) {
    bullets.push(`Relevant event mix: ${typeSummary.join(", ")}.`);
  }
  textHints
    .slice(-3)
    .forEach((line) =>
      bullets.push(`Recent target signal: ${toShortLine(line, 120)}.`),
    );

  return {
    counterparties,
    bullets: unique(
      bullets
        .map((line) => toShortLine(line, 150))
        .filter((line) => line.length > 0),
    ).slice(0, 6),
  };
};
