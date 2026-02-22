/**
 * Envelope parsing and payload data extraction.
 *
 * Ported from agent-runtime.mjs lines 1255-1535
 * (extractKeysFromPayload, parseMemoryEnvelope, readNested,
 * pickFirstPayloadString, extractActorHintFromPayload,
 * extractTextHintFromPayload).
 */

import type {
  MemoryEnvelope,
  ExtractedKeys,
  RetentionCategory,
} from "~/types/memory.js";
import { isRecord } from "~/lib/guards.js";
import { toShortLine } from "~/lib/time.js";

// ---------------------------------------------------------------------------
// extractKeysFromPayload
// ---------------------------------------------------------------------------

export const extractKeysFromPayload = (payload: unknown): ExtractedKeys => {
  const toFinitePositiveInt = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number.parseInt(value.trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return null;
  };
  const readFirstPositiveInt = (
    root: unknown,
    paths: readonly string[],
  ): number | null => {
    for (const pathSpec of paths) {
      const value = readNested(root, pathSpec.split("."));
      const parsed = toFinitePositiveInt(value);
      if (parsed) return parsed;
    }
    return null;
  };
  const readFirstString = (
    root: unknown,
    paths: readonly string[],
  ): string | null => {
    for (const pathSpec of paths) {
      const value = readNested(root, pathSpec.split("."));
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
    return null;
  };

  if (!isRecord(payload)) {
    return {
      type: null,
      postId: null,
      commentId: null,
      tags: [],
      categories: [],
    };
  }
  const type =
    readFirstString(payload, [
      "type",
      "eventType",
      "payload.type",
      "notification.type",
    ]) ?? null;

  const entityType =
    readFirstString(payload, [
      "entityType",
      "targetType",
      "notification.entityType",
      "payload.entityType",
      "payload.targetType",
    ])?.toLowerCase() ?? null;
  const entityId = readFirstPositiveInt(payload, [
    "entityId",
    "targetId",
    "notification.entityId",
    "payload.entityId",
    "payload.targetId",
  ]);

  const postIdFromFields = readFirstPositiveInt(payload, [
    "postId",
    "targetPostId",
    "notification.postId",
    "payload.postId",
    "payload.targetPostId",
    "post.id",
    "target.postId",
    "target.post.id",
    "entity.postId",
    "entity.post.id",
    "comment.postId",
    "payload.comment.postId",
  ]);
  const commentIdFromFields = readFirstPositiveInt(payload, [
    "commentId",
    "targetCommentId",
    "parentId",
    "notification.commentId",
    "payload.commentId",
    "payload.targetCommentId",
    "payload.parentId",
    "comment.id",
    "target.commentId",
    "target.comment.id",
    "entity.commentId",
    "entity.comment.id",
  ]);

  const postId =
    postIdFromFields ??
    (entityType === "post" ? entityId ?? null : null);
  const commentId =
    commentIdFromFields ??
    (entityType === "comment" ? entityId ?? null : null);
  const tags = Array.isArray(payload.tags)
    ? payload.tags.filter((entry): entry is string => typeof entry === "string")
    : [];
  const categories = Array.isArray(payload.categories)
    ? payload.categories.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  return { type, postId, commentId, tags, categories };
};

// ---------------------------------------------------------------------------
// parseMemoryEnvelope
// ---------------------------------------------------------------------------

export const parseMemoryEnvelope = (
  value: unknown,
): MemoryEnvelope | null => {
  if (!isRecord(value)) return null;
  const receivedAt =
    typeof value.receivedAt === "string" ? value.receivedAt : null;
  const source =
    value.source === "user" ||
    value.source === "public" ||
    value.source === "local"
      ? value.source
      : null;
  const topic = typeof value.topic === "string" ? value.topic : null;
  if (!receivedAt || !source || !topic) return null;
  return { receivedAt, source, topic, payload: value.payload };
};

// ---------------------------------------------------------------------------
// readNested
// ---------------------------------------------------------------------------

export const readNested = (
  value: unknown,
  pathTokens: string[],
): unknown => {
  let cursor: unknown = value;
  for (const token of pathTokens) {
    if (!isRecord(cursor) || !(token in cursor)) return null;
    cursor = cursor[token];
  }
  return cursor;
};

// ---------------------------------------------------------------------------
// pickFirstPayloadString
// ---------------------------------------------------------------------------

export const pickFirstPayloadString = (
  payload: unknown,
  paths: string[],
): string => {
  if (!isRecord(payload) || !Array.isArray(paths)) return "";
  for (const pathSpec of paths) {
    if (typeof pathSpec !== "string" || !pathSpec.trim().length) continue;
    const pathTokens = pathSpec.split(".");
    const found = readNested(payload, pathTokens);
    if (typeof found === "string" && found.trim().length > 0) {
      return found.trim();
    }
  }
  return "";
};

// ---------------------------------------------------------------------------
// extractActorHintFromPayload
// ---------------------------------------------------------------------------

export const extractActorHintFromPayload = (payload: unknown): string => {
  const raw = pickFirstPayloadString(payload, [
    "actor.handle",
    "actor.username",
    "actor.displayName",
    "author.handle",
    "author.username",
    "author.displayName",
    "from.username",
    "from.handle",
    "user.username",
    "user.handle",
    "owner.username",
    "owner.handle",
    "profile.username",
    "profile.handle",
    "comment.author.username",
    "comment.author.handle",
    "username",
    "handle",
    "displayName",
    "name",
  ]);
  return toShortLine(raw.replace(/^@+/u, ""), 60);
};

const normalizeParticipantHandle = (value: string): string | null => {
  const normalized = value.trim().replace(/^@+/u, "").toLowerCase();
  if (!/^[a-z0-9_.-]{2,64}$/u.test(normalized)) return null;
  return `@${normalized}`;
};

const normalizeParticipantId = (value: string): string | null => {
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9_.:-]{6,120}$/u.test(normalized)) return null;
  return `id:${normalized}`;
};

