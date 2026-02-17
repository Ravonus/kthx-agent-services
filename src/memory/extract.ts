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
  if (!isRecord(payload)) {
    return {
      type: null,
      postId: null,
      commentId: null,
      tags: [],
      categories: [],
    };
  }
  const type = typeof payload.type === "string" ? payload.type : null;
  const postId =
    typeof payload.postId === "number" && Number.isFinite(payload.postId)
      ? payload.postId
      : null;
  const commentId =
    typeof payload.commentId === "number" &&
    Number.isFinite(payload.commentId)
      ? payload.commentId
      : null;
  const tags =
    Array.isArray(payload.tags) &&
    payload.tags.every((t: unknown) => typeof t === "string")
      ? (payload.tags as string[])
      : [];
  const categories =
    Array.isArray(payload.categories) &&
    payload.categories.every((t: unknown) => typeof t === "string")
      ? (payload.categories as string[])
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
