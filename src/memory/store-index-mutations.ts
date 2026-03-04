import type { ExtractedKeys, ViewState } from "~/types/memory.js";
import { normalizeIso, unique } from "~/lib/time.js";
import type { KeywordIndexDoc, KeywordMemoryIndex } from "./store-helpers.js";
import {
  KEYWORD_INDEX_MAX_DOCS,
  KEYWORD_INDEX_MAX_DOCS_PER_KEYWORD,
  KEYWORD_INDEX_PRUNE_CHECK_INTERVAL,
  KEYWORD_INDEX_PRUNE_TARGET,
  VIEW_STATE_MAX_ITEMS,
  VIEW_STATE_PRUNE_CHECK_INTERVAL,
  VIEW_STATE_PRUNE_TARGET,
} from "./store-helpers.js";

export const resolveViewStateEntity = (
  keys: ExtractedKeys,
): { key: string; postId: number | null; commentId: number | null } | null => {
  if (typeof keys.commentId === "number" && keys.commentId > 0) {
    return {
      key: `comment:${keys.commentId}`,
      postId: typeof keys.postId === "number" && keys.postId > 0 ? keys.postId : null,
      commentId: keys.commentId,
    };
  }
  if (typeof keys.postId === "number" && keys.postId > 0) {
    return { key: `post:${keys.postId}`, postId: keys.postId, commentId: null };
  }
  return null;
};

export const maybePruneViewState = (viewState: ViewState): boolean => {
  const entries = Object.entries(viewState.items);
  if (entries.length <= VIEW_STATE_MAX_ITEMS) return false;
  const sorted = entries.sort((a, b) => {
    const aMs = Date.parse(a[1].lastSeenAt);
    const bMs = Date.parse(b[1].lastSeenAt);
    if (!Number.isFinite(aMs) && !Number.isFinite(bMs)) return 0;
    if (!Number.isFinite(aMs)) return 1;
    if (!Number.isFinite(bMs)) return -1;
    return bMs - aMs;
  });
  const keep = sorted.slice(0, VIEW_STATE_PRUNE_TARGET);
  const nextItems: ViewState["items"] = {};
  for (const [key, item] of keep) nextItems[key] = item;
  viewState.items = nextItems;
  return true;
};

export const upsertViewStateItem = (input: {
  viewState: ViewState;
  viewStateMutationCount: number;
  key: string;
  status: "unviewed" | "viewed";
  receivedAt: string;
  postId: number | null;
  commentId: number | null;
  sourceType: string | null;
  topic: string | null;
}): { created: boolean; mutationCount: number; pruned: boolean } => {
  const receivedAt = normalizeIso(input.receivedAt);
  const existing = input.viewState.items[input.key];
  const created = !existing;

  const next: ViewState["items"][string] = {
    status:
      input.status === "viewed"
        ? "viewed"
        : existing?.status === "viewed"
          ? "viewed"
          : "unviewed",
    receivedAt: existing?.receivedAt ?? receivedAt,
    firstSeenAt: existing?.firstSeenAt ?? receivedAt,
    lastSeenAt: receivedAt,
    seenCount:
      input.status === "viewed"
        ? (existing?.seenCount ?? 0) + 1
        : existing?.seenCount ?? 0,
    postId:
      (typeof input.postId === "number" && input.postId > 0 ? input.postId : null) ??
      existing?.postId ??
      null,
    commentId:
      (typeof input.commentId === "number" && input.commentId > 0
        ? input.commentId
        : null) ??
      existing?.commentId ??
      null,
    sourceType: input.sourceType ?? existing?.sourceType ?? null,
    lastTopic: input.topic ?? existing?.lastTopic ?? null,
  };

  input.viewState.items[input.key] = next;

  let mutationCount = input.viewStateMutationCount + 1;
  let pruned = false;
  if (
    mutationCount % VIEW_STATE_PRUNE_CHECK_INTERVAL === 0 ||
    Object.keys(input.viewState.items).length > VIEW_STATE_MAX_ITEMS
  ) {
    pruned = maybePruneViewState(input.viewState);
  }

  return { created, mutationCount, pruned };
};

export const pruneKeywordIndex = (keywordIndex: KeywordMemoryIndex): boolean => {
  const entries = Object.entries(keywordIndex.docs);
  if (entries.length <= KEYWORD_INDEX_MAX_DOCS) return false;
  const keepEntries = entries
    .sort((a, b) =>
      a[1].receivedAt < b[1].receivedAt
        ? 1
        : a[1].receivedAt > b[1].receivedAt
          ? -1
          : 0,
    )
    .slice(0, KEYWORD_INDEX_PRUNE_TARGET);
  const nextDocs: KeywordMemoryIndex["docs"] = {};
  for (const [docId, doc] of keepEntries) {
    nextDocs[docId] = doc;
  }
  const nextInverted: KeywordMemoryIndex["inverted"] = {};
  for (const [docId, doc] of Object.entries(nextDocs)) {
    for (const keyword of doc.keywords) {
      nextInverted[keyword] ??= [];
      nextInverted[keyword].push(docId);
    }
  }
  for (const keyword of Object.keys(nextInverted)) {
    nextInverted[keyword] = unique(
      (nextInverted[keyword] ?? []).slice(0, KEYWORD_INDEX_MAX_DOCS_PER_KEYWORD),
    );
  }
  keywordIndex.docs = nextDocs;
  keywordIndex.inverted = nextInverted;
  return true;
};

export const upsertKeywordDoc = (input: {
  keywordIndex: KeywordMemoryIndex;
  keywordIndexMutationCount: number;
  doc: KeywordIndexDoc;
}): { mutationCount: number; pruned: boolean } => {
  const existing = input.keywordIndex.docs[input.doc.id];
  if (existing) {
    for (const keyword of existing.keywords) {
      const docIds = input.keywordIndex.inverted[keyword];
      if (!docIds) continue;
      input.keywordIndex.inverted[keyword] = docIds.filter((id) => id !== input.doc.id);
      if ((input.keywordIndex.inverted[keyword] ?? []).length === 0) {
        delete input.keywordIndex.inverted[keyword];
      }
    }
  }
  input.keywordIndex.docs[input.doc.id] = input.doc;
  for (const keyword of input.doc.keywords) {
    const current = input.keywordIndex.inverted[keyword] ?? [];
    const next = [input.doc.id, ...current.filter((id) => id !== input.doc.id)].slice(
      0,
      KEYWORD_INDEX_MAX_DOCS_PER_KEYWORD,
    );
    input.keywordIndex.inverted[keyword] = next;
  }

  let mutationCount = input.keywordIndexMutationCount + 1;
  let pruned = false;
  if (
    mutationCount % KEYWORD_INDEX_PRUNE_CHECK_INTERVAL === 0 ||
    Object.keys(input.keywordIndex.docs).length > KEYWORD_INDEX_MAX_DOCS
  ) {
    pruned = pruneKeywordIndex(input.keywordIndex);
  }

  return { mutationCount, pruned };
};