const collectStringCandidatesFromPath = (
  payload: unknown,
  pathSpec: string,
): string[] => {
  const found = readNested(payload, pathSpec.split("."));
  if (typeof found === "string") {
    const trimmed = found.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  if (!Array.isArray(found)) return [];
  return found
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

/**
 * Extract a compact participant set from payload for memory indexing.
 * Values are normalized to either "@handle" or "id:<mainUserId-like>".
 */
export const extractParticipantsFromPayload = (payload: unknown): string[] => {
  if (!isRecord(payload)) return [];
  const handlePaths = [
    "actor.handle",
    "actor.username",
    "author.handle",
    "author.username",
    "from.handle",
    "from.username",
    "user.handle",
    "user.username",
    "owner.handle",
    "owner.username",
    "profile.handle",
    "profile.username",
    "comment.author.handle",
    "comment.author.username",
    "post.author.handle",
    "post.author.username",
    "target.handle",
    "target.username",
    "mentions",
    "mentionedHandles",
    "handles",
  ] as const;
  const idPaths = [
    "actor.mainUserId",
    "author.mainUserId",
    "user.mainUserId",
    "owner.mainUserId",
    "targetMainUserId",
    "followActorMainUserId",
    "authorMainUserId",
    "viewerMainUserId",
    "otherMainUserId",
    "mainUserId",
    "userId",
  ] as const;

  const out = new Set<string>();
  for (const pathSpec of handlePaths) {
    for (const value of collectStringCandidatesFromPath(payload, pathSpec)) {
      const normalized = normalizeParticipantHandle(value);
      if (normalized) out.add(normalized);
    }
  }
  for (const pathSpec of idPaths) {
    for (const value of collectStringCandidatesFromPath(payload, pathSpec)) {
      const normalized = normalizeParticipantId(value);
      if (normalized) out.add(normalized);
    }
  }

  const mentionSource = [
    extractTextHintFromPayload(payload),
    pickFirstPayloadString(payload, ["body", "text", "caption", "summary"]),
  ]
    .filter((entry) => entry.length > 0)
    .join(" ");
  for (const match of mentionSource.matchAll(/@([a-z0-9_.-]{2,64})/giu)) {
    const candidate = match[1] ?? "";
    const normalized = normalizeParticipantHandle(candidate);
    if (normalized) out.add(normalized);
  }

  const actor = extractActorHintFromPayload(payload);
  const normalizedActor = normalizeParticipantHandle(actor);
  if (normalizedActor) out.add(normalizedActor);

  return [...out].slice(0, 16);
};

// ---------------------------------------------------------------------------
// extractTextHintFromPayload
// ---------------------------------------------------------------------------

export const extractTextHintFromPayload = (payload: unknown): string => {
  const raw = pickFirstPayloadString(payload, [
    "body",
    "text",
    "textBody",
    "caption",
    "content",
    "message",
    "summary",
    "title",
    "prompt",
    "instruction",
    "topic",
    "comment.body",
    "post.text",
    "post.caption",
  ]);
  return toShortLine(raw, 140);
};

// ---------------------------------------------------------------------------
// classifyRetentionCategory
// ---------------------------------------------------------------------------

export const classifyRetentionCategory = (
  envelope: MemoryEnvelope | null | undefined,
  stream: string,
): RetentionCategory => {
  const keys = extractKeysFromPayload(envelope?.payload);
  const type = keys.type ?? "";

  if (stream === "notifications") return "notifications";
  if (stream === "feed") return "posts";
  if (
    stream === "likes" ||
    stream === "reposts" ||
    stream === "comments" ||
    stream === "activity" ||
    stream === "views"
  ) {
    return "interactions";
  }
  if (stream === "errors") return "system";

  if (stream === "writes") {
    if (
      type.startsWith("chat_runtime_") ||
      type.startsWith("openclaw_prompt_")
    ) {
      return "commands";
    }
    if (
      type.startsWith("runtime_") ||
      type.startsWith("kthx_config_") ||
      type.startsWith("execution_") ||
      type.startsWith("memory_") ||
      type.startsWith("events_") ||
      type.endsWith("_warning") ||
      type === "retention_cleanup_completed" ||
      type === "retention_cleanup_failed"
    ) {
      return "system";
    }
  }

  // director, memory_activity, tags, story_replies are exempt
  return null;
};
