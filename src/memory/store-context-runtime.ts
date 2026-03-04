import fs from "node:fs/promises";
import path from "node:path";
import type {
  AgentCompressionRequest,
  ContextBundle,
  ContextRequest,
  MemoryEnvelope,
  MoodState,
  RefreshTemporalOptions,
  StreamName,
  StreamPathMap,
  TemporalContext,
  TierSummary,
} from "~/types/memory.js";
import { readJsonFile, readLastJsonLines } from "~/lib/fs-helpers.js";
import { isRecord } from "~/lib/guards.js";
import { nowIso, toShortLine } from "~/lib/text.js";
import { unique } from "~/lib/time.js";
import {
  findArchiveGzPath,
  listArchiveIndexes,
  pickWeightedArchiveBasenames,
  readEventsFromGzArchive,
} from "./archive.js";
import { extractKeysFromPayload, parseMemoryEnvelope } from "./extract.js";
import {
  defaultTemporalContext,
  summarizeEventsForTier,
  summarizeTargetFocus,
  uniqueEventsBySignature,
} from "./temporal.js";
import { safeTextMemory } from "./store-helpers.js";

export const readRecentEnvelopes = async (
  deps: {
    streamPaths: StreamPathMap;
    tailMaxBytes: number;
  },
  input: {
    maxLines: number;
  },
): Promise<MemoryEnvelope[]> => {
  const { streamPaths, tailMaxBytes } = deps;
  const { maxLines } = input;
  const streams: StreamName[] = [
    "notifications",
    "feed",
    "activity",
    "memory_activity",
    "likes",
    "reposts",
    "comments",
    "views",
    "director",
  ];
  const perStream = Math.max(30, Math.ceil(maxLines / streams.length));
  const reads = await Promise.all(
    streams.map(async (stream) => {
      const items = await readLastJsonLines({
        filePath: streamPaths[stream],
        maxLines: perStream,
        maxBytes: tailMaxBytes,
      });
      return items
        .map(parseMemoryEnvelope)
        .filter((env): env is MemoryEnvelope => Boolean(env));
    }),
  );
  const merged = reads.flat();
  merged.sort((a, b) =>
    a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0,
  );
  return merged;
};

export const readArchiveContext = async (
  deps: { stateDir: string },
  input: {
    request: ContextRequest;
    maxEvents: number;
    targetFilter: (env: MemoryEnvelope) => boolean;
  },
): Promise<MemoryEnvelope[]> => {
  const { stateDir } = deps;
  const { request, maxEvents, targetFilter } = input;
  if (maxEvents <= 0) return [];
  const streams: StreamName[] = ["feed", "activity", "memory_activity", "notifications"];
  const results: MemoryEnvelope[] = [];
  const wantTargeted =
    typeof request.postId === "number" || typeof request.commentId === "number";

  for (const stream of streams) {
    if (results.length >= maxEvents) break;
    const indexes = await listArchiveIndexes({ stateDir, stream });
    if (!indexes.length) continue;
    const picks = wantTargeted
      ? indexes
          .filter(
            (idx) =>
              (typeof request.postId === "number" && idx.postIds?.includes(request.postId)) ||
              (typeof request.commentId === "number" &&
                idx.commentIds?.includes(request.commentId)),
          )
          .slice(0, 4)
          .map((idx) => idx.archiveBasename)
      : pickWeightedArchiveBasenames(indexes, 2);
    for (const basename of picks) {
      if (results.length >= maxEvents) break;
      const gzPath = findArchiveGzPath({
        stateDir,
        stream,
        archiveBasename: basename,
      });
      const batch = await readEventsFromGzArchive({
        gzPath,
        filter: wantTargeted ? targetFilter : () => true,
        maxEvents: Math.min(maxEvents - results.length, 30),
      });
      results.push(...batch);
    }
  }
  results.sort((a, b) =>
    a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0,
  );
  return results.slice(-maxEvents);
};

