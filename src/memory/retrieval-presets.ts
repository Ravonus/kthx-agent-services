import type { RetrievalIntent } from "~/types/memory.js";

export type RetrievalPresetDoc = {
  receivedAt: string;
  sourceType: string | null;
  postId: number | null;
  commentId: number | null;
  actor: string | null;
  participants?: string[];
  summary: string;
};

export type RetrievalPresetEvent = {
  receivedAt: string;
  postId: number | null;
  commentId: number | null;
  actor: string | null;
  summary: string;
};

export type RetrievalPresetMostRecentPost = {
  receivedAt: string;
  postId: number;
  actor: string | null;
  summary: string;
};

export type RetrievalPresetMostEngagedPost = {
  postId: number;
  score: number;
  comments: number;
  likes: number;
  reposts: number;
  views: number;
  lastAt: string;
  summary: string | null;
};

export type RetrievalPresetMostEngagedComment = {
  commentId: number;
  postId: number | null;
  score: number;
  comments: number;
  likes: number;
  reposts: number;
  views: number;
  notifications: number;
  lastAt: string;
  summary: string | null;
};

export type RetrievalPresetTopParticipantMetric =
  | "combined"
  | "comments"
  | "likes"
  | "reposts"
  | "views"
  | "notifications"
  | "presence";

export type RetrievalPresetTopParticipant = {
  participant: string;
  display: string;
  score: number;
  comments: number;
  likes: number;
  reposts: number;
  views: number;
  notifications: number;
  presence: number;
  lastAt: string;
};

export type RetrievalPresetSummary = {
  requested: {
    mostRecentPost: boolean;
    mostEngaged: boolean;
    mostEngagedComments: boolean;
    lastComments: boolean;
    lastLikes: boolean;
    lastViews: boolean;
    topParticipants: boolean;
  };
  range: {
    label: string;
    maxAgeMs: number;
  } | null;
  mostRecentPost: RetrievalPresetMostRecentPost | null;
  mostEngaged: {
    rangeLabel: string;
    rangeMaxAgeMs: number;
    posts: RetrievalPresetMostEngagedPost[];
  } | null;
  mostEngagedComments: {
    rangeLabel: string;
    rangeMaxAgeMs: number;
    comments: RetrievalPresetMostEngagedComment[];
  } | null;
  lastComments: RetrievalPresetEvent[];
  lastLikes: RetrievalPresetEvent[];
  lastViews: RetrievalPresetEvent[];
  topParticipants: {
    rangeLabel: string;
    rangeMaxAgeMs: number;
    metric: RetrievalPresetTopParticipantMetric;
    participants: RetrievalPresetTopParticipant[];
  } | null;
  lines: string[];
};

export type RetrievalPresetBuilderInput = {
  docs: RetrievalPresetDoc[];
  query: string;
  intent: RetrievalIntent;
  postId: number | null;
  commentId: number | null;
  defaultRangeMs?: number;
  maxMostEngagedPosts?: number;
  maxMostEngagedComments?: number;
  maxEventsPerType?: number;
  maxTopParticipants?: number;
  nowMs?: number;
};

export { buildRetrievalPresets } from "./retrieval-presets-builder.js";