export const readArchiveWindow = async (
  deps: { stateDir: string },
  input: {
    maxAgeDays: number;
    maxEvents: number;
    filter?: (env: MemoryEnvelope) => boolean;
  },
): Promise<MemoryEnvelope[]> => {
  const { stateDir } = deps;
  const { maxAgeDays, maxEvents, filter } = input;
  const safeMax = Math.max(0, Math.floor(maxEvents));
  if (safeMax <= 0) return [];
  const minMs = Date.now() - Math.max(1, Math.floor(maxAgeDays)) * 86_400_000;
  const scanStreams: StreamName[] = [
    "feed",
    "activity",
    "memory_activity",
    "notifications",
    "comments",
    "views",
  ];
  const out: MemoryEnvelope[] = [];
  for (const stream of scanStreams) {
    if (out.length >= safeMax) break;
    const indexes = await listArchiveIndexes({ stateDir, stream });
    for (const idx of indexes.slice(0, 16)) {
      if (out.length >= safeMax) break;
      const maxAtMs = idx.receivedAtMax ? Date.parse(idx.receivedAtMax) : NaN;
      if (!Number.isFinite(maxAtMs) || maxAtMs < minMs) continue;
      const batch = await readEventsFromGzArchive({
        gzPath: findArchiveGzPath({
          stateDir,
          stream,
          archiveBasename: idx.archiveBasename,
        }),
        filter: filter ?? ((e) => Date.parse(e.receivedAt) >= minMs),
        maxEvents: Math.min(safeMax - out.length, 120),
      });
      out.push(...batch);
    }
  }
  return uniqueEventsBySignature(out)
    .sort((a, b) =>
      a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0,
    )
    .slice(-safeMax);
};

export type BuildContextDeps = {
  stateDir: string;
  lastContextReadAtMs: number;
  setLastContextReadAtMs: (value: number) => void;
  getTemporalContext: () => TemporalContext;
  refreshTemporalContext: (options: RefreshTemporalOptions) => Promise<TemporalContext>;
  readRecentEnvelopes: (input: { maxLines: number }) => Promise<MemoryEnvelope[]>;
  readArchiveContext: (input: {
    request: ContextRequest;
    maxEvents: number;
    targetFilter: (env: MemoryEnvelope) => boolean;
  }) => Promise<MemoryEnvelope[]>;
  buildViewSummary: (request: ContextRequest) => ContextBundle["view"];
  buildRetrievalSummary: (request: ContextRequest) => ContextBundle["retrieval"];
  getMoodSnapshot: () => MoodState;
  recordWrite: (payload: unknown) => Promise<void>;
};

export const buildContext = async (
  deps: BuildContextDeps,
  request: ContextRequest,
): Promise<ContextBundle> => {
  const maxRecent = request.maxRecentEvents ?? 80;
  const maxArchive = request.maxArchiveEvents ?? 40;
  await deps
    .refreshTemporalContext({
      force: false,
      allowAgentCompression: false,
    })
    .catch(() => undefined);

  const identityPath = path.join(deps.stateDir, "memory", "identity.json");
  const modePath = request.mode
    ? path.join(deps.stateDir, "memory", "modes", `${request.mode}.json`)
    : null;
  const [identityRaw, modeRaw] = await Promise.all([
    readJsonFile(identityPath),
    modePath ? readJsonFile(modePath) : Promise.resolve(null),
  ]);

  const notesDir = path.join(deps.stateDir, "memory", "notes");
  const noteFiles = await fs.readdir(notesDir).catch(() => []);
  const notes: Array<{
    version: number;
    title: string;
    content: string;
    appliesTo?: { modes?: string[]; audiences?: string[] };
  }> = [];
  for (const name of noteFiles) {
    if (!name.endsWith(".json")) continue;
    const note = await readJsonFile(path.join(notesDir, name));
    if (!isRecord(note) || note.version !== 1) continue;
    if (typeof note.title !== "string" || typeof note.content !== "string") continue;
    notes.push(
      note as {
        version: number;
        title: string;
        content: string;
        appliesTo?: { modes?: string[]; audiences?: string[] };
      },
    );
  }

  const eligible = notes.filter((note) => {
    const appliesTo = note.appliesTo;
    if (!appliesTo) return true;
    if (
      request.mode &&
      Array.isArray(appliesTo.modes) &&
      appliesTo.modes.length > 0 &&
      !appliesTo.modes.includes(request.mode)
    ) {
      return false;
    }
    if (
      request.audience &&
      Array.isArray(appliesTo.audiences) &&
      appliesTo.audiences.length > 0 &&
      !appliesTo.audiences.includes(request.audience)
    ) {
      return false;
    }
    return true;
  });

  const recent = await deps.readRecentEnvelopes({
    maxLines: Math.max(maxRecent, 120),
  });
  const targetFilter = (env: MemoryEnvelope): boolean => {
    const keys = extractKeysFromPayload(env.payload);
    return (
      (typeof request.postId === "number" && keys.postId === request.postId) ||
      (typeof request.commentId === "number" && keys.commentId === request.commentId)
    );
  };
  const targetEvents = recent.filter(targetFilter).slice(-maxRecent);
  const archiveEvents = await deps.readArchiveContext({
    request,
    maxEvents: maxArchive,
    targetFilter,
  });
  const targetFocus = summarizeTargetFocus({
    request,
    targetEvents: uniqueEventsBySignature([
      ...targetEvents,
      ...archiveEvents.filter(targetFilter),
    ]),
  });
  const viewSummary = deps.buildViewSummary(request);
  const retrievalSummary = deps.buildRetrievalSummary(request);

  const nowMs = Date.now();
  if (nowMs - deps.lastContextReadAtMs > 12_000) {
    deps.setLastContextReadAtMs(nowMs);
    void deps.recordWrite({
      type: "memory_context_read",
      at: nowIso(),
      mode: request.mode ?? null,
      audience: request.audience ?? null,
      postId: request.postId ?? null,
      commentId: request.commentId ?? null,
    });
  }

  return {
    generatedAt: nowIso(),
    identity: identityRaw ? safeTextMemory(identityRaw) : null,
    mode: modeRaw ? safeTextMemory(modeRaw) : null,
    audience: request.audience ?? null,
    view: viewSummary,
    retrieval: retrievalSummary,
    mood: deps.getMoodSnapshot(),
    temporal: isRecord(deps.getTemporalContext())
      ? deps.getTemporalContext()
      : defaultTemporalContext(),
    target: {
      postId: request.postId ?? null,
      commentId: request.commentId ?? null,
      events: targetEvents,
      focus: targetFocus,
    },
    recent: recent.slice(-maxRecent),
    archive: archiveEvents,
    notes: eligible,
  };
};

export const refreshTemporalContextCore = async (
  deps: {
    temporalContext: TemporalContext;
    setTemporalContext: (value: TemporalContext) => void;
    setTemporalDirty: (value: boolean) => void;
    scheduleTemporalContextWrite: () => void;
    readRecentEnvelopes: (input: { maxLines: number }) => Promise<MemoryEnvelope[]>;
    readArchiveWindow: (input: {
      maxAgeDays: number;
      maxEvents: number;
      filter?: (env: MemoryEnvelope) => boolean;
    }) => Promise<MemoryEnvelope[]>;
  },
  options: {
    force: boolean;
    allowAgentCompression: boolean;
    agentCompressFn: RefreshTemporalOptions["agentCompressFn"];
  },
): Promise<TemporalContext> => {
  const { force, allowAgentCompression, agentCompressFn } = options;

  const nowMs = Date.now();
  const updatedAtMs = Date.parse(deps.temporalContext.updatedAt ?? "");
  if (!force && Number.isFinite(updatedAtMs) && nowMs - updatedAtMs < 120_000) {
    return deps.temporalContext;
  }

  const recent = await deps.readRecentEnvelopes({ maxLines: 1600 });
  const archived = await deps.readArchiveWindow({ maxAgeDays: 365, maxEvents: 900 });
  const combined = uniqueEventsBySignature([...archived, ...recent]).sort((a, b) =>
    a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0,
  );
  const byAge = (days: number): MemoryEnvelope[] => {
    const minMs = nowMs - days * 86_400_000;
    return combined.filter((env) => {
      const envMs = Date.parse(env.receivedAt);
      return Number.isFinite(envMs) && envMs >= minMs;
    });
  };

  const specs = [
    { key: "24h", days: 1, label: "last 24 hours", maxBullets: 20 },
    { key: "7d", days: 7, label: "last 7 days", maxBullets: 16 },
    { key: "30d", days: 30, label: "last 30 days", maxBullets: 12 },
    { key: "365d", days: 365, label: "last 365 days", maxBullets: 8 },
  ];
  const nextTiers: Record<string, TierSummary> = {};
  const specByKey = new Map<string, (typeof specs)[number]>();

  for (const spec of specs) {
    nextTiers[spec.key] = summarizeEventsForTier({
      tier: spec.key,
      label: spec.label,
      events: byAge(spec.days),
      maxBullets: spec.maxBullets,
    });
    specByKey.set(spec.key, spec);
  }

  if (allowAgentCompression && typeof agentCompressFn === "function") {
    const targets: AgentCompressionRequest["tiers"] = {};
    for (const tierKey of ["30d", "365d"]) {
      const summary = nextTiers[tierKey];
      if (!summary) continue;
      targets[tierKey] = {
        tier: tierKey,
        label: summary.windowLabel ?? tierKey,
        eventCount: summary.eventCount,
        topTypes: summary.topTypes,
        topPosts: summary.topPosts,
        topActors: summary.topActors,
        bullets: summary.algorithmBullets,
      };
    }

    if (Object.keys(targets).length > 0) {
      try {
        const agentCompressed = await agentCompressFn({ tiers: targets });
        const tierEntries =
          isRecord(agentCompressed) && isRecord(agentCompressed.tiers)
            ? agentCompressed.tiers
            : null;
        const normalizeBullets = (candidate: unknown, max: number): string[] => {
          if (!Array.isArray(candidate)) return [];
          return unique(
            candidate
              .filter((line): line is string => typeof line === "string")
              .map((line) => toShortLine(line, 140))
              .filter((line) => line.length > 0),
          ).slice(0, max);
        };

        for (const tierKey of Object.keys(targets)) {
          const summary = nextTiers[tierKey];
          if (!summary) continue;
          const maxBullets = specByKey.get(tierKey)?.maxBullets ?? 8;
          const fromTiers = tierEntries ? tierEntries[tierKey] : null;
          const directValue = isRecord(agentCompressed)
            ? agentCompressed[tierKey]
            : null;
          const preferred = fromTiers ?? directValue;
          const preferredRecord = isRecord(preferred) ? preferred : null;
          const candidateBullets = Array.isArray(preferred)
            ? preferred
            : preferredRecord && Array.isArray(preferredRecord.bullets)
              ? preferredRecord.bullets
              : Object.keys(targets).length === 1 && Array.isArray(agentCompressed)
                ? agentCompressed
                : [];
          const normalizedBullets = normalizeBullets(candidateBullets, maxBullets);
          if (normalizedBullets.length > 0) {
            summary.bullets = normalizedBullets;
            summary.compressedBy = "agent";
          } else {
            summary.bullets = summary.algorithmBullets;
            summary.compressedBy = "algorithm";
          }
        }
      } catch {
        // Keep algorithm summary.
      }
    }
  }

  const nextTemporalContext: TemporalContext = {
    version: 1,
    updatedAt: nowIso(),
    algorithmVersion: 1,
    tiers: {
      ...defaultTemporalContext().tiers,
      ...nextTiers,
    },
  };
  deps.setTemporalContext(nextTemporalContext);
  deps.setTemporalDirty(true);
  deps.scheduleTemporalContextWrite();
  return nextTemporalContext;
};
