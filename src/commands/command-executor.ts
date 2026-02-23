/**
 * CommandExecutor: executes staged inbox commands for the TypeScript runtime.
 *
 * This is a focused execution path for v2 that:
 * - validates/parses staged command files
 * - verifies runtime command seals
 * - executes write commands and generate-and-queue plans
 * - marks queue items complete
 * - writes command outcomes to results.jsonl
 * - ACKs directive completion/failure back to the server
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  clampPublishText,
  inheritChatContextIntoPayload,
  resolveChatTargetFromPayload,
  sendChatResultMessageFromOutcome,
} from "../chat/chat-context.js";
import type { CustomAssetTransformSpec } from "../media/custom-asset-transform.js";
import { transformCustomAssetMedia } from "../media/custom-asset-transform.js";
import {
  sealRuntimeStagedCommand,
  verifyRuntimeCommandSeal,
} from "../directives/command-seal.js";
import type {
  CommandSealState,
  SealVerifyError,
} from "../directives/command-seal.js";
import { parseGrantCandidatesFromPermissionState } from "../grants/grant-state.js";
import { computeCommandSignature } from "../lib/crypto.js";
import {
  applyTargetLock,
  buildTargetHash,
  isTargetLockMatch,
} from "../lib/command-target.js";
import { appendJsonLine, ensureDir, readJsonMaybeIncomplete, readJsonFile, writeJsonFile } from "../lib/fs.js";
import { isRecord } from "../lib/guards.js";
import { parseCommand, parseJsonFromMixedText } from "../lib/parsing.js";
import { nowIso } from "../lib/text.js";
import { normalizeQueueState } from "../queue/queue-state.js";
import type { StateSqliteStore, CommandLifecycleState } from "../state/sqlite-state.js";
import type { QueueState } from "../types/ipc.js";
import type { Command } from "../types/ipc.js";
import type { ContextBundle, ContextRequest } from "../types/memory.js";

const MEDIA_FILE_RE =
  /\.(png|jpe?g|webp|gif|svg|mp4|mov|webm|pdf|csv|txt|md|json|js)$/iu;
const MAX_MEDIA_REFERENCE_INPUTS = 8;
const MAX_COLLECTED_REFERENCE_INPUTS = 12;
const COMMENT_ECHO_PREFIX_PATTERN = /^frame\s*\d+\s*[:.-]/iu;
const COMMENT_PROMPT_WRAPPER_PATTERN =
  /^(?:generate|create|make|draw|render)\s+(?:an?\s+)?(?:image|gif|avatar|banner|file)\b/iu;
const STREAM_PART_ARTIFACT_PATTERN = /(?:^|[./_-])part[_-]?\d+(?:\D|$)/iu;
const STREAM_PART_INDEX_PATTERN = /(?:^|[._-])part[_-]?(\d+)(?:\D|$)/iu;
const ACTION_IDEMPOTENCY_IN_FLIGHT_WINDOW_MS = 45_000;
const ACTION_REQUEUE_BACKOFF_MS = 15_000;
const OWNER_CAPABILITY_COOLDOWN_MS = 60_000;
const BRIDGE_LOOKUP_CACHE_TTL_MS = 12_000;
const ENGAGEMENT_TARGET_CACHE_TTL_MS = 90_000;
const ENGAGEMENT_TARGET_CACHE_MAX_ENTRIES = 240;
const POST_NOVELTY_HISTORY_WINDOW_MS = 1000 * 60 * 60 * 24 * 7;
const POST_NOVELTY_HISTORY_MAX_ITEMS = 80;
const POST_NOVELTY_MAX_AVOID_REFERENCES = 8;
const MEDIA_GENERATOR_DEFAULT_BASE_URL = "http://127.0.0.1:4280";
const MEDIA_GENERATOR_POLL_MS = 200;
const MEDIA_GENERATOR_OPEN_TIMEOUT_MS = 45_000;
const COMMENT_TOKEN_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "frame",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "style",
  "that",
  "the",
  "this",
  "to",
  "with",
]);

const CAPTION_POSITION_KEYS = new Set([
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "middle-center",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
]);

const TEXT_STYLE_THEME_KEYS = new Set([
  "warm",
  "cool",
  "night",
  "sunrise",
  "mint",
  "ocean",
  "plum",
  "sand",
]);

const TEXT_STYLE_ALIGN_KEYS = new Set(["left", "center", "right"]);
const TEXT_STYLE_EMPHASIS_KEYS = new Set([
  "soft",
  "bold",
  "serif",
  "mono",
  "display",
]);
const TEXT_STYLE_FONT_KEYS = new Set(["sans", "serif", "mono", "display"]);
const TEXT_STYLE_WEIGHT_KEYS = new Set(["regular", "bold"]);
const TEXT_STYLE_SIZE_KEYS = new Set(["sm", "md", "lg", "xl", "2xl"]);
const TEXT_STYLE_COLOR_KEYS = new Set([
  "ink",
  "paper",
  "cream",
  "sunset",
  "mint",
  "sky",
]);

const isHttpUrl = (value: string): boolean => /^https?:\/\//iu.test(value.trim());
const isDataUri = (value: string): boolean => /^data:/iu.test(value.trim());
const isFileUrl = (value: string): boolean => /^file:\/\//iu.test(value.trim());
const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const stripEmptyFilesFlag = (command: string, token: string): string => {
  const escaped = escapeRegex(token);
  return command
    .replace(new RegExp(`\\s--files\\s+"${escaped}"`, "giu"), " ")
    .replace(new RegExp(`\\s--files\\s+'${escaped}'`, "giu"), " ")
    .replace(new RegExp(`\\s--files\\s+${escaped}`, "giu"), " ")
    .replace(new RegExp(`\\s-f\\s+"${escaped}"`, "giu"), " ")
    .replace(new RegExp(`\\s-f\\s+'${escaped}'`, "giu"), " ")
    .replace(new RegExp(`\\s-f\\s+${escaped}`, "giu"), " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
};

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const asPositiveInt = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value <= 0) return null;
  return Math.floor(value);
};

const extToMime = (filePath: string): string => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".csv") return "text/csv";
  if (ext === ".md") return "text/markdown";
  if (ext === ".txt") return "text/plain";
  if (ext === ".json") return "application/json";
  if (ext === ".js") return "text/javascript";
  return "application/octet-stream";
};

const sniffMimeTypeFromBytes = (bytes: Buffer): string | null => {
  if (bytes.byteLength < 4) return null;
  if (
    bytes.byteLength >= 6 &&
    (bytes.subarray(0, 6).toString("ascii") === "GIF87a" ||
      bytes.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return "image/gif";
  }
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.byteLength >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    bytes.byteLength >= 12 &&
    bytes.subarray(4, 8).toString("ascii") === "ftyp"
  ) {
    const brand = bytes.subarray(8, 12).toString("ascii");
    if (brand === "avif" || brand === "avis") return "image/avif";
    return "video/mp4";
  }
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return "video/webm";
  }
  if (
    bytes.byteLength >= 5 &&
    bytes.subarray(0, 5).toString("ascii") === "%PDF-"
  ) {
    return "application/pdf";
  }
  const head = bytes.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || head.startsWith("<?xml")) {
    if (head.includes("<svg")) return "image/svg+xml";
  }
  return null;
};

const mimeToExt = (mime: string): string => {
  const normalized = mime.trim().toLowerCase();
  if (normalized === "image/png") return "png";
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/gif") return "gif";
  if (normalized === "image/svg+xml") return "svg";
  if (normalized === "video/mp4") return "mp4";
  if (normalized === "video/quicktime") return "mov";
  if (normalized === "video/webm") return "webm";
  if (normalized === "application/pdf") return "pdf";
  if (normalized === "text/csv") return "csv";
  if (normalized === "text/markdown") return "md";
  if (normalized === "text/plain") return "txt";
  if (normalized === "application/json") return "json";
  if (normalized === "text/javascript") return "js";
  return "bin";
};

const inferMimeTypeFromUrl = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed.length) return null;
  try {
    const parsed = new URL(trimmed);
    return extToMime(parsed.pathname);
  } catch {
    return extToMime(trimmed);
  }
};

const truncateText = (value: string, maxChars: number): string => {
  const text = value.trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(8, maxChars - 1))}…`;
};

const stripEmDashCharacters = (value: string): string =>
  value.replace(/[—–]/gu, "-");

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

const toUnknownArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

const extractBridgeMessageId = (value: unknown): string | null => {
  const fromRecord = (
    record: Record<string, unknown>,
    depth: number,
  ): string | null => {
    if (depth > 8) return null;
    const message = isRecord(record.message) ? record.message : null;
    const nestedMessageId = message
      ? asNonEmptyString(message.id) ??
        asNonEmptyString(message.messageId) ??
        asNonEmptyString(message.message_id)
      : null;
    if (nestedMessageId) return nestedMessageId;
    const directMessageId =
      asNonEmptyString(record.messageId) ?? asNonEmptyString(record.message_id);
    if (directMessageId) return directMessageId;
    const directId = asNonEmptyString(record.id);
    if (directId) return directId;
    for (const key of ["primary", "data", "result", "payload", "response"] as const) {
      const nested = isRecord(record[key]) ? record[key] : null;
      if (!nested) continue;
      const resolved = fromRecord(nested, depth + 1);
      if (resolved) return resolved;
    }
    return null;
  };
  if (!isRecord(value)) return null;
  return fromRecord(value, 0);
};

const isMissingFileError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const code =
    typeof (error as { code?: unknown }).code === "string"
      ? String((error as { code?: unknown }).code)
      : "";
  if (code.toUpperCase() === "ENOENT") return true;
  return /enoent|no such file or directory/iu.test(error.message);
};

const constrainGifPromptTo256 = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed.length) return trimmed;
  if (/\b256\s*[x×]\s*256\b/iu.test(trimmed)) return trimmed;
  return `${trimmed}. Exact output size: 256x256. Keep subject centered, motion readable, and loop-friendly.`;
};

const outputExtensionForGeneratedAssetType = (
  generatedAssetType: GeneratedAssetType,
): string => {
  if (generatedAssetType === "image") return "png";
  if (generatedAssetType === "gif") return "gif";
  if (generatedAssetType === "pdf") return "pdf";
  if (generatedAssetType === "csv") return "csv";
  if (generatedAssetType === "md") return "md";
  if (generatedAssetType === "txt") return "txt";
  if (generatedAssetType === "code") return "js";
  return "bin";
};

const normalizeCommentText = (value: string): string =>
  value.trim().replace(/\s+/gu, " ").toLowerCase();

const tokenizeCommentText = (value: string): string[] =>
  normalizeCommentText(value)
    .replace(/[^a-z0-9\s]/gu, " ")
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length >= 2 &&
        token.length <= 24 &&
        !COMMENT_TOKEN_STOP_WORDS.has(token) &&
        !/^\d+$/u.test(token),
    );

const computeTokenOverlapRatio = (candidate: string, reference: string): number => {
  const candidateTokens = Array.from(new Set(tokenizeCommentText(candidate)));
  if (candidateTokens.length === 0) return 0;
  const referenceTokens = new Set(tokenizeCommentText(reference));
  if (referenceTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of candidateTokens) {
    if (referenceTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / candidateTokens.length;
};

const hasLongNormalizedPhraseOverlap = (
  candidate: string,
  reference: string,
): boolean => {
  const normalizedCandidate = normalizeCommentText(candidate);
  const normalizedReference = normalizeCommentText(reference);
  if (normalizedCandidate.length < 18 || normalizedReference.length < 18) {
    return false;
  }
  const [shorter, longer] =
    normalizedCandidate.length <= normalizedReference.length
      ? [normalizedCandidate, normalizedReference]
      : [normalizedReference, normalizedCandidate];
  if (shorter.length < 18) return false;
  return longer.includes(shorter);
};

type CropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ProfileCropSpec = {
  target: "avatar" | "banner";
  outputAspect: number;
  focalPoint: { x: number; y: number };
  safeZone: CropRect;
  avoidEdges: { top: number; right: number; bottom: number; left: number };
  textSafeZone?: CropRect;
  guidance: string;
};

const roundNorm = (value: number): number =>
  Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
const roundValue = (value: number): number =>
  Math.round(value * 1000) / 1000;

const buildProfileCropSpec = (target: "avatar" | "banner"): ProfileCropSpec => {
  if (target === "avatar") {
    return {
      target,
      outputAspect: 1,
      focalPoint: { x: 0.5, y: 0.42 },
      safeZone: { x: 0.18, y: 0.16, width: 0.64, height: 0.64 },
      avoidEdges: { top: 0.08, right: 0.08, bottom: 0.08, left: 0.08 },
      guidance:
        "Keep the face/primary subject in the center 64% square and avoid placing key details near the outer 8% edge (circular crop loss).",
    };
  }
  return {
    target,
    outputAspect: 3,
    focalPoint: { x: 0.5, y: 0.38 },
    safeZone: { x: 0.08, y: 0.18, width: 0.84, height: 0.64 },
    textSafeZone: { x: 0.12, y: 0.24, width: 0.76, height: 0.48 },
    avoidEdges: { top: 0.1, right: 0.08, bottom: 0.1, left: 0.08 },
    guidance:
      "Keep core visuals inside the center safe zone (84% x 64%) and reserve top/bottom edges; put text/logo inside the text-safe band.",
  };
};

const normalizeProfileCropSpec = (spec: ProfileCropSpec): ProfileCropSpec => ({
  ...spec,
  outputAspect: roundValue(spec.outputAspect),
  focalPoint: {
    x: roundNorm(spec.focalPoint.x),
    y: roundNorm(spec.focalPoint.y),
  },
  safeZone: {
    x: roundNorm(spec.safeZone.x),
    y: roundNorm(spec.safeZone.y),
    width: roundNorm(spec.safeZone.width),
    height: roundNorm(spec.safeZone.height),
  },
  avoidEdges: {
    top: roundNorm(spec.avoidEdges.top),
    right: roundNorm(spec.avoidEdges.right),
    bottom: roundNorm(spec.avoidEdges.bottom),
    left: roundNorm(spec.avoidEdges.left),
  },
  ...(spec.textSafeZone
    ? {
        textSafeZone: {
          x: roundNorm(spec.textSafeZone.x),
          y: roundNorm(spec.textSafeZone.y),
          width: roundNorm(spec.textSafeZone.width),
          height: roundNorm(spec.textSafeZone.height),
        },
      }
    : {}),
});

const buildProfileCropPromptHint = (spec: ProfileCropSpec): string => {
  if (spec.target === "avatar") {
    return [
      "Crop-safe avatar composition requirements:",
      "- Single clear subject, forward-facing, upper-center focus.",
      "- Keep the subject inside the center 64% safe square.",
      "- Leave the outer 8% edge clean to survive circular crop masking.",
    ].join("\n");
  }
  return [
    "Crop-safe banner composition requirements:",
    "- Compose for a 3:1 banner frame with focal point slightly above center.",
    "- Keep essential visuals inside the center safe zone (84% x 64%).",
    "- Keep top/bottom 10% and side 8% relatively clean for variable viewport crops.",
    "- Keep text/logo inside the inner text-safe zone.",
  ].join("\n");
};

const parseDataUriPayload = (
  value: string,
): { mime: string; data: string } | null => {
  const trimmed = value.trim();
  const match = /^data:([^;]+);base64,(.+)$/iu.exec(trimmed);
  if (!match) return null;
  const mime = match[1]?.trim().toLowerCase() ?? "";
  const data = match[2]?.trim() ?? "";
  if (!mime.length || !data.length) return null;
  return { mime, data };
};

const buildExecutionDigest = (command: Command, ok: boolean, error: string | null): string =>
  crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        id: command.id,
        kind: command.kind,
        ok,
        error,
        at: nowIso(),
      }),
    )
    .digest("hex");

type AgentMutator = {
  mutate(input: Record<string, unknown>): Promise<unknown>;
};

type AgentRouterLike = {
  ackDirective: AgentMutator;
  createPost: AgentMutator;
  createStory: AgentMutator;
  commentPost: AgentMutator;
  updateAvatar: AgentMutator;
  updateBanner: AgentMutator;
  votePost: AgentMutator;
  repostPost: AgentMutator;
  generate: AgentMutator;
  uploadDataUri: AgentMutator;
  uploadRemote: AgentMutator;
};

type TrpcLike = {
  agent: Record<string, AgentMutator>;
  realtime?: Record<string, AgentMutator>;
};

type CommandOutcome = {
  at: string;
  commandId: string;
  kind: string;
  grantId: string | null;
  ok: boolean;
  data?: unknown;
  error?: {
    message: string;
    code?: string;
  };
};

type QueueTrackingStateLike = {
  queueStateMutation: Promise<void>;
};

type CommandExecutorContext = {
  config: {
    imageGenerateCmd: string | null;
    fileGenerateCmd: string | null;
    imageGenerateTimeoutMs: number;
  };
  ipcPaths: {
    inboxDir: string;
    processedDir: string;
    generatedDir: string;
    queueStatePath: string;
    resultsPath: string;
  };
  memory: {
    recordWrite(payload: unknown): Promise<void>;
    buildContext?: (request: ContextRequest) => Promise<ContextBundle>;
  };
  stateDb?: StateSqliteStore | null;
  trpc: TrpcLike | null;
  commandSeal: CommandSealState;
  controlKey: string | null;
  queue: QueueTrackingStateLike;
  callAgentChatBridge: ((payload: unknown) => Promise<unknown>) | null;
  callAgentUploadChunk: ((payload: unknown) => Promise<unknown>) | null;
  runOpenClawPrompt:
    | ((input: { prompt: string; purpose: string }) => Promise<OpenClawPromptExecutionResult | null>)
    | null;
};

type ExecuteResult = {
  processed: boolean;
  outcome: CommandOutcome | null;
};

type ResolvedMediaUpload = {
  mediaUrl: string;
  mediaOriginalUrl?: string;
  mediaOptimizedUrl?: string;
  mediaContentHash?: string;
  mediaIpfsCid?: string;
  mediaSizeBytes?: number;
  mediaType?: "image" | "video";
};

type GeneratedDraft = {
  action: string;
  payload: Record<string, unknown>;
};

type GeneratedAssetType = "image" | "gif" | "pdf" | "csv" | "code" | "file" | "txt" | "md";
type GeneratedCustomAssetKind = "emote" | "sticker" | "gif";
type GeneratedCustomAssetScope = "mine" | "group" | "server";
type GeneratedCustomAssetSaveIntent = {
  kind: GeneratedCustomAssetKind;
  scope: GeneratedCustomAssetScope;
  nameHint: string | null;
};
type GeneratedCustomAssetSaveResult = {
  kind: GeneratedCustomAssetKind;
  scope: GeneratedCustomAssetScope;
  name: string;
  id: number | null;
};
type MediaGeneratorStreamFrame = {
  sourceFileName: string | null;
  isStreamPart: boolean;
  streamPartIndex: number | null;
  isFinalStreamFrame: boolean;
  previewUrl: string | null;
  outputPath: string | null;
  metadataId: string | null;
  source: string | null;
};
type MediaGenerationProgress = {
  contextId: string | null;
  contextStatus: string | null;
  latestPreviewUrl: string | null;
  streamFrameCount: number;
  latestStreamFrameIndex: number | null;
  hasFinalStreamFrame: boolean;
  streamRevealProgress: number;
  streamFrames: MediaGeneratorStreamFrame[];
  timedOut: boolean;
};
type OpenClawPromptExecutionResult = {
  parsed: unknown;
  raw: string;
  agentName: string | null;
  payloadText: string | null;
  envelope: Record<string, unknown> | null;
};
type DraftPreviewPayload = {
  body: string;
  summary: string;
  draftPreviewText: string;
  draftPostKind: "post" | "thread";
  draftMode: "thread" | "carousel";
  draftSlideCount: number;
};

class RequeueCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequeueCommandError";
  }
}

type CommentCurationContext = {
  postAuthorHandle: string | null;
  postText: string | null;
  mediaSummary: string | null;
  threadSummary: string | null;
  payloadHint: string | null;
  memorySummary: string | null;
};

type CuratedCommentBody = {
  body: string;
  source: "openclaw";
  reason: string;
};

type EngagementDecisionContext = {
  postAuthorHandle: string | null;
  postText: string | null;
  mediaSummary: string | null;
  payloadHint: string | null;
  memorySummary: string | null;
};

type PostDraftContext = {
  targetPostId: number | null;
  postText: string | null;
  mediaSummary: string | null;
  commentSummary: string | null;
  payloadHint: string | null;
  memorySummary: string | null;
};

type TextPostVisualSlide = {
  caption: string | null;
  imagePrompt: string;
};

type TextPostVisualPlan = {
  renderMode: "text" | "slides";
  captionPosition: string | null;
  textStyle: Record<string, unknown> | null;
  backgroundImagePrompt: string | null;
  slides: TextPostVisualSlide[];
};

type EngagementTargetCandidate = {
  postId: number;
  commentId: number | null;
  authorId: string | null;
  source: string;
};

type EngagementLookupHints = {
  rawQuery: string;
  postId: number | null;
  commentId: number | null;
  handles: string[];
};

type EngagementResolutionTrace = {
  step: string;
  queryCount: number;
  cacheHits: number;
  addedCandidates: number;
  totalCandidates: number;
};

type RecentPostNoveltyEntry = {
  atMs: number;
  postType: "text" | "media";
  text: string;
  normalized: string;
  commandId: string;
  targetPostId: number | null;
};

type EngagementDecision = {
  shouldExecute: boolean;
  reason: string;
  source: "openclaw";
  contract: ActionContract | null;
};

type ActionContract = {
  action: "comment" | "like" | "repost";
  target: {
    postId: number;
    commentId: number | null;
    targetHash: string;
  };
  body: string | null;
  reason: string;
  shouldExecute: boolean;
};

type OwnerCapabilityCooldown = {
  untilMs: number;
  reason: string;
};

type CommandLifecycleCheckpointStage =
  | "received"
  | "queued"
  | "executing"
  | "generated"
  | "uploaded"
  | "write_mutation"
  | "chat_delivery"
  | "ack";

type FollowTargetMode = "owner" | "agent";

export class CommandExecutor {
  private readonly ctx: CommandExecutorContext;
  private readonly inFlight = new Set<string>();
  private readonly ownerCapabilityDeniedByTarget = new Map<string, OwnerCapabilityCooldown>();
  private readonly recentPostNoveltyHistory: RecentPostNoveltyEntry[] = [];
  private readonly bridgeLookupCache = new Map<string, { expiresAtMs: number; value: unknown }>();
  private readonly engagementTargetCache = new Map<
    string,
    { expiresAtMs: number; candidate: EngagementTargetCandidate }
  >();

  constructor(ctx: CommandExecutorContext) {
    this.ctx = ctx;
  }

  private async recordCommandLifecycleCheckpoint(input: {
    command: Command;
    stage: CommandLifecycleCheckpointStage;
    status?: "ok" | "failed";
    message?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.ctx.memory
      .recordWrite({
        type: "command_execution_checkpoint",
        at: nowIso(),
        commandId: input.command.id,
        commandKind: input.command.kind,
        sourceDirectiveId: input.command.sourceDirectiveId ?? null,
        pendingDirectiveId: input.command.pendingDirectiveId ?? null,
        actionNonce: input.command.actionNonce ?? null,
        stage: input.stage,
        status: input.status ?? "ok",
        ...(input.message && input.message.trim().length > 0
          ? { message: truncateText(input.message, 320) }
          : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      })
      .catch(() => undefined);
  }

  private releaseReplayConsumedForRetry(commandId: string): void {
    const normalizedCommandId = commandId.trim();
    if (!normalizedCommandId.length) return;
    this.ctx.commandSeal.runtimeConsumedCommandIds.delete(normalizedCommandId);
  }

  private pruneBridgeLookupCache(nowMs: number): void {
    for (const [key, cached] of this.bridgeLookupCache) {
      if (cached.expiresAtMs > nowMs) continue;
      this.bridgeLookupCache.delete(key);
    }
    if (this.bridgeLookupCache.size <= ENGAGEMENT_TARGET_CACHE_MAX_ENTRIES) return;
    const overflow = this.bridgeLookupCache.size - ENGAGEMENT_TARGET_CACHE_MAX_ENTRIES;
    let removed = 0;
    for (const key of this.bridgeLookupCache.keys()) {
      this.bridgeLookupCache.delete(key);
      removed += 1;
      if (removed >= overflow) break;
    }
  }

  private pruneEngagementTargetCache(nowMs: number): void {
    for (const [key, cached] of this.engagementTargetCache) {
      if (cached.expiresAtMs > nowMs) continue;
      this.engagementTargetCache.delete(key);
    }
    if (this.engagementTargetCache.size <= ENGAGEMENT_TARGET_CACHE_MAX_ENTRIES) return;
    const overflow = this.engagementTargetCache.size - ENGAGEMENT_TARGET_CACHE_MAX_ENTRIES;
    let removed = 0;
    for (const key of this.engagementTargetCache.keys()) {
      this.engagementTargetCache.delete(key);
      removed += 1;
      if (removed >= overflow) break;
    }
  }

  private buildEngagementTargetCacheKey(input: {
    action: "comment" | "like" | "repost";
    payload: Record<string, unknown>;
    hints: EngagementLookupHints;
  }): string {
    const scope = isRecord(input.payload.directiveScope) ? input.payload.directiveScope : null;
    const scopeTarget = scope && isRecord(scope.target) ? scope.target : null;
    const channelId = asNonEmptyString(input.payload.channelId) ??
      asNonEmptyString(scope?.channelId) ??
      asNonEmptyString(scopeTarget?.channelId) ??
      "";
    const conversationId = asNonEmptyString(input.payload.conversationId) ??
      asNonEmptyString(scope?.conversationId) ??
      asNonEmptyString(scopeTarget?.conversationId) ??
      "";
    return [
      input.action,
      input.hints.postId ? `p:${input.hints.postId}` : "p:none",
      input.hints.commentId ? `c:${input.hints.commentId}` : "c:none",
      input.hints.handles.slice(0, 3).join(","),
      truncateText(input.hints.rawQuery, 120).toLowerCase(),
      channelId,
      conversationId,
    ].join("|");
  }

  private async callAgentBridgeLookupCached(
    payload: Record<string, unknown>,
    ttlMs: number = BRIDGE_LOOKUP_CACHE_TTL_MS,
  ): Promise<{ value: unknown; cacheHit: boolean }> {
    if (!this.ctx.callAgentChatBridge) return { value: null, cacheHit: false };
    const nowMs = Date.now();
    this.pruneBridgeLookupCache(nowMs);
    const key = JSON.stringify(payload);
    const cached = this.bridgeLookupCache.get(key);
    if (cached && cached.expiresAtMs > nowMs) {
      return { value: cached.value, cacheHit: true };
    }
    const value = await this.ctx.callAgentChatBridge(payload);
    this.bridgeLookupCache.set(key, {
      expiresAtMs: nowMs + Math.max(1000, ttlMs),
      value,
    });
    return { value, cacheHit: false };
  }

  private extractEngagementLookupHints(payload: Record<string, unknown>): EngagementLookupHints {
    const fields = [
      asNonEmptyString(payload.requestText),
      asNonEmptyString(payload.topic),
      asNonEmptyString(payload.prompt),
      asNonEmptyString(payload.body),
      asNonEmptyString(payload.caption),
      asNonEmptyString(payload.textBody),
    ].filter((value): value is string => Boolean(value));
    const rawQuery = truncateText(fields.join(" · "), 420);
    const postIdFromText = (() => {
      for (const match of rawQuery.matchAll(/\bpost(?:\s*id)?\s*[:#]?\s*(\d{1,12})\b/giu)) {
        const parsed = Number.parseInt(match[1] ?? "", 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
      }
      return null;
    })();
    const commentIdFromText = (() => {
      for (const match of rawQuery.matchAll(
        /\bcomment(?:\s*id)?\s*[:#]?\s*(\d{1,12})\b/giu,
      )) {
        const parsed = Number.parseInt(match[1] ?? "", 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
      }
      return null;
    })();
    const handles = [...rawQuery.matchAll(/@([a-z0-9_.-]{2,64})/giu)]
      .map((match) => (match[1] ?? "").trim().toLowerCase())
      .filter((value) => value.length > 0)
      .slice(0, 8);
    return {
      rawQuery,
      postId: postIdFromText,
      commentId: commentIdFromText,
      handles,
    };
  }

  private parseTargetIdsFromTextLine(text: string): {
    postId: number | null;
    commentId: number | null;
  } {
    const normalized = text.trim();
    if (!normalized.length) {
      return { postId: null, commentId: null };
    }
    const parse = (pattern: RegExp): number | null => {
      const match = normalized.match(pattern);
      if (!match) return null;
      const parsed = Number.parseInt(match[1] ?? "", 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    };
    return {
      postId: parse(/\bpost(?:\s*id)?\s*[:#]?\s*(\d{1,12})\b/iu),
      commentId: parse(/\bcomment(?:\s*id)?\s*[:#]?\s*(\d{1,12})\b/iu),
    };
  }

  private normalizeFollowHandleCandidate(value: string): string | null {
    const cleaned = value
      .trim()
      .replace(/^[`"'“”‘’([{<@]+/gu, "")
      .replace(/[`"'“”‘’)\]}>.,!?;:]+$/gu, "");
    const normalized = cleaned.replace(/^@+/u, "").toLowerCase();
    if (!normalized.length) return null;
    return /^[a-z0-9_.-]{2,64}$/u.test(normalized) ? normalized : null;
  }

  private resolveChatCommandName(payload: Record<string, unknown>): string | null {
    const explicit = asNonEmptyString(payload.chatCommandName)?.toLowerCase();
    if (explicit) return explicit;
    const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
    return asNonEmptyString(chatContext?.commandName)?.toLowerCase() ?? null;
  }

  private resolveDelegatedFollowAction(
    payload: Record<string, unknown>,
  ): "follow" | "follow_engagers" | "follow_accept" | null {
    const explicitAction = asNonEmptyString(payload.followAction)?.toLowerCase() ?? "";
    if (explicitAction === "follow") return "follow";
    if (
      explicitAction === "follow_engagers" ||
      explicitAction === "follow-engagers" ||
      explicitAction === "followengagers"
    ) {
      return "follow_engagers";
    }
    if (
      explicitAction === "follow_accept" ||
      explicitAction === "follow-accept" ||
      explicitAction === "followaccept"
    ) {
      return "follow_accept";
    }
    const chatCommandName = this.resolveChatCommandName(payload);
    if (chatCommandName === "follow") return "follow";
    if (
      chatCommandName === "follow-engagers" ||
      chatCommandName === "followengagers"
    ) {
      return "follow_engagers";
    }
    if (
      chatCommandName === "follow-accept" ||
      chatCommandName === "followaccept"
    ) {
      return "follow_accept";
    }
    return null;
  }

  private resolveFollowTargetMode(payload: Record<string, unknown>): FollowTargetMode {
    const parseTarget = (value: string | null): FollowTargetMode | null => {
      if (!value) return null;
      const normalized = value.trim().toLowerCase();
      if (
        normalized === "owner" ||
        normalized === "for-me" ||
        normalized === "for_owner" ||
        normalized === "me"
      ) {
        return "owner";
      }
      if (normalized === "agent" || normalized === "as-agent" || normalized === "as_agent") {
        return "agent";
      }
      return null;
    };

    const directTarget =
      parseTarget(asNonEmptyString(payload.followTargetMode)) ??
      parseTarget(asNonEmptyString(payload.followMode)) ??
      parseTarget(asNonEmptyString(payload.requestedActingAs));
    if (directTarget) return directTarget;

    const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
    const commandArgs = Array.isArray(chatContext?.commandArgs) ? chatContext.commandArgs : [];
    const firstArg = commandArgs.length > 0 ? asNonEmptyString(commandArgs[0]) : null;
    const argTarget = parseTarget(firstArg);
    if (argTarget) return argTarget;

    const commandOrigin = asNonEmptyString(chatContext?.commandOrigin)?.toLowerCase();
    if (commandOrigin === "natural" || commandOrigin === "followup") {
      return "agent";
    }
    return "owner";
  }

  private collectFollowHandlesFromPayload(payload: Record<string, unknown>): string[] {
    const handles: string[] = [];
    const pushHandle = (value: unknown): void => {
      if (typeof value !== "string") return;
      const normalized = this.normalizeFollowHandleCandidate(value);
      if (!normalized) return;
      if (
        normalized === "for" ||
        normalized === "me" ||
        normalized === "all" ||
        normalized === "more" ||
        normalized === "as-agent" ||
        normalized === "as_agent"
      ) {
        return;
      }
      handles.push(normalized);
    };
    const pushHandlesFromUnknown = (value: unknown): void => {
      if (typeof value === "string") {
        for (const match of value.matchAll(/@([a-z0-9_.-]{2,64})/giu)) {
          pushHandle(match[1] ?? "");
        }
        for (const token of value.split(/\s+/u)) {
          pushHandle(token);
        }
        return;
      }
      if (!Array.isArray(value)) return;
      for (const entry of value) {
        if (typeof entry === "string") {
          pushHandle(entry);
        }
      }
    };

    pushHandlesFromUnknown(payload.followHandles);
    pushHandle(payload.handle);
    pushHandle(payload.followHandle);
    pushHandlesFromUnknown(payload.followSelections);

    const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
    pushHandlesFromUnknown(chatContext?.commandArgs);
    pushHandlesFromUnknown(chatContext?.commandRawArgs);
    pushHandlesFromUnknown(chatContext?.originalMessage);

    pushHandlesFromUnknown(payload.prompt);
    pushHandlesFromUnknown(payload.topic);
    pushHandlesFromUnknown(payload.requestText);

    return Array.from(new Set(handles)).slice(0, 24);
  }

  private collectFollowSelectionsFromPayload(payload: Record<string, unknown>): string[] {
    const selections: string[] = [];
    const pushSelection = (value: unknown): void => {
      if (typeof value !== "string") return;
      const normalized = value.trim().toLowerCase();
      if (!normalized.length) return;
      selections.push(normalized);
    };
    const pushSelectionFromUnknown = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const entry of value) {
          pushSelection(entry);
        }
        return;
      }
      pushSelection(value);
    };

    pushSelectionFromUnknown(payload.followSelections);
    const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
    pushSelectionFromUnknown(chatContext?.commandArgs);
    return Array.from(new Set(selections)).slice(0, 16);
  }

  private resolveFollowEngagersCount(payload: Record<string, unknown>): number {
    const fromPayload = asPositiveInt(payload.followCount);
    if (fromPayload) return Math.max(1, Math.min(12, fromPayload));
    const selections = this.collectFollowSelectionsFromPayload(payload);
    if (selections.includes("all")) return 12;
    const numeric = selections
      .map((entry) => Number.parseInt(entry, 10))
      .find((value) => Number.isFinite(value) && value > 0);
    if (numeric) return Math.max(1, Math.min(12, Math.floor(numeric)));
    return 8;
  }

  private extractTopEngagerHandlesFromLookup(value: unknown, limit: number): string[] {
    const handles: string[] = [];
    for (const row of this.collectBridgeRecordItems(value)) {
      const user = isRecord(row.user) ? row.user : null;
      const candidate =
        asNonEmptyString(user?.handle) ??
        asNonEmptyString(user?.username) ??
        asNonEmptyString(row.handle) ??
        asNonEmptyString(row.username);
      if (!candidate) continue;
      const normalized = this.normalizeFollowHandleCandidate(candidate);
      if (!normalized) continue;
      handles.push(normalized);
      if (handles.length >= limit) break;
    }
    return Array.from(new Set(handles)).slice(0, limit);
  }

  private async attemptFollowHandle(input: {
    target: FollowTargetMode;
    handle: string;
    action: "follow_user" | "unfollow_user";
  }): Promise<{
    handle: string;
    status:
      | "followed"
      | "already_followed"
      | "unfollowed"
      | "already_unfollowed"
      | "not_found"
      | "self"
      | "blocked"
      | "failed";
    error: string | null;
  }> {
    const callAgentChatBridge = this.ctx.callAgentChatBridge;
    if (!callAgentChatBridge) {
      return {
        handle: input.handle,
        status: "failed",
        error: "chat_bridge_unavailable",
      };
    }
    try {
      const result = await callAgentChatBridge({
        action: input.action,
        target: input.target,
        handle: input.handle,
      });
      const data = isRecord(result) ? result : null;
      const user = isRecord(data?.user) ? data.user : null;
      const resolvedHandle =
        this.normalizeFollowHandleCandidate(asNonEmptyString(user?.handle) ?? input.handle) ??
        input.handle;
      if (input.action === "follow_user") {
        const created = data?.created === true;
        const followed = data?.followed === true;
        if (followed && created) {
          return { handle: resolvedHandle, status: "followed", error: null };
        }
        if (followed && !created) {
          return { handle: resolvedHandle, status: "already_followed", error: null };
        }
        return {
          handle: resolvedHandle,
          status: "failed",
          error: "follow_action_returned_unexpected_shape",
        };
      }
      const removed = data?.removed === true;
      if (removed) {
        return { handle: resolvedHandle, status: "unfollowed", error: null };
      }
      return { handle: resolvedHandle, status: "already_unfollowed", error: null };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const lowered = message.toLowerCase();
      if (lowered.includes("not found")) {
        return { handle: input.handle, status: "not_found", error: message };
      }
      if (lowered.includes("own account") || lowered.includes("your own")) {
        return { handle: input.handle, status: "self", error: message };
      }
      if (lowered.includes("blocked")) {
        return { handle: input.handle, status: "blocked", error: message };
      }
      return { handle: input.handle, status: "failed", error: message };
    }
  }

  private buildFollowSummaryText(input: {
    target: FollowTargetMode;
    followed: string[];
    alreadyFollowed: string[];
    notFound: string[];
    self: string[];
    blocked: string[];
    failed: string[];
    remainingCount?: number;
    followEngagers?: boolean;
  }): string {
    const accountLabel = input.target === "agent" ? "agent account" : "your account";
    const segments: string[] = [];
    if (input.followed.length > 0) {
      if (input.followEngagers) {
        segments.push(
          `On the ${accountLabel}, now following ${input.followed.length} top engager${input.followed.length === 1 ? "" : "s"}: ${input.followed.map((entry) => `@${entry}`).join(", ")}.`,
        );
      } else {
        segments.push(
          `On the ${accountLabel}, now following: ${input.followed.map((entry) => `@${entry}`).join(", ")}.`,
        );
      }
    }
    if (input.alreadyFollowed.length > 0) {
      segments.push(
        `Already followed on the ${accountLabel}: ${input.alreadyFollowed.map((entry) => `@${entry}`).join(", ")}.`,
      );
    }
    if (input.notFound.length > 0) {
      segments.push(`Not found: ${input.notFound.map((entry) => `@${entry}`).join(", ")}.`);
    }
    if (input.self.length > 0) {
      segments.push(`Skipped your own account: ${input.self.map((entry) => `@${entry}`).join(", ")}.`);
    }
    if (input.blocked.length > 0) {
      segments.push(
        `Blocked follow relationship: ${input.blocked.map((entry) => `@${entry}`).join(", ")}.`,
      );
    }
    if (input.failed.length > 0) {
      segments.push(`Could not follow right now: ${input.failed.map((entry) => `@${entry}`).join(", ")}.`);
    }
    if (segments.length === 0) {
      segments.push("No follow changes were applied.");
    }
    if (typeof input.remainingCount === "number" && input.remainingCount > 0) {
      segments.push(
        `${input.remainingCount} more high-signal engagers are available. Say "follow more engagers" to continue.`,
      );
    }
    return segments.join(" ");
  }

  async processCommandFile(
    fileName: string,
    _opts?: { interactiveRl?: unknown },
  ): Promise<boolean> {
    const filePath = path.join(this.ctx.ipcPaths.inboxDir, fileName);
    if (this.inFlight.has(filePath)) return false;
    this.inFlight.add(filePath);
    try {
      return await this.processCommandFilePath(filePath);
    } finally {
      this.inFlight.delete(filePath);
    }
  }

  private agent(): AgentRouterLike {
    const router = this.ctx.trpc?.agent;
    if (!router) {
      throw new Error("tRPC agent client is unavailable.");
    }
    const requireMutator = (name: keyof AgentRouterLike): AgentMutator => {
      const candidate = router[String(name)];
      if (candidate && typeof candidate.mutate === "function") return candidate;
      throw new Error(`tRPC agent mutator is unavailable: agent.${String(name)}`);
    };
    return {
      ackDirective: requireMutator("ackDirective"),
      createPost: requireMutator("createPost"),
      createStory: requireMutator("createStory"),
      commentPost: requireMutator("commentPost"),
      updateAvatar: requireMutator("updateAvatar"),
      updateBanner: requireMutator("updateBanner"),
      votePost: requireMutator("votePost"),
      repostPost: requireMutator("repostPost"),
      generate: requireMutator("generate"),
      uploadDataUri: requireMutator("uploadDataUri"),
      uploadRemote: requireMutator("uploadRemote"),
    };
  }

  private async processCommandFilePath(filePath: string): Promise<boolean> {
    const inboxFile = path.basename(filePath);
    const read = await readJsonMaybeIncomplete(filePath);
    if (read.status === "missing") {
      await this.markQueueItemCompletedByInbox(inboxFile, "missing", "file missing before execution");
      return true;
    }
    if (read.status === "not_ready") {
      await this.markQueueItemNotReadyByInbox(inboxFile, "inbox_json_not_ready").catch(
        () => undefined,
      );
      return false;
    }
    if (read.status === "invalid") {
      await this.writeOutcome({
        at: nowIso(),
        commandId: `invalid:${inboxFile}`,
        kind: "unknown",
        grantId: null,
        ok: false,
        error: { message: "invalid json command" },
      });
      await this.moveInboxFileToProcessed(filePath, "invalid");
      await this.markQueueItemCompletedByInbox(inboxFile, "failed", "invalid json command");
      return true;
    }

    let command = parseCommand(read.value);
    if (!command) {
      await this.writeOutcome({
        at: nowIso(),
        commandId: `parse_failed:${inboxFile}`,
        kind: "unknown",
        grantId: null,
        ok: false,
        error: { message: "command parse failed" },
      });
      await this.moveInboxFileToProcessed(filePath, "invalid");
      await this.markQueueItemCompletedByInbox(inboxFile, "failed", "command parse failed");
      return true;
    }
    await this.recordCommandLifecycleCheckpoint({
      command,
      stage: "received",
      status: "ok",
      metadata: {
        inboxFile,
      },
    });

    let commandSigVerified = false;
    if (this.ctx.controlKey) {
      const expected = computeCommandSignature(this.ctx.controlKey, command);
      if (!command.sig || command.sig !== expected) {
        const outcome: CommandOutcome = {
          at: nowIso(),
          commandId: command.id,
          kind: command.kind,
          grantId: command.grantId,
          ok: false,
          error: {
            message:
              "Rejected command: invalid command signature for this runtime session.",
            code: "invalid_command_sig",
          },
        };
        await this.finalizeCommandOutcome({ command, outcome });
        await this.moveInboxFileToProcessed(filePath, "rejected");
        await this.markQueueItemCompletedByInbox(inboxFile, "failed", "invalid command signature");
        return true;
      }
      commandSigVerified = true;
    }

    let sealError = verifyRuntimeCommandSeal(this.ctx.commandSeal, command);
    if (
      sealError === "command_replay_detected" &&
      this.tryAllowTrustedReplay(command)
    ) {
      sealError = verifyRuntimeCommandSeal(this.ctx.commandSeal, command);
    }
    if (
      sealError === "command_not_issued_by_runtime" &&
      this.tryRehydrateRuntimeIssuedSeal(command)
    ) {
      await this.ctx.memory
        .recordWrite({
          type: "inbox_command_seal_rehydrated",
          at: nowIso(),
          inboxFile,
          commandId: command.id,
          kind: command.kind,
          runtimeOrigin: command.runtimeOrigin ?? null,
        })
        .catch(() => undefined);
      sealError = verifyRuntimeCommandSeal(this.ctx.commandSeal, command);
    }
    if (sealError) {
      const resealedCommand = await this.tryResealTrustedCommandForActiveSession({
        command,
        sealError,
        commandSigVerified,
        filePath,
        inboxFile,
      });
      if (resealedCommand) {
        command = resealedCommand;
        sealError = verifyRuntimeCommandSeal(this.ctx.commandSeal, command);
      }
    }
    if (sealError) {
      const outcome: CommandOutcome = {
        at: nowIso(),
        commandId: command.id,
        kind: command.kind,
        grantId: command.grantId,
        ok: false,
        error: {
          message:
            "Rejected external or stale command file. Only runtime-sealed commands from this active tunnel session are executable.",
          code: sealError,
        },
      };
      await this.ctx.memory.recordWrite({
        type: "inbox_command_rejected",
        at: nowIso(),
        inboxFile,
        commandId: command.id,
        kind: command.kind,
        reason: sealError,
      }).catch(() => undefined);
      await this.finalizeCommandOutcome({ command, outcome });
      await this.moveInboxFileToProcessed(filePath, "rejected");
      await this.markQueueItemCompletedByInbox(
        inboxFile,
        "failed",
        `runtime command seal rejected (${sealError})`,
      );
      return true;
    }

    await this.recordCommandLifecycleCheckpoint({
      command,
      stage: "queued",
      status: "ok",
      metadata: {
        inboxFile,
      },
    });
    await this.recordCommandLifecycleCheckpoint({
      command,
      stage: "executing",
      status: "ok",
    });

    const result = await this.executeCommand(command).catch(async (error: unknown) => {
      if (error instanceof RequeueCommandError) {
        this.releaseReplayConsumedForRetry(command.id);
        const requeueReason =
          typeof error.message === "string" && error.message.trim().length > 0
            ? error.message.trim()
            : "not_ready";
        await this.markQueueItemNotReadyByInbox(inboxFile, requeueReason).catch(() => undefined);
        await this.primeCommandContextForRequeue(command, requeueReason).catch(() => undefined);
        void this.ctx.memory
          .recordWrite({
            type: "inbox_command_requeued",
            at: nowIso(),
            inboxFile,
            commandId: command.id,
            kind: command.kind,
            reason: requeueReason,
            replayConsumedReleased: true,
          })
          .catch(() => undefined);
        return {
          processed: false,
          outcome: null,
        } satisfies ExecuteResult;
      }
      const message = error instanceof Error ? error.message : String(error);
      const outcome: CommandOutcome = {
        at: nowIso(),
        commandId: command.id,
        kind: command.kind,
        grantId: command.grantId,
        ok: false,
        error: { message },
      };
      return {
        processed: true,
        outcome,
      } satisfies ExecuteResult;
    });

    if (!result.processed) {
      return false;
    }
    const outcome = result.outcome;
    if (!outcome) {
      await this.moveInboxFileToProcessed(filePath, "done");
      await this.markQueueItemCompletedByInbox(inboxFile, "done", null);
      return true;
    }

    if (command.kind.trim().toLowerCase().startsWith("write.")) {
      await this.recordCommandLifecycleCheckpoint({
        command,
        stage: "write_mutation",
        status: outcome.ok ? "ok" : "failed",
        message: outcome.ok ? null : outcome.error?.message ?? null,
      });
    }

    await this.finalizeCommandOutcome({ command, outcome });

    if (outcome.ok) {
      await this.moveInboxFileToProcessed(filePath, "done");
      await this.markQueueItemCompletedByInbox(inboxFile, "done", null);
    } else {
      await this.moveInboxFileToProcessed(filePath, "failed");
      await this.markQueueItemCompletedByInbox(
        inboxFile,
        "failed",
        outcome.error?.message ?? "command failed",
      );
    }
    return true;
  }

  private async executeCommand(command: Command): Promise<ExecuteResult> {
    const kind = command.kind.trim().toLowerCase();
    if (kind === "write.createpost") {
      const outcome = await this.executeWriteCreatePost(command);
      return { processed: true, outcome };
    }
    if (kind === "write.createstory") {
      const outcome = await this.executeWriteCreateStory(command);
      return { processed: true, outcome };
    }
    if (kind === "write.updateavatar") {
      const outcome = await this.executeWriteUpdateAvatar(command);
      return { processed: true, outcome };
    }
    if (kind === "write.updatebanner") {
      const outcome = await this.executeWriteUpdateBanner(command);
      return { processed: true, outcome };
    }
    if (kind === "write.commentpost" || kind === "write.comment") {
      const outcome = await this.executeWriteComment(command);
      return { processed: true, outcome };
    }
    if (kind === "write.votepost" || kind === "write.like") {
      const outcome = await this.executeWriteVote(command);
      return { processed: true, outcome };
    }
    if (kind === "write.repostpost" || kind === "write.repost") {
      const outcome = await this.executeWriteRepost(command);
      return { processed: true, outcome };
    }
    if (
      kind === "brain.generateandqueue" ||
      kind === "brain.plan" ||
      kind === "brain.retrypending" ||
      kind === "agent.task" ||
      kind === "agent_task"
    ) {
      const outcome = await this.executeGenerateAndQueue(command);
      return { processed: true, outcome };
    }

    const outcome: CommandOutcome = {
      at: nowIso(),
      commandId: command.id,
      kind: command.kind,
      grantId: command.grantId,
      ok: false,
      error: {
        message: `Unsupported command kind: ${command.kind}`,
        code: "unsupported_command_kind",
      },
    };
    await this.ctx.memory.recordWrite({
      type: "command_execution_unsupported",
      at: nowIso(),
      commandId: command.id,
      kind: command.kind,
    }).catch(() => undefined);
    return { processed: true, outcome };
  }

  private async tryResealTrustedCommandForActiveSession(input: {
    command: Command;
    sealError: SealVerifyError;
    commandSigVerified: boolean;
    filePath: string;
    inboxFile: string;
  }): Promise<Command | null> {
    const recoverableSealErrors = new Set<SealVerifyError>([
      "missing_runtime_session",
      "runtime_session_mismatch",
      "missing_runtime_origin",
      "missing_runtime_sig",
      "invalid_runtime_sig",
    ]);
    if (!recoverableSealErrors.has(input.sealError)) return null;

    const commandId = asNonEmptyString(input.command.id);
    if (!commandId) return null;
    const sourceDirectiveId = asNonEmptyString(input.command.sourceDirectiveId);
    const pendingDirectiveId = asNonEmptyString(input.command.pendingDirectiveId);
    const runtimeOrigin = asNonEmptyString(input.command.runtimeOrigin)?.toLowerCase() ?? "";
    const trustedDirectiveOrigin =
      runtimeOrigin === "director_directive" || runtimeOrigin === "pending_promotion";
    const directiveLinked = sourceDirectiveId === commandId || pendingDirectiveId === commandId;

    if (!input.commandSigVerified && !(trustedDirectiveOrigin && directiveLinked)) {
      return null;
    }

    const resealed = sealRuntimeStagedCommand(
      this.ctx.commandSeal,
      {
        ...input.command,
      },
      runtimeOrigin || "runtime_resealed",
    );
    await writeJsonFile(input.filePath, resealed).catch(() => undefined);
    await this.ctx.memory
      .recordWrite({
        type: "inbox_command_resealed",
        at: nowIso(),
        inboxFile: input.inboxFile,
        commandId,
        kind: input.command.kind,
        reason: input.sealError,
        trustSource: input.commandSigVerified ? "command_sig" : "directive_origin",
        priorRuntimeSessionId: input.command.runtimeSessionId ?? null,
        priorRuntimeOrigin: input.command.runtimeOrigin ?? null,
        resealedRuntimeSessionId: resealed.runtimeSessionId,
        resealedRuntimeOrigin: resealed.runtimeOrigin,
      })
      .catch(() => undefined);
    return resealed;
  }

  private tryRehydrateRuntimeIssuedSeal(command: Command): boolean {
    const commandId = command.id.trim();
    if (!commandId.length) return false;
    if (this.ctx.commandSeal.runtimeIssuedCommandIds.has(commandId)) {
      return false;
    }
    const runtimeSessionId = asNonEmptyString(command.runtimeSessionId);
    const runtimeOrigin = asNonEmptyString(command.runtimeOrigin);
    const runtimeSig = asNonEmptyString(command.runtimeSig);
    if (!runtimeSessionId || !runtimeOrigin || !runtimeSig) {
      return false;
    }
    if (runtimeSessionId !== this.ctx.commandSeal.runtimeCommandSessionId) {
      return false;
    }
    this.ctx.commandSeal.runtimeIssuedCommandIds.add(commandId);
    return true;
  }

  private tryAllowTrustedReplay(command: Command): boolean {
    const commandId = command.id.trim();
    if (!commandId.length) return false;
    const runtimeSessionId = asNonEmptyString(command.runtimeSessionId);
    if (!runtimeSessionId) return false;
    if (runtimeSessionId !== this.ctx.commandSeal.runtimeCommandSessionId) {
      return false;
    }
    const runtimeOrigin = asNonEmptyString(command.runtimeOrigin)?.toLowerCase() ?? "";
    const trustedOrigin =
      runtimeOrigin === "director_directive" ||
      runtimeOrigin === "pending_promotion" ||
      runtimeOrigin === "runtime_resealed";
    if (!trustedOrigin) return false;
    const sourceDirectiveId = asNonEmptyString(command.sourceDirectiveId);
    const pendingDirectiveId = asNonEmptyString(command.pendingDirectiveId);
    const directiveLinked =
      sourceDirectiveId === commandId || pendingDirectiveId === commandId;
    if (!directiveLinked) return false;
    this.ctx.commandSeal.runtimeConsumedCommandIds.delete(commandId);
    return true;
  }

  private grantActionKeysFor(action: "comment" | "like" | "repost"): string[] {
    if (action === "comment") return ["comment", "write.commentPost"];
    if (action === "like") return ["like", "write.votePost"];
    return ["repost", "write.repostPost"];
  }

  private hasUsablePermissionWindowForAction(
    permissionState: unknown,
    action: "comment" | "like" | "repost",
  ): boolean {
    const candidates = parseGrantCandidatesFromPermissionState(permissionState);
    if (!candidates.length) return false;
    const nowMs = Date.now();
    const actionKeys = this.grantActionKeysFor(action);
    for (const candidate of candidates) {
      if (candidate.expiresAtMs <= nowMs) continue;
      for (const key of actionKeys) {
        const actionState = candidate.actions.get(key);
        if (!actionState || actionState.remainingCount <= 0) continue;
        const notBeforeAtMs =
          typeof actionState.notBeforeAtMs === "number" &&
          Number.isFinite(actionState.notBeforeAtMs)
            ? actionState.notBeforeAtMs
            : candidate.issuedAtMs + actionState.notBeforeSeconds * 1000;
        if (notBeforeAtMs > nowMs) continue;
        return true;
      }
    }
    return false;
  }

  private buildActionIdempotencyKey(input: {
    command: Command;
    action: "comment" | "like" | "repost";
    postId: number;
    commentId: number | null;
  }): string {
    const directiveId = input.command.sourceDirectiveId ?? input.command.id;
    const targetHash = buildTargetHash({
      postId: input.postId,
      commentId: input.commentId,
    });
    return crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          directiveId,
          actionNonce: input.command.actionNonce ?? "",
          action: input.action,
          targetHash,
        }),
      )
      .digest("hex");
  }

  private beginActionLifecycle(input: {
    command: Command;
    action: "comment" | "like" | "repost";
    idempotencyKey: string;
    target: {
      postId: number;
      commentId: number | null;
      targetHash: string;
    };
    state: CommandLifecycleState;
  }): { allowed: boolean; reason: string; requeue: boolean } {
    const stateDb = this.ctx.stateDb;
    if (!stateDb?.enabled) {
      return { allowed: true, reason: "state_db_disabled", requeue: false };
    }
    const existing = stateDb.getCommandLifecycleByIdempotencyKey(
      input.idempotencyKey,
    );
    if (existing) {
      if (existing.state === "acked") {
        return { allowed: false, reason: "already_acked", requeue: false };
      }
      const updatedAtMs = Date.parse(existing.updatedAt);
      if (
        existing.state === "requeue" &&
        Number.isFinite(updatedAtMs) &&
        Date.now() - updatedAtMs < ACTION_REQUEUE_BACKOFF_MS
      ) {
        return { allowed: false, reason: "requeue_backoff", requeue: true };
      }
      if (
        existing.state === "queued" ||
        existing.state === "context_ready" ||
        existing.state === "llm_running" ||
        existing.state === "action_running"
      ) {
        if (
          Number.isFinite(updatedAtMs) &&
          Date.now() - updatedAtMs <
            ACTION_IDEMPOTENCY_IN_FLIGHT_WINDOW_MS
        ) {
          return { allowed: false, reason: "already_in_flight", requeue: false };
        }
      }
    }
    stateDb.upsertCommandLifecycle({
      commandId: input.command.id,
      directiveId: input.command.sourceDirectiveId ?? input.command.id,
      action: input.action,
      targetPostId: input.target.postId,
      targetCommentId: input.target.commentId,
      targetHash: input.target.targetHash,
      idempotencyKey: input.idempotencyKey,
      state: input.state,
      attemptDelta: 1,
      sourceKind: input.command.kind,
      grantId: input.command.grantId,
      payload: input.command.payload,
    });
    return { allowed: true, reason: existing ? "retry" : "new", requeue: false };
  }

  private updateActionLifecycle(input: {
    command: Command;
    action: "comment" | "like" | "repost";
    idempotencyKey: string;
    target: {
      postId: number;
      commentId: number | null;
      targetHash: string;
    };
    state: CommandLifecycleState;
    lastError?: string | null;
  }): void {
    const stateDb = this.ctx.stateDb;
    if (!stateDb?.enabled) return;
    stateDb.upsertCommandLifecycle({
      commandId: input.command.id,
      directiveId: input.command.sourceDirectiveId ?? input.command.id,
      action: input.action,
      targetPostId: input.target.postId,
      targetCommentId: input.target.commentId,
      targetHash: input.target.targetHash,
      idempotencyKey: input.idempotencyKey,
      state: input.state,
      lastError: input.lastError ?? null,
      sourceKind: input.command.kind,
      grantId: input.command.grantId,
      payload: input.command.payload,
    });
  }

  private ownerCapabilityCooldownKey(input: {
    action: "comment" | "like" | "repost";
    targetHash: string;
  }): string {
    return `${input.action}:${input.targetHash}`;
  }

  private registerOwnerCapabilityCooldown(input: {
    action: "comment" | "like" | "repost";
    targetHash: string;
    reason: string;
  }): void {
    const key = this.ownerCapabilityCooldownKey(input);
    this.ownerCapabilityDeniedByTarget.set(key, {
      untilMs: Date.now() + OWNER_CAPABILITY_COOLDOWN_MS,
      reason: input.reason,
    });
  }

  private resolveOwnerCapabilityCooldown(input: {
    action: "comment" | "like" | "repost";
    targetHash: string;
  }): OwnerCapabilityCooldown | null {
    const key = this.ownerCapabilityCooldownKey(input);
    const entry = this.ownerCapabilityDeniedByTarget.get(key);
    if (!entry) return null;
    if (!Number.isFinite(entry.untilMs) || entry.untilMs <= Date.now()) {
      this.ownerCapabilityDeniedByTarget.delete(key);
      return null;
    }
    return entry;
  }

  private isOwnerCapabilityDeniedError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return /owner capability denied/iu.test(error.message);
  }

  private isNoTargetDiscoveryFailure(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return /engagement_target_unavailable:no_targets_discovered/iu.test(
      error.message,
    );
  }

  private async preflightGrantForAction(input: {
    command: Command;
    payload: Record<string, unknown>;
    action: "comment" | "like" | "repost";
    lifecycle: {
      idempotencyKey: string;
      target: {
        postId: number;
        commentId: number | null;
        targetHash: string;
      };
    };
  }): Promise<string> {
    const ownerCooldown = this.resolveOwnerCapabilityCooldown({
      action: input.action,
      targetHash: input.lifecycle.target.targetHash,
    });
    if (ownerCooldown) {
      const retryInMs = Math.max(0, ownerCooldown.untilMs - Date.now());
      const message = `Owner capability denied: ${ownerCooldown.reason}. retry_in_ms=${retryInMs}`;
      this.updateActionLifecycle({
        command: input.command,
        action: input.action,
        idempotencyKey: input.lifecycle.idempotencyKey,
        target: input.lifecycle.target,
        state: "failed",
        lastError: message,
      });
      throw new Error(message);
    }

    const grantId =
      asNonEmptyString(input.command.grantId) ??
      asNonEmptyString(input.payload.grantId);
    if (grantId) return grantId;

    const hasUsableWindow = this.hasUsablePermissionWindowForAction(
      input.payload.permissionState,
      input.action,
    );
    const reason = hasUsableWindow
      ? "missing_grant_id_with_active_window"
      : "no_grant";
    const errorMessage = `Owner capability denied: ${reason}.`;
    this.updateActionLifecycle({
      command: input.command,
      action: input.action,
      idempotencyKey: input.lifecycle.idempotencyKey,
      target: input.lifecycle.target,
      state: "failed",
      lastError: errorMessage,
    });
    await this.ctx.memory
      .recordWrite({
        type: "directive_preflight_grant_failed",
        at: nowIso(),
        commandId: input.command.id,
        directiveId: input.command.sourceDirectiveId ?? input.command.id,
        action: input.action,
        reason,
        hasUsableWindow,
      })
      .catch(() => undefined);
    throw new Error(errorMessage);
  }

  private extractActionContractFromUnknown(input: {
    value: unknown;
    action: "comment" | "like" | "repost";
    expectedPostId: number;
    expectedCommentId: number | null;
    expectedTargetHash: string;
  }): ActionContract | null {
    const parseFromRecord = (record: Record<string, unknown>): ActionContract | null => {
      const action = asNonEmptyString(record.action)?.toLowerCase() ?? input.action;
      if (action !== input.action) return null;
      if (typeof record.shouldExecute !== "boolean") return null;
      const target = isRecord(record.target) ? record.target : null;
      if (!target) return null;
      const postId = asPositiveInt(target.postId);
      if (postId !== input.expectedPostId) return null;
      const commentId =
        target.commentId === null ? null : asPositiveInt(target.commentId);
      if (commentId !== (input.expectedCommentId ?? null)) return null;
      const targetHashCandidate = asNonEmptyString(target.targetHash);
      if (
        targetHashCandidate !== null &&
        targetHashCandidate !== input.expectedTargetHash
      ) {
        return null;
      }
      const targetHash = targetHashCandidate ?? input.expectedTargetHash;
      const targetLockMatch = isTargetLockMatch({
        payload: {
          targetPostId: postId,
          targetCommentId: commentId,
          targetHash,
        },
        expected: {
          postId: input.expectedPostId,
          commentId: input.expectedCommentId,
          targetHash: input.expectedTargetHash,
        },
      });
      if (!targetLockMatch.ok) return null;
      const reason = truncateText(asNonEmptyString(record.reason) ?? "no_reason", 120);
      const body = asNonEmptyString(record.body);
      if (input.action === "comment" && !body) return null;
      return {
        action: input.action,
        target: {
          postId,
          commentId,
          targetHash,
        },
        body: body ?? null,
        reason,
        shouldExecute: record.shouldExecute,
      };
    };

    if (typeof input.value === "string") {
      const trimmed = input.value.trim();
      if (!trimmed.length) return null;
      const parsed = parseJsonFromMixedText(trimmed);
      if (parsed === null || parsed === input.value) return null;
      return this.extractActionContractFromUnknown({
        ...input,
        value: parsed,
      });
    }
    if (Array.isArray(input.value)) {
      for (const entry of input.value) {
        const parsed = this.extractActionContractFromUnknown({
          ...input,
          value: entry,
        });
        if (parsed) return parsed;
      }
      return null;
    }
    if (!isRecord(input.value)) return null;
    const direct = parseFromRecord(input.value);
    if (direct) return direct;
    for (const key of ["contract", "result", "output", "payload", "data", "content"] as const) {
      const nested = this.extractActionContractFromUnknown({
        ...input,
        value: input.value[key],
      });
      if (nested) return nested;
    }
    return null;
  }

  private async executeWriteCreatePost(command: Command): Promise<CommandOutcome> {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) {
      return this.failedOutcome(command, "Invalid payload for write.createPost.");
    }
    const postTypeRaw = asNonEmptyString(payload.postType)?.toLowerCase();
    const postType = postTypeRaw === "text" ? "text" : "media";
    const kindRaw = asNonEmptyString(payload.kind)?.toLowerCase();
    const postKind = kindRaw === "thread" ? "thread" : "post";
    const provenance = asNonEmptyString(payload.provenance);
    const sourceDirectiveId =
      asNonEmptyString(payload.sourceDirectiveId) ??
      command.sourceDirectiveId ??
      null;
    const sourceDirectiveActionNonce =
      asNonEmptyString(payload.sourceDirectiveActionNonce) ??
      command.actionNonce ??
      null;
    const runtimeOrigin = asNonEmptyString(command.runtimeOrigin)?.toLowerCase() ?? "";
    const isDirectiveRuntimeOrigin =
      runtimeOrigin === "director_directive" || runtimeOrigin === "pending_promotion";
    const buildBase = (
      caption: string | null,
      basePostType: "text" | "media" = postType,
    ): Record<string, unknown> => ({
      kind: postKind,
      postType: basePostType,
      ...(caption ? { caption } : {}),
      ...(provenance ? { provenance } : {}),
      ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
      ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
      ...(command.grantId ? { grantId: command.grantId } : {}),
    });

    const targetPostId = this.extractTargetPostIdForPostDraft(payload);
    const postDraftContext = await this.loadPostDraftContext({
      postId: targetPostId,
      payload,
    });
    const requiresCuration = sourceDirectiveId !== null ? true : isDirectiveRuntimeOrigin;
    const directiveSeedHints = this.collectDirectiveSeedHints(payload);

    if (postType === "text") {
      const textBodyInitial = asNonEmptyString(payload.textBody);
      if (!textBodyInitial) {
        return this.failedOutcome(command, "textBody is required for text posts.");
      }
      const captionInitial = asNonEmptyString(payload.caption);
      const noveltyAvoidReferences = this.snapshotRecentPostNoveltyReferences("text");
      const curatedTextDraft = await this.curatePostDraftWithOpenClaw({
        commandId: command.id,
        postType: "text",
        caption: captionInitial,
        textBody: textBodyInitial,
        mediaPrompt: null,
        context: postDraftContext,
        seedHints: directiveSeedHints,
        avoidReferences: noveltyAvoidReferences,
      });
      if (requiresCuration && !curatedTextDraft) {
        throw new RequeueCommandError(
          "post_curation_waiting_for_openclaw:text_curation_unavailable",
        );
      }
      let captionForWrite = curatedTextDraft?.caption ?? captionInitial;
      let textBodyForWrite = curatedTextDraft?.textBody ?? textBodyInitial;
      captionForWrite = captionForWrite ? stripEmDashCharacters(captionForWrite) : captionForWrite;
      textBodyForWrite = stripEmDashCharacters(textBodyForWrite);
      if (!textBodyForWrite) {
        return this.failedOutcome(command, "textBody is required for text posts.");
      }
      let noveltyValidation = this.validatePostDraftNovelty({
        postType: "text",
        caption: captionForWrite,
        textBody: textBodyForWrite,
        mediaPrompt: null,
        context: postDraftContext,
        seedHints: directiveSeedHints,
      });
      if (!noveltyValidation.ok) {
        await this.ctx.memory
          .recordWrite({
            type: "post_novelty_rejected",
            at: nowIso(),
            commandId: command.id,
            postType: "text",
            reason: noveltyValidation.reason,
            candidatePreview: truncateText(noveltyValidation.candidateText, 240),
            referencePreview: noveltyValidation.referencePreview,
          })
          .catch(() => undefined);
        const recurationReferences = Array.from(
          new Set<string>(
            [
              ...noveltyAvoidReferences,
              noveltyValidation.referencePreview ?? "",
              truncateText(noveltyValidation.candidateText, 260),
            ]
              .map((value) => value.trim())
              .filter((value) => value.length > 0),
          ),
        );
        const recuratedTextDraft = await this.curatePostDraftWithOpenClaw({
          commandId: command.id,
          postType: "text",
          caption: captionForWrite,
          textBody: textBodyForWrite,
          mediaPrompt: null,
          context: postDraftContext,
          seedHints: directiveSeedHints,
          avoidReferences: recurationReferences,
        });
        if (!recuratedTextDraft) {
          if (requiresCuration) {
            throw new RequeueCommandError(
              "post_curation_waiting_for_openclaw:text_novelty_recuration_unavailable",
            );
          }
          return this.failedOutcome(
            command,
            `Blocked text post draft due to low novelty (${noveltyValidation.reason}).`,
            "post_novelty_rejected",
          );
        }
        captionForWrite = recuratedTextDraft.caption ?? captionForWrite;
        textBodyForWrite = recuratedTextDraft.textBody ?? textBodyForWrite;
        captionForWrite = captionForWrite ? stripEmDashCharacters(captionForWrite) : captionForWrite;
        textBodyForWrite = stripEmDashCharacters(textBodyForWrite);
        noveltyValidation = this.validatePostDraftNovelty({
          postType: "text",
          caption: captionForWrite,
          textBody: textBodyForWrite,
          mediaPrompt: null,
          context: postDraftContext,
          seedHints: directiveSeedHints,
        });
        if (!noveltyValidation.ok) {
          await this.ctx.memory
            .recordWrite({
              type: "post_novelty_blocked",
              at: nowIso(),
              commandId: command.id,
              postType: "text",
              reason: noveltyValidation.reason,
              candidatePreview: truncateText(noveltyValidation.candidateText, 240),
              referencePreview: noveltyValidation.referencePreview,
            })
            .catch(() => undefined);
          return this.failedOutcome(
            command,
            `Blocked text post draft due to low novelty (${noveltyValidation.reason}).`,
            "post_novelty_blocked",
          );
        }
        await this.ctx.memory
          .recordWrite({
            type: "post_novelty_recurated",
            at: nowIso(),
            commandId: command.id,
            postType: "text",
          })
          .catch(() => undefined);
      }
      const candidate = noveltyValidation.candidateText;
      const visualPlan = await this.planTextPostVisualWithOpenClaw({
        commandId: command.id,
        caption: captionForWrite,
        textBody: textBodyForWrite,
        context: postDraftContext,
      });
      const captionPositionForWrite =
        this.normalizeCaptionPositionValue(payload.captionPosition) ??
        visualPlan?.captionPosition ??
        null;
      const normalizedTextStyle = this.normalizeAgentTextStyle(
        this.sanitizeTextStyleValue(payload.textStyle) ?? visualPlan?.textStyle ?? null,
        captionPositionForWrite,
      );
      const planWantsSlides =
        visualPlan?.renderMode === "slides" && visualPlan.slides.length >= 2;
      const visualBackgroundPrompt = visualPlan?.backgroundImagePrompt
        ? stripEmDashCharacters(visualPlan.backgroundImagePrompt).trim()
        : "";
      const planWantsImageBackground =
        !planWantsSlides && visualBackgroundPrompt.length >= 8;
      if (planWantsSlides) {
        const slideItems: Array<Record<string, unknown>> = [];
        const slidePrompts = visualPlan.slides.slice(0, 4);
        for (const slide of slidePrompts) {
          const slidePrompt = stripEmDashCharacters(slide.imagePrompt).trim();
          if (slidePrompt.length < 8) continue;
          const slideMedia = await this.resolveMediaUpload({
            payload: {
              ...payload,
              generatedAssetType: "image",
            },
            keepOriginal: true,
            promptFallbacks: [slidePrompt],
            command,
          });
          slideItems.push({
            mediaUrl: slideMedia.mediaUrl,
            ...(slideMedia.mediaOriginalUrl
              ? { mediaOriginalUrl: slideMedia.mediaOriginalUrl }
              : {}),
            ...(slideMedia.mediaOptimizedUrl
              ? { mediaOptimizedUrl: slideMedia.mediaOptimizedUrl }
              : {}),
            ...(slideMedia.mediaContentHash
              ? { mediaContentHash: slideMedia.mediaContentHash }
              : {}),
            ...(slideMedia.mediaIpfsCid
              ? { mediaIpfsCid: slideMedia.mediaIpfsCid }
              : {}),
            ...(typeof slideMedia.mediaSizeBytes === "number"
              ? { mediaSizeBytes: slideMedia.mediaSizeBytes }
              : {}),
            ...(slideMedia.mediaType ? { mediaType: slideMedia.mediaType } : {}),
            ...(slide.caption ? { caption: slide.caption } : {}),
            ...(captionPositionForWrite
              ? { captionPosition: captionPositionForWrite }
              : {}),
          });
        }
        if (slideItems.length >= 2) {
          const firstSlide = slideItems[0] ?? {};
          const firstSlideMediaUrl = asNonEmptyString(firstSlide.mediaUrl);
          if (firstSlideMediaUrl) {
            const slideResult = await this.agent().createPost.mutate({
              ...buildBase(captionForWrite, "media"),
              mediaUrl: firstSlideMediaUrl,
              ...(asNonEmptyString(firstSlide.mediaOriginalUrl)
                ? { mediaOriginalUrl: asNonEmptyString(firstSlide.mediaOriginalUrl) }
                : {}),
              ...(asNonEmptyString(firstSlide.mediaOptimizedUrl)
                ? { mediaOptimizedUrl: asNonEmptyString(firstSlide.mediaOptimizedUrl) }
                : {}),
              ...(asNonEmptyString(firstSlide.mediaContentHash)
                ? { mediaContentHash: asNonEmptyString(firstSlide.mediaContentHash) }
                : {}),
              ...(asNonEmptyString(firstSlide.mediaIpfsCid)
                ? { mediaIpfsCid: asNonEmptyString(firstSlide.mediaIpfsCid) }
                : {}),
              ...(typeof firstSlide.mediaSizeBytes === "number" &&
              Number.isFinite(firstSlide.mediaSizeBytes)
                ? {
                    mediaSizeBytes: Math.max(
                      1,
                      Math.floor(firstSlide.mediaSizeBytes),
                    ),
                  }
                : {}),
              ...(asNonEmptyString(firstSlide.mediaType)
                ? { mediaType: asNonEmptyString(firstSlide.mediaType) }
                : {}),
              mediaItems: slideItems,
              ...(captionPositionForWrite
                ? { captionPosition: captionPositionForWrite }
                : {}),
            });
            this.notePublishedPostForNoveltyHistory({
              postType: "media",
              caption: captionForWrite,
              textBody: null,
              mediaPrompt: slidePrompts
                .map((entry) => entry.imagePrompt)
                .join(" | "),
              commandId: command.id,
              targetPostId: postDraftContext.targetPostId,
            });
            await this.ctx.memory
              .recordWrite({
                type: "runtime_post_publish_recorded",
                at: nowIso(),
                commandId: command.id,
                kind: postKind,
                postType: "media",
                targetPostId: postDraftContext.targetPostId,
                bodyPreview: truncateText(candidate, 260),
                visualRenderMode: "slides",
                slideCount: slideItems.length,
              })
              .catch(() => undefined);
            return this.successOutcome(command, slideResult);
          }
        }
      }

      if (planWantsImageBackground) {
        try {
          const backgroundMedia = await this.resolveMediaUpload({
            payload: {
              ...payload,
              generatedAssetType: "image",
            },
            keepOriginal: true,
            promptFallbacks: [visualBackgroundPrompt],
            command,
          });
          const imageTextItem: Record<string, unknown> = {
            mediaUrl: backgroundMedia.mediaUrl,
            ...(backgroundMedia.mediaOriginalUrl
              ? { mediaOriginalUrl: backgroundMedia.mediaOriginalUrl }
              : {}),
            ...(backgroundMedia.mediaOptimizedUrl
              ? { mediaOptimizedUrl: backgroundMedia.mediaOptimizedUrl }
              : {}),
            ...(backgroundMedia.mediaContentHash
              ? { mediaContentHash: backgroundMedia.mediaContentHash }
              : {}),
            ...(backgroundMedia.mediaIpfsCid
              ? { mediaIpfsCid: backgroundMedia.mediaIpfsCid }
              : {}),
            ...(typeof backgroundMedia.mediaSizeBytes === "number"
              ? { mediaSizeBytes: backgroundMedia.mediaSizeBytes }
              : {}),
            ...(backgroundMedia.mediaType
              ? { mediaType: backgroundMedia.mediaType }
              : {}),
            caption: textBodyForWrite,
            ...(captionPositionForWrite
              ? { captionPosition: captionPositionForWrite }
              : {}),
          };
          const imageTextResult = await this.agent().createPost.mutate({
            ...buildBase(captionForWrite, "media"),
            mediaUrl: backgroundMedia.mediaUrl,
            ...(backgroundMedia.mediaOriginalUrl
              ? { mediaOriginalUrl: backgroundMedia.mediaOriginalUrl }
              : {}),
            ...(backgroundMedia.mediaOptimizedUrl
              ? { mediaOptimizedUrl: backgroundMedia.mediaOptimizedUrl }
              : {}),
            ...(backgroundMedia.mediaContentHash
              ? { mediaContentHash: backgroundMedia.mediaContentHash }
              : {}),
            ...(backgroundMedia.mediaIpfsCid
              ? { mediaIpfsCid: backgroundMedia.mediaIpfsCid }
              : {}),
            ...(typeof backgroundMedia.mediaSizeBytes === "number" &&
            Number.isFinite(backgroundMedia.mediaSizeBytes)
              ? {
                  mediaSizeBytes: Math.max(
                    1,
                    Math.floor(backgroundMedia.mediaSizeBytes),
                  ),
                }
              : {}),
            ...(backgroundMedia.mediaType
              ? { mediaType: backgroundMedia.mediaType }
              : {}),
            mediaItems: [imageTextItem],
            ...(captionPositionForWrite
              ? { captionPosition: captionPositionForWrite }
              : {}),
          });
          this.notePublishedPostForNoveltyHistory({
            postType: "media",
            caption: captionForWrite,
            textBody: null,
            mediaPrompt: visualBackgroundPrompt,
            commandId: command.id,
            targetPostId: postDraftContext.targetPostId,
          });
          await this.ctx.memory
            .recordWrite({
              type: "runtime_post_publish_recorded",
              at: nowIso(),
              commandId: command.id,
              kind: postKind,
              postType: "media",
              targetPostId: postDraftContext.targetPostId,
              bodyPreview: truncateText(candidate, 260),
              visualRenderMode: "image_text",
            })
            .catch(() => undefined);
          return this.successOutcome(command, imageTextResult);
        } catch (error: unknown) {
          await this.ctx.memory
            .recordWrite({
              type: "text_post_visual_background_failed",
              at: nowIso(),
              commandId: command.id,
              error: error instanceof Error ? error.message : String(error),
            })
            .catch(() => undefined);
        }
      }

      const result = await this.agent().createPost.mutate({
        ...buildBase(captionForWrite, "text"),
        textBody: textBodyForWrite,
        textStyle: normalizedTextStyle,
        ...(captionPositionForWrite ? { captionPosition: captionPositionForWrite } : {}),
      });
      this.notePublishedPostForNoveltyHistory({
        postType: "text",
        caption: captionForWrite,
        textBody: textBodyForWrite,
        mediaPrompt: null,
        commandId: command.id,
        targetPostId: postDraftContext.targetPostId,
      });
      await this.ctx.memory
        .recordWrite({
          type: "runtime_post_publish_recorded",
          at: nowIso(),
          commandId: command.id,
          kind: postKind,
          postType,
          targetPostId: postDraftContext.targetPostId,
          bodyPreview: truncateText(candidate, 260),
          visualRenderMode: planWantsSlides
            ? "text_fallback"
            : planWantsImageBackground
              ? "text_after_image_background_fallback"
              : "text",
          textStyleTheme: asNonEmptyString(normalizedTextStyle.theme),
          captionPosition: captionPositionForWrite,
        })
        .catch(() => undefined);
      return this.successOutcome(command, result);
    }

    const captionInitial = asNonEmptyString(payload.caption);
    const mediaPromptInitial =
      asNonEmptyString(payload.mediaPrompt) ??
      asNonEmptyString(payload.imagePrompt) ??
      asNonEmptyString(payload.prompt);
    const noveltyAvoidReferences = this.snapshotRecentPostNoveltyReferences("media");
    const curatedMediaDraft = await this.curatePostDraftWithOpenClaw({
      commandId: command.id,
      postType: "media",
      caption: captionInitial,
      textBody: null,
      mediaPrompt: mediaPromptInitial,
      context: postDraftContext,
      seedHints: directiveSeedHints,
      avoidReferences: noveltyAvoidReferences,
    });
    if (requiresCuration && !curatedMediaDraft) {
      throw new RequeueCommandError(
        "post_curation_waiting_for_openclaw:media_curation_unavailable",
      );
    }
    let captionForWrite = curatedMediaDraft?.caption ?? captionInitial;
    let mediaPromptForWrite = curatedMediaDraft?.mediaPrompt ?? mediaPromptInitial;
    captionForWrite = captionForWrite ? stripEmDashCharacters(captionForWrite) : captionForWrite;
    mediaPromptForWrite = mediaPromptForWrite
      ? stripEmDashCharacters(mediaPromptForWrite)
      : mediaPromptForWrite;
    let noveltyValidation = this.validatePostDraftNovelty({
      postType: "media",
      caption: captionForWrite,
      textBody: null,
      mediaPrompt: mediaPromptForWrite,
      context: postDraftContext,
      seedHints: directiveSeedHints,
    });
    if (!noveltyValidation.ok) {
      await this.ctx.memory
        .recordWrite({
          type: "post_novelty_rejected",
          at: nowIso(),
          commandId: command.id,
          postType: "media",
          reason: noveltyValidation.reason,
          candidatePreview: truncateText(noveltyValidation.candidateText, 240),
          referencePreview: noveltyValidation.referencePreview,
        })
        .catch(() => undefined);
      const recurationReferences = Array.from(
        new Set<string>(
          [
            ...noveltyAvoidReferences,
            noveltyValidation.referencePreview ?? "",
            truncateText(noveltyValidation.candidateText, 260),
          ]
            .map((value) => value.trim())
            .filter((value) => value.length > 0),
        ),
      );
      const recuratedMediaDraft = await this.curatePostDraftWithOpenClaw({
        commandId: command.id,
        postType: "media",
        caption: captionForWrite,
        textBody: null,
        mediaPrompt: mediaPromptForWrite,
        context: postDraftContext,
        seedHints: directiveSeedHints,
        avoidReferences: recurationReferences,
      });
      if (!recuratedMediaDraft) {
        if (requiresCuration) {
          throw new RequeueCommandError(
            "post_curation_waiting_for_openclaw:media_novelty_recuration_unavailable",
          );
        }
        return this.failedOutcome(
          command,
          `Blocked media post draft due to low novelty (${noveltyValidation.reason}).`,
          "post_novelty_rejected",
        );
      }
      captionForWrite = recuratedMediaDraft.caption ?? captionForWrite;
      mediaPromptForWrite = recuratedMediaDraft.mediaPrompt ?? mediaPromptForWrite;
      captionForWrite = captionForWrite ? stripEmDashCharacters(captionForWrite) : captionForWrite;
      mediaPromptForWrite = mediaPromptForWrite
        ? stripEmDashCharacters(mediaPromptForWrite)
        : mediaPromptForWrite;
      noveltyValidation = this.validatePostDraftNovelty({
        postType: "media",
        caption: captionForWrite,
        textBody: null,
        mediaPrompt: mediaPromptForWrite,
        context: postDraftContext,
        seedHints: directiveSeedHints,
      });
      if (!noveltyValidation.ok) {
        await this.ctx.memory
          .recordWrite({
            type: "post_novelty_blocked",
            at: nowIso(),
            commandId: command.id,
            postType: "media",
            reason: noveltyValidation.reason,
            candidatePreview: truncateText(noveltyValidation.candidateText, 240),
            referencePreview: noveltyValidation.referencePreview,
          })
          .catch(() => undefined);
        return this.failedOutcome(
          command,
          `Blocked media post draft due to low novelty (${noveltyValidation.reason}).`,
          "post_novelty_blocked",
        );
      }
      await this.ctx.memory
        .recordWrite({
          type: "post_novelty_recurated",
          at: nowIso(),
          commandId: command.id,
          postType: "media",
        })
        .catch(() => undefined);
    }
    const payloadForMedia: Record<string, unknown> = {
      ...payload,
      ...(captionForWrite ? { caption: captionForWrite } : {}),
      ...(mediaPromptForWrite
        ? {
            mediaPrompt: mediaPromptForWrite,
            imagePrompt: mediaPromptForWrite,
            prompt: mediaPromptForWrite,
          }
        : {}),
    };
    const media = await this.resolveMediaUpload({
      payload: payloadForMedia,
      keepOriginal: true,
      promptFallbacks: [
        mediaPromptForWrite,
        asNonEmptyString(payload.prompt),
      ],
      command,
    });
    const mediaCandidate = noveltyValidation.candidateText;
    const result = await this.agent().createPost.mutate({
      ...buildBase(captionForWrite),
      mediaUrl: media.mediaUrl,
      ...(media.mediaOriginalUrl ? { mediaOriginalUrl: media.mediaOriginalUrl } : {}),
      ...(media.mediaOptimizedUrl ? { mediaOptimizedUrl: media.mediaOptimizedUrl } : {}),
      ...(media.mediaContentHash ? { mediaContentHash: media.mediaContentHash } : {}),
      ...(media.mediaIpfsCid ? { mediaIpfsCid: media.mediaIpfsCid } : {}),
      ...(typeof media.mediaSizeBytes === "number" ? { mediaSizeBytes: media.mediaSizeBytes } : {}),
      ...(media.mediaType ? { mediaType: media.mediaType } : {}),
    });
    this.notePublishedPostForNoveltyHistory({
      postType: "media",
      caption: captionForWrite,
      textBody: null,
      mediaPrompt: mediaPromptForWrite,
      commandId: command.id,
      targetPostId: postDraftContext.targetPostId,
    });
    await this.ctx.memory
      .recordWrite({
        type: "runtime_post_publish_recorded",
        at: nowIso(),
        commandId: command.id,
        kind: postKind,
        postType,
        targetPostId: postDraftContext.targetPostId,
        bodyPreview: truncateText(mediaCandidate, 260),
        mediaUrl: media.mediaUrl,
      })
      .catch(() => undefined);
    return this.successOutcome(command, result);
  }

  private extractTargetPostIdForPostDraft(payload: Record<string, unknown>): number | null {
    const directPostId = asPositiveInt(payload.postId);
    if (directPostId) return directPostId;
    const targetPostId = asPositiveInt(payload.targetPostId);
    if (targetPostId) return targetPostId;
    const scope = isRecord(payload.directiveScope) ? payload.directiveScope : null;
    if (scope) {
      const scopedPostId = asPositiveInt(scope.targetPostId);
      if (scopedPostId) return scopedPostId;
      const scopedPost = isRecord(scope.target) ? scope.target : null;
      if (scopedPost) {
        const nestedPostId = asPositiveInt(scopedPost.postId);
        if (nestedPostId) return nestedPostId;
      }
    }
    return null;
  }

  private async loadPostDraftContext(input: {
    postId: number | null;
    payload: Record<string, unknown>;
  }): Promise<PostDraftContext> {
    const context: PostDraftContext = {
      targetPostId: input.postId,
      postText: null,
      mediaSummary: null,
      commentSummary: null,
      payloadHint: this.extractCommentPayloadHint(input.payload),
      memorySummary: await this.loadPostDraftMemorySummary({
        postId: input.postId,
        payload: input.payload,
      }),
    };
    if (!input.postId) return context;
    const callAgentChatBridge = this.ctx.callAgentChatBridge;
    if (!callAgentChatBridge) return context;
    try {
      const postResponse = await callAgentChatBridge({
        action: "find_post",
        postId: input.postId,
      });
      const postRecord = this.extractPostRecordForCommentCuration(postResponse, input.postId);
      if (!postRecord) return context;
      context.postText =
        asNonEmptyString(postRecord.textBody) ??
        asNonEmptyString(postRecord.caption) ??
        asNonEmptyString(postRecord.body);
      context.mediaSummary = this.summarizePostMediaForComment(postRecord);
      try {
        const commentResponse = await callAgentChatBridge({
          action: "find_comment",
          postId: input.postId,
        });
        context.commentSummary = this.summarizeCommentsForPostDraft(commentResponse);
      } catch (error: unknown) {
        await this.ctx.memory
          .recordWrite({
            type: "post_context_comments_lookup_failed",
            at: nowIso(),
            postId: input.postId,
            error: error instanceof Error ? error.message : String(error),
          })
          .catch(() => undefined);
      }
      return context;
    } catch (error: unknown) {
      await this.ctx.memory
        .recordWrite({
          type: "post_context_lookup_failed",
          at: nowIso(),
          postId: input.postId,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      return context;
    }
  }

  private async loadPostDraftMemorySummary(input: {
    postId: number | null;
    payload: Record<string, unknown>;
  }): Promise<string | null> {
    if (typeof this.ctx.memory.buildContext !== "function") {
      return null;
    }
    try {
      const payloadHint = this.extractCommentPayloadHint(input.payload);
      const retrievalQuery = [
        "post draft context",
        typeof input.postId === "number" ? `post ${input.postId}` : "",
        payloadHint ? `hint ${payloadHint}` : "",
      ]
        .filter((value) => value.length > 0)
        .join(" · ");
      const request: ContextRequest = {
        mode: "directive",
        audience: "runtime_write",
        ...(typeof input.postId === "number" ? { postId: input.postId } : {}),
        maxRecentEvents: 120,
        maxArchiveEvents: 40,
        includeViewState: true,
        viewStateMaxItems: 10,
        includeKeywordRetrieval: true,
        retrievalIntent: "directive",
        retrievalMaxItems: 10,
        retrievalQuery,
      };
      const bundle = await this.ctx.memory.buildContext(request);
      return this.buildCompactEngagementMemorySummary(bundle);
    } catch (error: unknown) {
      await this.ctx.memory
        .recordWrite({
          type: "post_memory_context_failed",
          at: nowIso(),
          postId: input.postId,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      return null;
    }
  }

  private buildPostNoveltyCandidateText(input: {
    postType: "text" | "media";
    caption: string | null;
    textBody: string | null;
    mediaPrompt: string | null;
  }): string {
    if (input.postType === "text") {
      return [input.caption ?? "", input.textBody ?? ""]
        .filter((value) => value.trim().length > 0)
        .join("\n")
        .trim();
    }
    return [input.caption ?? "", input.mediaPrompt ?? ""]
      .filter((value) => value.trim().length > 0)
      .join("\n")
      .trim();
  }

  private pruneRecentPostNoveltyHistory(nowMs: number): void {
    let writeIndex = 0;
    for (const entry of this.recentPostNoveltyHistory) {
      if (nowMs - entry.atMs > POST_NOVELTY_HISTORY_WINDOW_MS) continue;
      this.recentPostNoveltyHistory[writeIndex] = entry;
      writeIndex += 1;
    }
    this.recentPostNoveltyHistory.length = writeIndex;
    if (this.recentPostNoveltyHistory.length <= POST_NOVELTY_HISTORY_MAX_ITEMS) {
      return;
    }
    const trimStart = this.recentPostNoveltyHistory.length - POST_NOVELTY_HISTORY_MAX_ITEMS;
    this.recentPostNoveltyHistory.splice(0, trimStart);
  }

  private snapshotRecentPostNoveltyReferences(postType: "text" | "media"): string[] {
    const nowMs = Date.now();
    this.pruneRecentPostNoveltyHistory(nowMs);
    const references: string[] = [];
    const seen = new Set<string>();
    for (let index = this.recentPostNoveltyHistory.length - 1; index >= 0; index -= 1) {
      const entry = this.recentPostNoveltyHistory[index];
      if (!entry) continue;
      if (entry.postType !== postType) continue;
      if (seen.has(entry.normalized)) continue;
      seen.add(entry.normalized);
      references.push(entry.text);
      if (references.length >= POST_NOVELTY_MAX_AVOID_REFERENCES) break;
    }
    return references;
  }

  private computeBidirectionalTokenOverlap(first: string, second: string): number {
    return Math.max(
      computeTokenOverlapRatio(first, second),
      computeTokenOverlapRatio(second, first),
    );
  }

  private validatePostDraftNovelty(input: {
    postType: "text" | "media";
    caption: string | null;
    textBody: string | null;
    mediaPrompt: string | null;
    context: PostDraftContext;
    seedHints: string[];
  }):
    | { ok: true; candidateText: string }
    | { ok: false; reason: string; candidateText: string; referencePreview: string | null } {
    const candidateText = this.buildPostNoveltyCandidateText({
      postType: input.postType,
      caption: input.caption,
      textBody: input.textBody,
      mediaPrompt: input.mediaPrompt,
    });
    if (candidateText.length < 12) {
      return {
        ok: false,
        reason: "candidate_too_short",
        candidateText,
        referencePreview: null,
      };
    }
    if (
      input.postType === "media" &&
      input.mediaPrompt &&
      COMMENT_PROMPT_WRAPPER_PATTERN.test(input.mediaPrompt)
    ) {
      return {
        ok: false,
        reason: "media_prompt_wrapper",
        candidateText,
        referencePreview: input.mediaPrompt,
      };
    }
    const normalizedCandidate = normalizeCommentText(candidateText);
    if (!normalizedCandidate.length) {
      return {
        ok: false,
        reason: "candidate_empty_after_normalization",
        candidateText,
        referencePreview: null,
      };
    }
    const compareAgainstReference = (
      reference: string,
      threshold: number,
      reasonPrefix: string,
    ): { ok: true } | { ok: false; reason: string; referencePreview: string } => {
      const trimmedReference = reference.trim();
      if (trimmedReference.length < 12) return { ok: true };
      const normalizedReference = normalizeCommentText(trimmedReference);
      if (!normalizedReference.length) return { ok: true };
      if (normalizedCandidate === normalizedReference) {
        return { ok: false, reason: `same_as_${reasonPrefix}`, referencePreview: trimmedReference };
      }
      const overlap = this.computeBidirectionalTokenOverlap(candidateText, trimmedReference);
      if (overlap >= threshold) {
        return {
          ok: false,
          reason: `too_similar_to_${reasonPrefix}`,
          referencePreview: trimmedReference,
        };
      }
      if (
        hasLongNormalizedPhraseOverlap(candidateText, trimmedReference) &&
        overlap >= Math.max(0.42, threshold - 0.24)
      ) {
        return {
          ok: false,
          reason: `contains_${reasonPrefix}_phrase`,
          referencePreview: trimmedReference,
        };
      }
      return { ok: true };
    };

    const contextReferences = [
      input.context.postText,
      input.context.mediaSummary,
      input.context.commentSummary,
      input.context.payloadHint,
    ].filter((value): value is string => typeof value === "string" && value.trim().length >= 12);
    const contextThreshold = input.postType === "media" ? 0.72 : 0.78;
    for (const reference of contextReferences) {
      const check = compareAgainstReference(reference, contextThreshold, "target_context");
      if (!check.ok) {
        return {
          ok: false,
          reason: check.reason,
          candidateText,
          referencePreview: truncateText(check.referencePreview, 240),
        };
      }
    }

    const seedThreshold = input.postType === "media" ? 0.74 : 0.8;
    for (const seed of input.seedHints) {
      const check = compareAgainstReference(seed, seedThreshold, "directive_seed");
      if (!check.ok) {
        return {
          ok: false,
          reason: check.reason,
          candidateText,
          referencePreview: truncateText(check.referencePreview, 240),
        };
      }
    }

    const nowMs = Date.now();
    this.pruneRecentPostNoveltyHistory(nowMs);
    const historyThreshold = input.postType === "media" ? 0.68 : 0.76;
    for (let index = this.recentPostNoveltyHistory.length - 1; index >= 0; index -= 1) {
      const entry = this.recentPostNoveltyHistory[index];
      if (!entry) continue;
      if (entry.postType !== input.postType) continue;
      if (entry.normalized === normalizedCandidate) {
        return {
          ok: false,
          reason: "same_as_recent_self_post",
          candidateText,
          referencePreview: truncateText(entry.text, 240),
        };
      }
      const overlap = this.computeBidirectionalTokenOverlap(candidateText, entry.text);
      if (overlap >= historyThreshold) {
        return {
          ok: false,
          reason: "too_similar_to_recent_self_post",
          candidateText,
          referencePreview: truncateText(entry.text, 240),
        };
      }
      if (
        hasLongNormalizedPhraseOverlap(candidateText, entry.text) &&
        overlap >= Math.max(0.4, historyThreshold - 0.24)
      ) {
        return {
          ok: false,
          reason: "contains_recent_self_phrase",
          candidateText,
          referencePreview: truncateText(entry.text, 240),
        };
      }
    }
    return { ok: true, candidateText };
  }

  private notePublishedPostForNoveltyHistory(input: {
    postType: "text" | "media";
    caption: string | null;
    textBody: string | null;
    mediaPrompt: string | null;
    commandId: string;
    targetPostId: number | null;
  }): void {
    const text = this.buildPostNoveltyCandidateText({
      postType: input.postType,
      caption: input.caption,
      textBody: input.textBody,
      mediaPrompt: input.mediaPrompt,
    });
    if (text.length < 12) return;
    const normalized = normalizeCommentText(text);
    if (!normalized.length) return;
    const nowMs = Date.now();
    this.pruneRecentPostNoveltyHistory(nowMs);
    for (let index = this.recentPostNoveltyHistory.length - 1; index >= 0; index -= 1) {
      const entry = this.recentPostNoveltyHistory[index];
      if (!entry) continue;
      if (entry.normalized !== normalized) continue;
      this.recentPostNoveltyHistory.splice(index, 1);
    }
    this.recentPostNoveltyHistory.push({
      atMs: nowMs,
      postType: input.postType,
      text,
      normalized,
      commandId: input.commandId,
      targetPostId: input.targetPostId,
    });
    this.pruneRecentPostNoveltyHistory(nowMs);
  }

  private normalizeCaptionPositionValue(value: unknown): string | null {
    const raw = asNonEmptyString(value)?.toLowerCase() ?? null;
    if (!raw) return null;
    return CAPTION_POSITION_KEYS.has(raw) ? raw : null;
  }

  private sanitizeTextStyleValue(value: unknown): Record<string, unknown> | null {
    if (!isRecord(value)) return null;
    const style: Record<string, unknown> = {};
    const setEnum = (
      key: string,
      allowed: Set<string>,
      candidate: unknown,
    ): void => {
      const normalized = asNonEmptyString(candidate)?.toLowerCase() ?? null;
      if (!normalized || !allowed.has(normalized)) return;
      style[key] = normalized;
    };
    setEnum("theme", TEXT_STYLE_THEME_KEYS, value.theme);
    setEnum("align", TEXT_STYLE_ALIGN_KEYS, value.align);
    setEnum("emphasis", TEXT_STYLE_EMPHASIS_KEYS, value.emphasis);
    setEnum("font", TEXT_STYLE_FONT_KEYS, value.font);
    setEnum("weight", TEXT_STYLE_WEIGHT_KEYS, value.weight);
    setEnum("size", TEXT_STYLE_SIZE_KEYS, value.size);
    setEnum("color", TEXT_STYLE_COLOR_KEYS, value.color);
    const position = this.normalizeCaptionPositionValue(value.position);
    if (position) style.position = position;
    if (typeof value.italic === "boolean") {
      style.italic = value.italic;
    }
    const background = asNonEmptyString(value.background);
    if (background && background.length <= 180) {
      style.background = stripEmDashCharacters(background);
    }
    return Object.keys(style).length > 0 ? style : null;
  }

  private normalizeAgentTextStyle(
    style: Record<string, unknown> | null,
    captionPosition: string | null,
  ): Record<string, unknown> {
    const normalizeTheme = (value: unknown): string | null => {
      const raw = asNonEmptyString(value)?.toLowerCase() ?? null;
      if (!raw) return null;
      if (raw === "ocean") return "cool";
      if (raw === "plum") return "night";
      if (raw === "sand") return "warm";
      return ["warm", "cool", "night", "sunrise", "mint"].includes(raw)
        ? raw
        : null;
    };
    const normalizeAlign = (value: unknown): string | null => {
      const raw = asNonEmptyString(value)?.toLowerCase() ?? null;
      if (raw && ["left", "center", "right"].includes(raw)) return raw;
      if (captionPosition) {
        const alignFromPosition = captionPosition.split("-")[1] ?? null;
        if (
          alignFromPosition &&
          ["left", "center", "right"].includes(alignFromPosition)
        ) {
          return alignFromPosition;
        }
      }
      return null;
    };
    const normalizeEmphasis = (value: unknown): string | null => {
      const raw = asNonEmptyString(value)?.toLowerCase() ?? null;
      if (!raw) return null;
      if (raw === "mono") return "serif";
      if (raw === "display") return "bold";
      return ["soft", "bold", "serif"].includes(raw) ? raw : null;
    };
    const normalizeFont = (value: unknown): string | null => {
      const raw = asNonEmptyString(value)?.toLowerCase() ?? null;
      if (!raw || !TEXT_STYLE_FONT_KEYS.has(raw)) return null;
      return raw;
    };
    const normalizeWeight = (value: unknown): string | null => {
      const raw = asNonEmptyString(value)?.toLowerCase() ?? null;
      if (!raw || !TEXT_STYLE_WEIGHT_KEYS.has(raw)) return null;
      return raw;
    };
    const normalizeSize = (value: unknown): string | null => {
      const raw = asNonEmptyString(value)?.toLowerCase() ?? null;
      if (!raw || !TEXT_STYLE_SIZE_KEYS.has(raw)) return null;
      return raw;
    };
    const normalizeColor = (value: unknown): string | null => {
      const raw = asNonEmptyString(value)?.toLowerCase() ?? null;
      if (!raw || !TEXT_STYLE_COLOR_KEYS.has(raw)) return null;
      return raw;
    };
    const normalizePosition = (value: unknown): string | null => {
      const raw = this.normalizeCaptionPositionValue(value);
      if (raw) return raw;
      return captionPosition;
    };
    const normalized: Record<string, unknown> = {};
    const theme = normalizeTheme(style?.theme);
    const align = normalizeAlign(style?.align);
    const emphasis = normalizeEmphasis(style?.emphasis);
    const font = normalizeFont(style?.font);
    const weight = normalizeWeight(style?.weight);
    const size = normalizeSize(style?.size);
    const color = normalizeColor(style?.color);
    const position = normalizePosition(style?.position);
    const background = asNonEmptyString(style?.background);
    if (theme) normalized.theme = theme;
    if (align) normalized.align = align;
    if (emphasis) normalized.emphasis = emphasis;
    if (font) normalized.font = font;
    if (weight) normalized.weight = weight;
    if (typeof style?.italic === "boolean") normalized.italic = style.italic;
    if (size) normalized.size = size;
    if (color) normalized.color = color;
    if (position) normalized.position = position;
    if (background && background.length <= 180) {
      normalized.background = stripEmDashCharacters(background);
    }
    if (Object.keys(normalized).length === 0) {
      return {
        theme: "warm",
        align: "center",
        emphasis: "soft",
      };
    }
    return normalized;
  }

  private extractTextPostVisualPlanFromUnknown(value: unknown): TextPostVisualPlan | null {
    const fromString = (raw: string): TextPostVisualPlan | null => {
      const trimmed = raw.trim();
      if (!trimmed.length) return null;
      const parsed = parseJsonFromMixedText(trimmed);
      if (parsed !== null && parsed !== raw) {
        return this.extractTextPostVisualPlanFromUnknown(parsed);
      }
      return null;
    };
    if (typeof value === "string") return fromString(value);
    if (Array.isArray(value)) {
      for (const entry of value) {
        const parsed = this.extractTextPostVisualPlanFromUnknown(entry);
        if (parsed) return parsed;
      }
      return null;
    }
    if (!isRecord(value)) return null;
    const nestedKeys = [
      "result",
      "payload",
      "data",
      "content",
      "output",
      "draft",
    ] as const;
    for (const key of nestedKeys) {
      const nested = this.extractTextPostVisualPlanFromUnknown(value[key]);
      if (nested) return nested;
    }

    const renderModeRaw =
      asNonEmptyString(value.renderMode) ??
      asNonEmptyString(value.mode) ??
      asNonEmptyString(value.layout) ??
      null;
    const renderMode =
      renderModeRaw && /(slides|carousel|deck|storyboard)/iu.test(renderModeRaw)
        ? "slides"
        : "text";
    const captionPosition =
      this.normalizeCaptionPositionValue(value.captionPosition) ??
      this.normalizeCaptionPositionValue(value.position);
    const textStyle =
      this.sanitizeTextStyleValue(value.textStyle) ??
      this.sanitizeTextStyleValue(value.style);
    const backgroundImagePrompt = (() => {
      const prompt =
        asNonEmptyString(value.backgroundImagePrompt) ??
        asNonEmptyString(value.textBackgroundPrompt) ??
        asNonEmptyString(value.backgroundPrompt) ??
        null;
      if (!prompt) return null;
      const cleaned = stripEmDashCharacters(prompt).trim();
      return cleaned.length > 0 ? truncateText(cleaned, 220) : null;
    })();

    const rawSlides = Array.isArray(value.slides)
      ? value.slides
      : Array.isArray(value.mediaItems)
        ? value.mediaItems
        : Array.isArray(value.items)
          ? value.items
          : [];
    const slides: TextPostVisualSlide[] = [];
    for (const rawSlide of rawSlides) {
      if (!isRecord(rawSlide)) continue;
      const imagePrompt =
        asNonEmptyString(rawSlide.imagePrompt) ??
        asNonEmptyString(rawSlide.prompt) ??
        asNonEmptyString(rawSlide.mediaPrompt) ??
        null;
      if (!imagePrompt) continue;
      const normalizedPrompt = stripEmDashCharacters(imagePrompt).trim();
      if (normalizedPrompt.length < 8) continue;
      const caption =
        asNonEmptyString(rawSlide.caption) ??
        asNonEmptyString(rawSlide.text) ??
        null;
      slides.push({
        caption: caption ? truncateText(stripEmDashCharacters(caption), 2200) : null,
        imagePrompt: truncateText(normalizedPrompt, 320),
      });
      if (slides.length >= 6) break;
    }

    if (
      renderMode === "text" &&
      captionPosition === null &&
      textStyle === null &&
      backgroundImagePrompt === null &&
      slides.length === 0
    ) {
      return null;
    }
    return {
      renderMode: renderMode === "slides" && slides.length >= 2 ? "slides" : "text",
      captionPosition,
      textStyle,
      backgroundImagePrompt,
      slides: slides.slice(0, 4),
    };
  }

  private buildTextPostVisualPlanPrompt(input: {
    caption: string | null;
    textBody: string;
    context: PostDraftContext;
  }): string {
    const contextLines = [
      typeof input.context.targetPostId === "number"
        ? `targetPostId: ${input.context.targetPostId}`
        : null,
      input.context.postText ? `targetPostText: ${input.context.postText}` : null,
      input.context.mediaSummary ? `targetMedia: ${input.context.mediaSummary}` : null,
      input.context.commentSummary ? `targetComments: ${input.context.commentSummary}` : null,
      input.context.payloadHint ? `directiveHint: ${input.context.payloadHint}` : null,
      input.context.memorySummary ? `memoryContext: ${input.context.memorySummary}` : null,
    ].filter((entry): entry is string => Boolean(entry));
    return [
      "Plan visual presentation for this social post. Return strict JSON only.",
      "Shape:",
      '{"renderMode":"text|slides","captionPosition":"...|null","textStyle":{"theme":"warm|cool|night|sunrise|mint|ocean|plum|sand","align":"left|center|right","emphasis":"soft|bold|serif|mono|display","font":"sans|serif|mono|display","weight":"regular|bold","italic":false,"size":"sm|md|lg|xl|2xl","color":"ink|paper|cream|sunset|mint|sky","position":"top-left|top-center|top-right|middle-left|middle-center|middle-right|bottom-left|bottom-center|bottom-right","background":"optional css gradient or color"},"backgroundImagePrompt":"...|null","slides":[{"caption":"...","imagePrompt":"..."}]}',
      "Rules:",
      "- Never use em dash characters; use '-' or normal punctuation instead.",
      "- renderMode 'text' for most posts. Use 'slides' only when the text has a sequence/list/compare/story beats.",
      "- If slides mode: provide 2-4 slides max, each with imagePrompt. Keep captions concise.",
      "- If text mode: always provide textStyle with a distinct visual identity.",
      "- backgroundImagePrompt is optional and only for text mode when image background helps.",
      "- imagePrompt/backgroundImagePrompt must be direct prompts, no wrappers like 'Generate an image of'.",
      `caption: ${input.caption ?? ""}`,
      `textBody: ${input.textBody}`,
      "Context:",
      ...contextLines.map((line) => `- ${line}`),
    ].join("\n");
  }

  private async planTextPostVisualWithOpenClaw(input: {
    commandId: string;
    caption: string | null;
    textBody: string;
    context: PostDraftContext;
  }): Promise<TextPostVisualPlan | null> {
    const runOpenClawPrompt = this.ctx.runOpenClawPrompt;
    if (!runOpenClawPrompt) return null;
    const prompt = this.buildTextPostVisualPlanPrompt(input);
    try {
      const result = await runOpenClawPrompt({
        prompt,
        purpose: "text_post_visual_plan",
      });
      const plan =
        (result
          ? this.extractTextPostVisualPlanFromUnknown(result.parsed) ??
            this.extractTextPostVisualPlanFromUnknown(result.payloadText) ??
            this.extractTextPostVisualPlanFromUnknown(result.raw)
          : null) ?? null;
      if (!plan) return null;
      await this.ctx.memory
        .recordWrite({
          type: "text_post_visual_plan_created",
          at: nowIso(),
          commandId: input.commandId,
          renderMode: plan.renderMode,
          captionPosition: plan.captionPosition,
          hasTextStyle: plan.textStyle !== null,
          hasBackgroundImagePrompt: plan.backgroundImagePrompt !== null,
          slideCount: plan.slides.length,
        })
        .catch(() => undefined);
      return plan;
    } catch (error: unknown) {
      await this.ctx.memory
        .recordWrite({
          type: "text_post_visual_plan_failed",
          at: nowIso(),
          commandId: input.commandId,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      return null;
    }
  }

  private buildPostDraftCurationPrompt(input: {
    postType: "text" | "media";
    caption: string | null;
    textBody: string | null;
    mediaPrompt: string | null;
    context: PostDraftContext;
    seedHints: string[];
    avoidReferences: string[];
  }): string {
    const contextLines = [
      typeof input.context.targetPostId === "number"
        ? `targetPostId: ${input.context.targetPostId}`
        : null,
      input.context.postText ? `targetPostText: ${input.context.postText}` : null,
      input.context.mediaSummary ? `targetMedia: ${input.context.mediaSummary}` : null,
      input.context.commentSummary ? `targetComments: ${input.context.commentSummary}` : null,
      input.context.payloadHint ? `directiveHint: ${input.context.payloadHint}` : null,
      input.context.memorySummary ? `memoryContext: ${input.context.memorySummary}` : null,
    ].filter((entry): entry is string => Boolean(entry));
    if (input.postType === "text") {
      return [
        "Rewrite this directive-generated POST so it is original, social, and context-aware.",
        "Use memoryContext + targetPostText + targetComments as grounding, then produce a fresh thought.",
        "Do not echo or paraphrase target post text/comments. Synthesize a new opinion or angle.",
        "Return strict JSON only with exactly this shape: {\"caption\":\"...\",\"textBody\":\"...\"}.",
        "Rules:",
        "- textBody: 40-240 chars, natural voice, no hashtags, no emojis.",
        "- caption: optional, 0-140 chars.",
        "- Never use em dash characters; use '-' or normal punctuation instead.",
        "- Must not reuse long phrases from targetPostText/targetMedia/directiveHint.",
        "- Must not reuse long phrases from directive seed text.",
        "- Must not reuse long phrases from recent self-post references.",
        `draftCaption: ${input.caption ?? ""}`,
        `draftTextBody: ${input.textBody ?? ""}`,
        ...(input.seedHints.length > 0
          ? [
              "Directive seeds (avoid echo):",
              ...input.seedHints.slice(0, 8).map((entry) => `- ${entry}`),
            ]
          : []),
        ...(input.avoidReferences.length > 0
          ? [
              "Recent self-post references (must differ):",
              ...input.avoidReferences.slice(0, POST_NOVELTY_MAX_AVOID_REFERENCES).map((entry) => `- ${entry}`),
            ]
          : []),
        "Context:",
        ...contextLines.map((line) => `- ${line}`),
      ].join("\n");
    }
    return [
      "Rewrite this directive-generated MEDIA POST so it is original and not an echo.",
      "Use memoryContext + targetPostText + targetComments to create a new media direction.",
      "Do not copy title/caption/prompt from source post/comments/directive.",
      "Return strict JSON only with exactly this shape: {\"caption\":\"...\",\"mediaPrompt\":\"...\"}.",
      "Rules:",
      "- caption: 10-220 chars, natural social voice, no hashtags, no emojis.",
      "- mediaPrompt: 20-320 chars, concrete visual prompt, no wrappers like 'Generate an image of'.",
      "- Never use em dash characters; use '-' or normal punctuation instead.",
      "- Must be materially different from targetPostText/targetMedia/directiveHint.",
      "- Must be materially different from directive seed text.",
      "- Must be materially different from recent self-post references.",
      `draftCaption: ${input.caption ?? ""}`,
      `draftMediaPrompt: ${input.mediaPrompt ?? ""}`,
      ...(input.seedHints.length > 0
        ? [
            "Directive seeds (avoid echo):",
            ...input.seedHints.slice(0, 8).map((entry) => `- ${entry}`),
          ]
        : []),
      ...(input.avoidReferences.length > 0
        ? [
            "Recent self-post references (must differ):",
            ...input.avoidReferences.slice(0, POST_NOVELTY_MAX_AVOID_REFERENCES).map((entry) => `- ${entry}`),
          ]
        : []),
      "Context:",
      ...contextLines.map((line) => `- ${line}`),
    ].join("\n");
  }

  private extractCuratedPostDraftFromUnknown(
    value: unknown,
    postType: "text" | "media",
  ): { caption: string | null; textBody: string | null; mediaPrompt: string | null } | null {
    const fromString = (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed.length) return null;
      const parsed = parseJsonFromMixedText(trimmed);
      if (parsed !== null && parsed !== raw) {
        return this.extractCuratedPostDraftFromUnknown(parsed, postType);
      }
      return null;
    };
    if (typeof value === "string") {
      return fromString(value);
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const parsed = this.extractCuratedPostDraftFromUnknown(entry, postType);
        if (parsed) return parsed;
      }
      return null;
    }
    if (!isRecord(value)) return null;
    const caption =
      asNonEmptyString(value.caption) ??
      asNonEmptyString(value.title) ??
      null;
    const textBody =
      asNonEmptyString(value.textBody) ??
      asNonEmptyString(value.body) ??
      asNonEmptyString(value.text) ??
      null;
    const mediaPrompt =
      asNonEmptyString(value.mediaPrompt) ??
      asNonEmptyString(value.imagePrompt) ??
      asNonEmptyString(value.prompt) ??
      null;
    if (postType === "text" && textBody) {
      return {
        caption: caption ? stripEmDashCharacters(caption) : null,
        textBody: truncateText(stripEmDashCharacters(textBody), 240),
        mediaPrompt: null,
      };
    }
    if (postType === "media" && (mediaPrompt || caption)) {
      return {
        caption: caption ? truncateText(stripEmDashCharacters(caption), 2200) : null,
        textBody: null,
        mediaPrompt: mediaPrompt ? truncateText(stripEmDashCharacters(mediaPrompt), 320) : null,
      };
    }
    for (const key of ["draft", "payload", "result", "output", "data", "content"] as const) {
      const nested = this.extractCuratedPostDraftFromUnknown(value[key], postType);
      if (nested) return nested;
    }
    return null;
  }

  private async curatePostDraftWithOpenClaw(input: {
    commandId: string;
    postType: "text" | "media";
    caption: string | null;
    textBody: string | null;
    mediaPrompt: string | null;
    context: PostDraftContext;
    seedHints: string[];
    avoidReferences: string[];
  }): Promise<{ caption: string | null; textBody: string | null; mediaPrompt: string | null } | null> {
    const runOpenClawPrompt = this.ctx.runOpenClawPrompt;
    if (!runOpenClawPrompt) return null;
    const prompt = this.buildPostDraftCurationPrompt({
      postType: input.postType,
      caption: input.caption,
      textBody: input.textBody,
      mediaPrompt: input.mediaPrompt,
      context: input.context,
      seedHints: input.seedHints,
      avoidReferences: input.avoidReferences,
    });
    try {
      const result = await runOpenClawPrompt({
        prompt,
        purpose: "post_draft_curation",
      });
      const curated =
        (result
          ? this.extractCuratedPostDraftFromUnknown(result.parsed, input.postType) ??
            this.extractCuratedPostDraftFromUnknown(result.payloadText, input.postType) ??
            this.extractCuratedPostDraftFromUnknown(result.raw, input.postType)
          : null) ?? null;
      if (!curated) return null;
      const candidate = [
        curated.caption ?? input.caption ?? "",
        curated.textBody ?? "",
        curated.mediaPrompt ?? "",
      ]
        .filter((value) => value.trim().length > 0)
        .join("\n");
      if (candidate.length < 12) return null;
      await this.ctx.memory
        .recordWrite({
          type: "post_draft_curated",
          at: nowIso(),
          commandId: input.commandId,
          postType: input.postType,
          caption: curated.caption,
          textBody: curated.textBody,
          mediaPrompt: curated.mediaPrompt,
        })
        .catch(() => undefined);
      return curated;
    } catch (error: unknown) {
      await this.ctx.memory
        .recordWrite({
          type: "post_draft_curation_failed",
          at: nowIso(),
          commandId: input.commandId,
          postType: input.postType,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      return null;
    }
  }

  private collectDirectiveSeedHints(payload: Record<string, unknown>): string[] {
    const candidates: string[] = [];
    const push = (value: unknown): void => {
      const text = asNonEmptyString(value);
      if (!text) return;
      candidates.push(text);
    };
    push(payload.requestText);
    push(payload.topic);
    push(payload.prompt);
    push(payload.mediaPrompt);
    push(payload.imagePrompt);
    push(payload.caption);
    push(payload.textBody);
    push(payload.body);
    push(payload.text);
    push(payload.message);
    push(payload.title);
    const scope = isRecord(payload.directiveScope) ? payload.directiveScope : null;
    if (scope) {
      push(scope.reason);
      push(scope.note);
      push(scope.topic);
      push(scope.caption);
      push(scope.textBody);
      push(scope.body);
      push(scope.text);
      const target = isRecord(scope.target) ? scope.target : null;
      if (target) {
        push(target.caption);
        push(target.textBody);
        push(target.body);
      }
    }
    const normalized = new Set<string>();
    const deduped: string[] = [];
    for (const entry of candidates) {
      const clean = truncateText(entry, 320);
      const key = normalizeCommentText(clean);
      if (!key.length || normalized.has(key)) continue;
      normalized.add(key);
      deduped.push(clean);
    }
    return deduped.slice(0, 12);
  }

  private async executeWriteCreateStory(command: Command): Promise<CommandOutcome> {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) {
      return this.failedOutcome(command, "Invalid payload for write.createStory.");
    }
    const provenance = asNonEmptyString(payload.provenance);
    const sourceDirectiveId =
      asNonEmptyString(payload.sourceDirectiveId) ??
      command.sourceDirectiveId ??
      null;
    const sourceDirectiveActionNonce =
      asNonEmptyString(payload.sourceDirectiveActionNonce) ??
      command.actionNonce ??
      null;

    const media = await this.resolveMediaUpload({
      payload,
      keepOriginal: false,
      promptFallbacks: [
        asNonEmptyString(payload.mediaPrompt),
        asNonEmptyString(payload.imagePrompt),
      ],
      command,
    });

    const result = await this.agent().createStory.mutate({
      mediaUrl: media.mediaUrl,
      ...(media.mediaOriginalUrl ? { originalUrl: media.mediaOriginalUrl } : {}),
      ...(media.mediaOptimizedUrl ? { optimizedUrl: media.mediaOptimizedUrl } : {}),
      ...(media.mediaContentHash ? { contentHash: media.mediaContentHash } : {}),
      ...(media.mediaIpfsCid ? { ipfsCid: media.mediaIpfsCid } : {}),
      ...(media.mediaType ? { mediaType: media.mediaType } : {}),
      ...(asNonEmptyString(payload.caption) ? { caption: asNonEmptyString(payload.caption) } : {}),
      ...(asNonEmptyString(payload.captionPosition) ? { captionPosition: asNonEmptyString(payload.captionPosition) } : {}),
      ...(asNonEmptyString(payload.mediaFit) ? { mediaFit: asNonEmptyString(payload.mediaFit) } : {}),
      ...(asPositiveInt(payload.expiresInSeconds)
        ? { expiresInSeconds: asPositiveInt(payload.expiresInSeconds) }
        : {}),
      ...(provenance ? { provenance } : {}),
      ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
      ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
      ...(command.grantId ? { grantId: command.grantId } : {}),
    });
    return this.successOutcome(command, result);
  }

  private async executeWriteUpdateAvatar(command: Command): Promise<CommandOutcome> {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) {
      return this.failedOutcome(command, "Invalid payload for write.updateAvatar.");
    }
    const targetRaw = asNonEmptyString(payload.target)?.toLowerCase();
    const target =
      targetRaw === "owner" || targetRaw === "for-me" || targetRaw === "for_owner" || targetRaw === "me"
        ? "owner"
        : "agent";
    const provenance = asNonEmptyString(payload.provenance);
    const sourceDirectiveId =
      asNonEmptyString(payload.sourceDirectiveId) ??
      command.sourceDirectiveId ??
      null;
    const sourceDirectiveActionNonce =
      asNonEmptyString(payload.sourceDirectiveActionNonce) ??
      command.actionNonce ??
      null;

    const media = await this.resolveMediaUpload({
      payload,
      keepOriginal: false,
      promptFallbacks: [
        asNonEmptyString(payload.mediaPrompt),
        asNonEmptyString(payload.imagePrompt),
        asNonEmptyString(payload.prompt),
      ],
      command,
    });
    const result = await this.updateAvatar({
      target,
      imageUrl: media.mediaUrl,
      ...(media.mediaOriginalUrl ? { originalUrl: media.mediaOriginalUrl } : {}),
      ...(media.mediaOptimizedUrl ? { optimizedUrl: media.mediaOptimizedUrl } : {}),
      ...(media.mediaContentHash ? { contentHash: media.mediaContentHash } : {}),
      ...(media.mediaIpfsCid ? { ipfsCid: media.mediaIpfsCid } : {}),
      ...(typeof media.mediaSizeBytes === "number" ? { sizeBytes: media.mediaSizeBytes } : {}),
      ...(provenance ? { provenance } : {}),
      ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
      ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
    });
    return this.successOutcome(command, result);
  }

  private async executeWriteUpdateBanner(command: Command): Promise<CommandOutcome> {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) {
      return this.failedOutcome(command, "Invalid payload for write.updateBanner.");
    }
    const targetRaw = asNonEmptyString(payload.target)?.toLowerCase();
    const target =
      targetRaw === "owner" || targetRaw === "for-me" || targetRaw === "for_owner" || targetRaw === "me"
        ? "owner"
        : "agent";
    const provenance = asNonEmptyString(payload.provenance);
    const sourceDirectiveId =
      asNonEmptyString(payload.sourceDirectiveId) ??
      command.sourceDirectiveId ??
      null;
    const sourceDirectiveActionNonce =
      asNonEmptyString(payload.sourceDirectiveActionNonce) ??
      command.actionNonce ??
      null;

    const media = await this.resolveMediaUpload({
      payload,
      keepOriginal: false,
      promptFallbacks: [
        asNonEmptyString(payload.mediaPrompt),
        asNonEmptyString(payload.imagePrompt),
        asNonEmptyString(payload.prompt),
      ],
      command,
    });
    const result = await this.updateBanner({
      target,
      bannerUrl: media.mediaUrl,
      ...(media.mediaOriginalUrl ? { originalUrl: media.mediaOriginalUrl } : {}),
      ...(media.mediaOptimizedUrl ? { optimizedUrl: media.mediaOptimizedUrl } : {}),
      ...(media.mediaContentHash ? { contentHash: media.mediaContentHash } : {}),
      ...(media.mediaIpfsCid ? { ipfsCid: media.mediaIpfsCid } : {}),
      ...(typeof media.mediaSizeBytes === "number" ? { sizeBytes: media.mediaSizeBytes } : {}),
      ...(provenance ? { provenance } : {}),
      ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
      ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
    });
    return this.successOutcome(command, result);
  }

  private async executeWriteComment(command: Command): Promise<CommandOutcome> {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) {
      return this.failedOutcome(command, "Invalid payload for write.commentPost.");
    }
    const body =
      asNonEmptyString(payload.body) ??
      asNonEmptyString(payload.requestText) ??
      asNonEmptyString(payload.prompt) ??
      "Write a concise, relevant reply to the target post.";
    let resolvedTarget: EngagementTargetCandidate | null = null;
    try {
      resolvedTarget =
        (await this.resolveEngagementTargetForDirective({
          payload,
          action: "comment",
          commandId: command.id,
        })) ?? null;
    } catch (error: unknown) {
      if (this.isNoTargetDiscoveryFailure(error)) {
        return this.failedOutcome(
          command,
          "No target post/comment candidates found after discovery scan.",
          "no_target_candidates",
        );
      }
      throw error;
    }
    if (!resolvedTarget) {
      throw new RequeueCommandError("comment_target_resolution_waiting_for_context:no_target");
    }
    const postId = resolvedTarget.postId;
    const parentId =
      asPositiveInt(payload.parentId) ??
      asPositiveInt(payload.commentId) ??
      asPositiveInt(payload.targetCommentId) ??
      resolvedTarget.commentId ??
      null;
    payload.postId = postId;
    payload.targetPostId = postId;
    if (parentId) {
      payload.parentId = parentId;
      payload.commentId = parentId;
      payload.targetCommentId = parentId;
    }
    const expectedTarget = {
      postId,
      commentId: parentId ?? null,
      targetHash: buildTargetHash({
        postId,
        commentId: parentId ?? null,
      }),
    };
    const lockMatch = isTargetLockMatch({
      payload,
      expected: expectedTarget,
    });
    if (!lockMatch.ok) {
      return this.failedOutcome(
        command,
        `Target lock mismatch: ${lockMatch.reason}.`,
        "target_lock_mismatch",
      );
    }
    const target = applyTargetLock(payload, {
      postId,
      commentId: parentId ?? null,
    });
    const idempotencyKey = this.buildActionIdempotencyKey({
      command,
      action: "comment",
      postId: target.postId,
      commentId: target.commentId,
    });
    const dedupe = this.beginActionLifecycle({
      command,
      action: "comment",
      idempotencyKey,
      target,
      state: "context_ready",
    });
    if (!dedupe.allowed) {
      if (dedupe.requeue) {
        throw new RequeueCommandError(
          `comment_waiting_for_backoff:${dedupe.reason}`,
        );
      }
      return this.successOutcome(command, {
        skipped: true,
        action: "comment",
        postId: target.postId,
        commentId: target.commentId,
        decision: dedupe.reason,
      });
    }
    try {
      const grantId = await this.preflightGrantForAction({
        command,
        payload,
        action: "comment",
        lifecycle: {
          idempotencyKey,
          target,
        },
      });
      const provenance = asNonEmptyString(payload.provenance);
      const sourceDirectiveId =
        asNonEmptyString(payload.sourceDirectiveId) ??
        command.sourceDirectiveId ??
        null;
      const sourceDirectiveActionNonce =
        asNonEmptyString(payload.sourceDirectiveActionNonce) ??
        command.actionNonce ??
        null;
      const curatedBody = await this.curateCommentBodyWithOpenClaw({
        command,
        payload,
        postId: target.postId,
        parentId: target.commentId,
        body,
        targetHash: target.targetHash,
        lifecycleIdempotencyKey: idempotencyKey,
      });
      this.updateActionLifecycle({
        command,
        action: "comment",
        idempotencyKey,
        target,
        state: "action_running",
      });
      const finalBody = stripEmDashCharacters(curatedBody.body);
      const result = await this.agent().commentPost.mutate({
        postId: target.postId,
        body: finalBody,
        ...(target.commentId ? { parentId: target.commentId } : {}),
        ...(provenance ? { provenance } : {}),
        ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
        ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
        grantId,
      });
      await this.ctx.memory
        .recordWrite({
          type: "comment_body_curated",
          at: nowIso(),
          commandId: command.id,
          postId: target.postId,
          parentId: target.commentId,
          source: curatedBody.source,
          reason: curatedBody.reason,
          draftBody: truncateText(body, 200),
          finalBody: truncateText(finalBody, 200),
        })
        .catch(() => undefined);
      this.updateActionLifecycle({
        command,
        action: "comment",
        idempotencyKey,
        target,
        state: "acked",
        lastError: null,
      });
      return this.successOutcome(command, result);
    } catch (error: unknown) {
      if (error instanceof RequeueCommandError) {
        this.updateActionLifecycle({
          command,
          action: "comment",
          idempotencyKey,
          target,
          state: "requeue",
          lastError: error.message,
        });
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (this.isOwnerCapabilityDeniedError(error)) {
        this.registerOwnerCapabilityCooldown({
          action: "comment",
          targetHash: target.targetHash,
          reason: "not_granted",
        });
      }
      this.updateActionLifecycle({
        command,
        action: "comment",
        idempotencyKey,
        target,
        state: "failed",
        lastError: message,
      });
      throw error;
    }
  }

  private async curateCommentBodyWithOpenClaw(input: {
    command: Command;
    payload: Record<string, unknown>;
    postId: number;
    parentId: number | null;
    body: string;
    targetHash: string;
    lifecycleIdempotencyKey: string;
  }): Promise<CuratedCommentBody> {
    const context = await this.loadCommentCurationContext({
      postId: input.postId,
      parentId: input.parentId,
      payload: input.payload,
    });
    const draftBody = input.body.trim();
    if (!draftBody.length) {
      throw new Error("Comment blocked: empty draft body.");
    }

    const runOpenClawPrompt = this.ctx.runOpenClawPrompt;
    if (!runOpenClawPrompt) {
      throw new RequeueCommandError(
        "comment_curation_waiting_for_openclaw:openclaw_required_unavailable",
      );
    }
    if (!context.postText && !context.mediaSummary && !context.threadSummary) {
      await this.ctx.memory
        .recordWrite({
          type: "comment_body_curation_blocked",
          at: nowIso(),
          commandId: input.command.id,
          postId: input.postId,
          parentId: input.parentId,
          reason: "missing_target_post_context",
        })
        .catch(() => undefined);
      throw new RequeueCommandError(
        "comment_curation_waiting_for_target_context:missing_target_post_context",
      );
    }
    let attemptedOpenClawCuration = false;
    let openClawCurationErrored = false;
    attemptedOpenClawCuration = true;
    try {
      this.updateActionLifecycle({
        command: input.command,
        action: "comment",
        idempotencyKey: input.lifecycleIdempotencyKey,
        target: {
          postId: input.postId,
          commentId: input.parentId,
          targetHash: input.targetHash,
        },
        state: "llm_running",
      });
      const curationPrompt = this.buildCommentCurationPrompt({
        postId: input.postId,
        parentId: input.parentId,
        targetHash: input.targetHash,
        draftBody,
        context,
      });
      const result = await runOpenClawPrompt({
        prompt: curationPrompt,
        purpose: "comment_body_curation",
      });
      const contract =
        (result
          ? this.extractActionContractFromUnknown({
            value: result.parsed,
            action: "comment",
            expectedPostId: input.postId,
            expectedCommentId: input.parentId,
            expectedTargetHash: input.targetHash,
          }) ??
            this.extractActionContractFromUnknown({
              value: result.payloadText,
              action: "comment",
              expectedPostId: input.postId,
              expectedCommentId: input.parentId,
              expectedTargetHash: input.targetHash,
            }) ??
            this.extractActionContractFromUnknown({
              value: result.raw,
              action: "comment",
              expectedPostId: input.postId,
              expectedCommentId: input.parentId,
              expectedTargetHash: input.targetHash,
            })
          : null) ?? null;
      if (contract) {
        if (!contract.shouldExecute || !contract.body) {
          await this.ctx.memory
            .recordWrite({
              type: "comment_body_curation_rejected",
              at: nowIso(),
              commandId: input.command.id,
              postId: input.postId,
              reason: contract.shouldExecute ? "missing_body" : "llm_declined_execute",
              draftBody: truncateText(draftBody, 200),
            })
            .catch(() => undefined);
          throw new RequeueCommandError(
            "comment_curation_waiting_for_openclaw:openclaw_declined_or_missing_body",
          );
        }
        const validation = this.validateCuratedCommentCandidate({
          candidate: contract.body,
          draftBody,
          context,
        });
        if (validation.ok) {
          return {
            body: contract.body,
            source: "openclaw",
            reason: "openclaw_curated",
          };
        }
        await this.ctx.memory
          .recordWrite({
            type: "comment_body_curation_rejected",
            at: nowIso(),
            commandId: input.command.id,
            postId: input.postId,
            reason: validation.reason,
            draftBody: truncateText(draftBody, 200),
            candidate: truncateText(contract.body, 200),
          })
          .catch(() => undefined);
      } else {
        await this.ctx.memory
          .recordWrite({
            type: "comment_body_curation_missing_contract",
            at: nowIso(),
            commandId: input.command.id,
            postId: input.postId,
          })
          .catch(() => undefined);
      }
    } catch (error: unknown) {
      openClawCurationErrored = true;
      await this.ctx.memory
        .recordWrite({
          type: "comment_body_curation_failed",
          at: nowIso(),
          commandId: input.command.id,
          postId: input.postId,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
    }

    if (openClawCurationErrored) {
      throw new RequeueCommandError(
        "comment_curation_waiting_for_openclaw:openclaw_curation_failed",
      );
    }
    await this.ctx.memory
      .recordWrite({
        type: "comment_body_curation_blocked",
        at: nowIso(),
        commandId: input.command.id,
        postId: input.postId,
        parentId: input.parentId,
        reason: attemptedOpenClawCuration
          ? "target_specific_llm_curation_required"
          : "missing_llm_curation",
        draftBody: truncateText(draftBody, 200),
      })
      .catch(() => undefined);
    throw new RequeueCommandError(
      "comment_curation_waiting_for_openclaw:openclaw_contract_invalid",
    );
  }

  private async loadCommentCurationContext(input: {
    postId: number;
    parentId: number | null;
    payload: Record<string, unknown>;
  }): Promise<CommentCurationContext> {
    const context: CommentCurationContext = {
      postAuthorHandle: null,
      postText: null,
      mediaSummary: null,
      threadSummary: null,
      payloadHint: this.extractCommentPayloadHint(input.payload),
      memorySummary: await this.loadEngagementMemorySummary({
        action: "comment",
        postId: input.postId,
        commentId: input.parentId,
        payload: input.payload,
      }),
    };

    const callAgentChatBridge = this.ctx.callAgentChatBridge;
    if (!callAgentChatBridge) {
      return context;
    }

    try {
      const postResponse = await callAgentChatBridge({
        action: "find_post",
        postId: input.postId,
      });
      const postRecord = this.extractPostRecordForCommentCuration(
        postResponse,
        input.postId,
      );
      if (postRecord) {
        const author = isRecord(postRecord.author) ? postRecord.author : null;
        context.postAuthorHandle =
          asNonEmptyString(author?.handle) ??
          asNonEmptyString(postRecord.authorHandle);
        context.postText =
          asNonEmptyString(postRecord.textBody) ??
          asNonEmptyString(postRecord.caption) ??
          asNonEmptyString(postRecord.body);
        context.mediaSummary = this.summarizePostMediaForComment(postRecord);
      }
    } catch (error: unknown) {
      await this.ctx.memory
        .recordWrite({
          type: "comment_curation_post_lookup_failed",
          at: nowIso(),
          postId: input.postId,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
    }

    if (input.parentId) {
      try {
        const commentResponse = await callAgentChatBridge({
          action: "find_comment",
          postId: input.postId,
          commentId: input.parentId,
        });
        const commentRecord = this.extractCommentRecordForCommentCuration(commentResponse);
        if (commentRecord) {
          const commentAuthor = isRecord(commentRecord.author)
            ? commentRecord.author
            : null;
          const commentAuthorHandle =
            asNonEmptyString(commentAuthor?.handle) ??
            asNonEmptyString(commentRecord.authorHandle) ??
            "user";
          const commentBody =
            asNonEmptyString(commentRecord.body) ??
            asNonEmptyString(commentRecord.textBody);
          if (commentBody) {
            context.threadSummary = truncateText(
              `Reply target @${commentAuthorHandle}: ${commentBody}`,
              220,
            );
          }
        }
      } catch (error: unknown) {
        await this.ctx.memory
          .recordWrite({
            type: "comment_curation_parent_lookup_failed",
            at: nowIso(),
            postId: input.postId,
            parentId: input.parentId,
            error: error instanceof Error ? error.message : String(error),
          })
          .catch(() => undefined);
      }
    }

    return context;
  }

  private extractCommentPayloadHint(payload: Record<string, unknown>): string | null {
    const hint = [
      asNonEmptyString(payload.requestText),
      asNonEmptyString(payload.topic),
      asNonEmptyString(payload.prompt),
      asNonEmptyString(payload.caption),
      asNonEmptyString(payload.textBody),
    ].find((value): value is string => typeof value === "string" && value.trim().length > 0);
    return hint ? truncateText(hint, 180) : null;
  }

  private async loadEngagementMemorySummary(input: {
    action: "comment" | "like" | "repost";
    postId: number;
    commentId: number | null;
    payload: Record<string, unknown>;
  }): Promise<string | null> {
    if (typeof this.ctx.memory.buildContext !== "function") {
      return null;
    }
    try {
      const request: ContextRequest = {
        mode: "engagement",
        audience: "runtime_write",
        postId: input.postId,
        ...(typeof input.commentId === "number" ? { commentId: input.commentId } : {}),
        maxRecentEvents: 120,
        maxArchiveEvents: 40,
        includeViewState: true,
        viewStateMaxItems: 10,
        includeKeywordRetrieval: true,
        retrievalIntent: "engagement",
        retrievalMaxItems: 10,
        retrievalQuery: this.buildEngagementRetrievalQuery(input),
      };
      const bundle = await this.ctx.memory.buildContext(request);
      return this.buildCompactEngagementMemorySummary(bundle);
    } catch (error: unknown) {
      await this.ctx.memory
        .recordWrite({
          type: "engagement_memory_context_failed",
          at: nowIso(),
          action: input.action,
          postId: input.postId,
          commentId: input.commentId,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      return null;
    }
  }

  private buildEngagementRetrievalQuery(input: {
    action: "comment" | "like" | "repost";
    postId: number;
    commentId: number | null;
    payload: Record<string, unknown>;
  }): string {
    const payloadHint = this.extractCommentPayloadHint(input.payload);
    const actionPhrase =
      input.action === "comment"
        ? "comment engagement context"
        : input.action === "like"
          ? "like engagement context"
          : "repost engagement context";
    const commentToken =
      typeof input.commentId === "number" ? `comment ${input.commentId}` : "";
    const hintToken = payloadHint ? `hint ${payloadHint}` : "";
    const scopeToken =
      input.action === "comment"
        ? "target post and thread only"
        : "most engaged comments last comments, likes and views this week";
    return [
      actionPhrase,
      `post ${input.postId}`,
      commentToken,
      scopeToken,
      hintToken,
    ]
      .filter((value) => value.length > 0)
      .join(" · ");
  }

  private buildCompactEngagementMemorySummary(bundle: ContextBundle): string | null {
    const lines: string[] = [];
    if (
      isRecord(bundle.retrieval) &&
      bundle.retrieval.enabled === true &&
      Array.isArray(bundle.retrieval.lines)
    ) {
      lines.push(
        ...bundle.retrieval.lines
          .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          .slice(0, 8)
          .map((entry) => `retrieval: ${entry.trim()}`),
      );
    }
    if (
      isRecord(bundle.view) &&
      bundle.view.enabled === true &&
      Array.isArray(bundle.view.lines)
    ) {
      lines.push(
        ...bundle.view.lines
          .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          .slice(0, 6)
          .map((entry) => `view: ${entry.trim()}`),
      );
    }
    if (
      isRecord(bundle.target) &&
      isRecord(bundle.target.focus) &&
      Array.isArray(bundle.target.focus.bullets)
    ) {
      lines.push(
        ...bundle.target.focus.bullets
          .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          .slice(0, 6)
          .map((entry) => `focus: ${entry.trim()}`),
      );
    }
    if (
      isRecord(bundle.temporal) &&
      isRecord(bundle.temporal.tiers) &&
      isRecord(bundle.temporal.tiers["24h"]) &&
      Array.isArray(bundle.temporal.tiers["24h"].bullets)
    ) {
      lines.push(
        ...bundle.temporal.tiers["24h"].bullets
          .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          .slice(0, 2)
          .map((entry) => `tier24h: ${entry.trim()}`),
      );
    }
    if (lines.length === 0) return null;
    return truncateText(lines.join("\n"), 2200);
  }

  private extractPostRecordForCommentCuration(
    value: unknown,
    expectedPostId: number,
  ): Record<string, unknown> | null {
    if (!isRecord(value)) return null;
    if (isRecord(value.data)) {
      return this.extractPostRecordForCommentCuration(value.data, expectedPostId);
    }
    if (isRecord(value.post)) {
      const postId = asPositiveInt(value.post.id);
      if (postId === expectedPostId) return value.post;
      return null;
    }
    if (Array.isArray(value.items)) {
      const items = value.items as unknown[];
      const match = items.find((entry): entry is Record<string, unknown> => {
        if (!isRecord(entry)) return false;
        const postId = asPositiveInt(entry.id);
        return postId === expectedPostId;
      });
      if (match) return match;
      return null;
    }
    const rootPostId = asPositiveInt(value.id);
    if (rootPostId === expectedPostId) {
      return value;
    }
    return null;
  }

  private extractCommentRecordForCommentCuration(
    value: unknown,
  ): Record<string, unknown> | null {
    if (!isRecord(value)) return null;
    if (isRecord(value.data)) return this.extractCommentRecordForCommentCuration(value.data);
    if (isRecord(value.comment)) return value.comment;
    if (Array.isArray(value.comments)) {
      const first = value.comments.find((entry) => isRecord(entry));
      if (isRecord(first)) return first;
      return null;
    }
    return value;
  }

  private summarizeCommentsForPostDraft(value: unknown): string | null {
    if (!isRecord(value)) return null;
    const root = isRecord(value.data) ? value.data : value;
    const commentsRaw = Array.isArray(root.comments) ? root.comments : [];
    if (commentsRaw.length === 0) return null;
    const snippets: string[] = [];
    for (const item of commentsRaw) {
      if (!isRecord(item)) continue;
      const author = isRecord(item.author) ? item.author : null;
      const handle =
        asNonEmptyString(author?.handle) ??
        asNonEmptyString(item.authorHandle) ??
        "user";
      const body =
        asNonEmptyString(item.body) ??
        asNonEmptyString(item.textBody) ??
        null;
      if (!body) continue;
      snippets.push(`@${handle}: ${truncateText(body, 100)}`);
      if (snippets.length >= 5) break;
    }
    if (snippets.length === 0) return null;
    return truncateText(snippets.join(" | "), 600);
  }

  private summarizePostMediaForComment(post: Record<string, unknown>): string | null {
    const mediaItems = Array.isArray(post.mediaItems)
      ? post.mediaItems.filter((entry): entry is Record<string, unknown> => isRecord(entry))
      : [];
    if (mediaItems.length === 0) return null;
    let imageCount = 0;
    let videoCount = 0;
    const captionHints: string[] = [];
    for (const item of mediaItems) {
      const mediaType = asNonEmptyString(item.mediaType)?.toLowerCase();
      if (mediaType === "video") {
        videoCount += 1;
      } else {
        imageCount += 1;
      }
      const caption = asNonEmptyString(item.caption);
      if (caption && captionHints.length < 3) {
        captionHints.push(truncateText(caption, 80));
      }
    }
    const bits = [
      imageCount > 0 ? `${imageCount} image${imageCount === 1 ? "" : "s"}` : null,
      videoCount > 0 ? `${videoCount} video${videoCount === 1 ? "" : "s"}` : null,
      captionHints.length > 0 ? `cues: ${captionHints.join(" | ")}` : null,
    ].filter((entry): entry is string => Boolean(entry));
    if (bits.length === 0) return null;
    return truncateText(bits.join(". "), 220);
  }

  private buildCommentCurationPrompt(input: {
    postId: number;
    parentId: number | null;
    targetHash: string;
    draftBody: string;
    context: CommentCurationContext;
  }): string {
    const contextLines = [
      `postId: ${input.postId}`,
      input.context.postAuthorHandle
        ? `postAuthor: @${input.context.postAuthorHandle.replace(/^@+/u, "")}`
        : null,
      input.context.postText ? `postText: ${input.context.postText}` : null,
      input.context.mediaSummary ? `mediaContext: ${input.context.mediaSummary}` : null,
      input.context.threadSummary ? `threadContext: ${input.context.threadSummary}` : null,
      input.context.payloadHint ? `requestHint: ${input.context.payloadHint}` : null,
      input.context.memorySummary ? `memoryContext: ${input.context.memorySummary}` : null,
    ].filter((entry): entry is string => Boolean(entry));

    return [
      "You are rewriting a social-media comment for quality and relevance.",
      "Return strict JSON only with exactly this shape: {\"body\":\"...\"}.",
      "Rules:",
      "- body must be 14-180 characters.",
      "- 1-2 concise sentences in a natural voice.",
      "- Must clearly reference THIS target post/thread context.",
      "- Include at least one concrete detail from post/media/thread context.",
      "- Do not copy wording from the draft or post text.",
      "- Never start with 'Frame N:' and never output image-prompt wrappers.",
      "- No hashtags, no emojis, no system/tool mentions.",
      "- Never use em dash characters; use '-' or normal punctuation instead.",
      "Return strict JSON ONLY with this exact shape:",
      `{"action":"comment","target":{"postId":${input.postId},"commentId":${input.parentId ?? "null"},"targetHash":"${input.targetHash}"},"body":"<comment>","reason":"<short reason>","shouldExecute":true}`,
      `Draft comment: ${input.draftBody}`,
      "Context:",
      ...contextLines.map((line) => `- ${line}`),
    ].join("\n");
  }

  private normalizeCuratedCommentBody(value: string): string {
    const unfenced = value
      .replace(/^```(?:json|text|markdown)?\s*/iu, "")
      .replace(/```$/u, "")
      .trim();
    const unquoted = unfenced.replace(/^["'`]|["'`]$/gu, "").trim();
    const stripped = unquoted.replace(/^(?:body|comment|reply)\s*:\s*/iu, "").trim();
    return stripEmDashCharacters(stripped).replace(/\s+/gu, " ").trim();
  }

  private extractCuratedCommentBodyFromUnknown(value: unknown): string | null {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed.length) return null;
      const parsed = parseJsonFromMixedText(trimmed);
      if (parsed !== null && parsed !== value) {
        const fromParsed = this.extractCuratedCommentBodyFromUnknown(parsed);
        if (fromParsed) return fromParsed;
      }
      const normalized = this.normalizeCuratedCommentBody(trimmed);
      return normalized.length > 0 ? normalized : null;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const extracted = this.extractCuratedCommentBodyFromUnknown(entry);
        if (extracted) return extracted;
      }
      return null;
    }
    if (!isRecord(value)) return null;
    const keys = ["body", "comment", "reply", "text", "output", "result", "content"] as const;
    for (const key of keys) {
      const extracted = this.extractCuratedCommentBodyFromUnknown(value[key]);
      if (extracted) return extracted;
    }
    return null;
  }

  private validateCuratedCommentCandidate(input: {
    candidate: string;
    draftBody: string;
    context: CommentCurationContext;
  }): { ok: true } | { ok: false; reason: string } {
    const candidate = input.candidate.trim();
    if (candidate.length < 10) {
      return { ok: false, reason: "too_short" };
    }
    if (candidate.length > 280) {
      return { ok: false, reason: "too_long" };
    }
    if (COMMENT_ECHO_PREFIX_PATTERN.test(candidate)) {
      return { ok: false, reason: "frame_prefix" };
    }
    if (COMMENT_PROMPT_WRAPPER_PATTERN.test(candidate)) {
      return { ok: false, reason: "prompt_wrapper" };
    }
    const normalizedCandidate = normalizeCommentText(candidate);
    const normalizedDraft = normalizeCommentText(input.draftBody);
    if (normalizedCandidate === normalizedDraft) {
      return { ok: false, reason: "same_as_draft" };
    }
    const draftOverlap = computeTokenOverlapRatio(candidate, input.draftBody);
    if (draftOverlap >= 0.86) {
      return { ok: false, reason: "too_similar_to_draft" };
    }
    if (hasLongNormalizedPhraseOverlap(candidate, input.draftBody)) {
      return { ok: false, reason: "contains_draft_phrase" };
    }
    if (input.context.postText) {
      const normalizedPostText = normalizeCommentText(input.context.postText);
      if (normalizedCandidate === normalizedPostText) {
        return { ok: false, reason: "same_as_post_text" };
      }
      const overlap = computeTokenOverlapRatio(candidate, input.context.postText);
      if (overlap >= 0.86) {
        return { ok: false, reason: "too_similar_to_post_text" };
      }
      if (hasLongNormalizedPhraseOverlap(candidate, input.context.postText)) {
        return { ok: false, reason: "contains_post_phrase" };
      }
    }
    if (input.context.mediaSummary) {
      const overlap = computeTokenOverlapRatio(candidate, input.context.mediaSummary);
      if (overlap >= 0.9) {
        return { ok: false, reason: "too_similar_to_media_summary" };
      }
      if (hasLongNormalizedPhraseOverlap(candidate, input.context.mediaSummary)) {
        return { ok: false, reason: "contains_media_summary_phrase" };
      }
    }
    if (input.context.threadSummary) {
      const overlap = computeTokenOverlapRatio(candidate, input.context.threadSummary);
      if (overlap >= 0.82) {
        return { ok: false, reason: "too_similar_to_thread_summary" };
      }
      if (hasLongNormalizedPhraseOverlap(candidate, input.context.threadSummary)) {
        return { ok: false, reason: "contains_thread_phrase" };
      }
    }
    if (input.context.payloadHint) {
      const overlap = computeTokenOverlapRatio(candidate, input.context.payloadHint);
      if (overlap >= 0.84) {
        return { ok: false, reason: "too_similar_to_payload_hint" };
      }
      if (hasLongNormalizedPhraseOverlap(candidate, input.context.payloadHint)) {
        return { ok: false, reason: "contains_payload_hint_phrase" };
      }
    }
    if (!this.hasTargetContextAnchor(candidate, input.context)) {
      return { ok: false, reason: "missing_target_context_anchor" };
    }
    return { ok: true };
  }

  private hasTargetContextAnchor(
    candidate: string,
    context: CommentCurationContext,
  ): boolean {
    const anchorSource = [
      context.postText ?? "",
      context.mediaSummary ?? "",
      context.threadSummary ?? "",
    ]
      .filter((part) => part.trim().length > 0)
      .join(" \n ");
    const anchorTokens = Array.from(new Set(tokenizeCommentText(anchorSource)));
    if (anchorTokens.length < 3) {
      return true;
    }
    const candidateTokens = new Set(tokenizeCommentText(candidate));
    if (candidateTokens.size === 0) {
      return false;
    }
    const minimumOverlap = anchorTokens.length >= 12 ? 2 : 1;
    let overlap = 0;
    for (const token of anchorTokens) {
      if (candidateTokens.has(token)) {
        overlap += 1;
        if (overlap >= minimumOverlap) {
          return true;
        }
      }
    }
    return false;
  }

  private isDraftCommentEchoLike(body: string, context: CommentCurationContext): boolean {
    const trimmed = body.trim();
    if (!trimmed.length) return true;
    if (COMMENT_ECHO_PREFIX_PATTERN.test(trimmed)) return true;
    if (COMMENT_PROMPT_WRAPPER_PATTERN.test(trimmed)) return true;
    if (
      context.postText &&
      normalizeCommentText(trimmed) === normalizeCommentText(context.postText)
    ) {
      return true;
    }
    if (context.postText && computeTokenOverlapRatio(trimmed, context.postText) >= 0.9) {
      return true;
    }
    if (
      context.postText &&
      hasLongNormalizedPhraseOverlap(trimmed, context.postText)
    ) {
      return true;
    }
    if (context.mediaSummary && computeTokenOverlapRatio(trimmed, context.mediaSummary) >= 0.9) {
      return true;
    }
    if (
      context.mediaSummary &&
      hasLongNormalizedPhraseOverlap(trimmed, context.mediaSummary)
    ) {
      return true;
    }
    if (context.threadSummary && computeTokenOverlapRatio(trimmed, context.threadSummary) >= 0.82) {
      return true;
    }
    if (
      context.threadSummary &&
      hasLongNormalizedPhraseOverlap(trimmed, context.threadSummary)
    ) {
      return true;
    }
    if (context.payloadHint && computeTokenOverlapRatio(trimmed, context.payloadHint) >= 0.84) {
      return true;
    }
    if (
      context.payloadHint &&
      hasLongNormalizedPhraseOverlap(trimmed, context.payloadHint)
    ) {
      return true;
    }
    return false;
  }

  private async loadEngagementDecisionContext(input: {
    action: "like" | "repost";
    postId: number;
    payload: Record<string, unknown>;
  }): Promise<EngagementDecisionContext> {
    const context: EngagementDecisionContext = {
      postAuthorHandle: null,
      postText: null,
      mediaSummary: null,
      payloadHint: this.extractCommentPayloadHint(input.payload),
      memorySummary: await this.loadEngagementMemorySummary({
        action: input.action,
        postId: input.postId,
        commentId: null,
        payload: input.payload,
      }),
    };
    const callAgentChatBridge = this.ctx.callAgentChatBridge;
    if (!callAgentChatBridge) return context;
    try {
      const postResponse = await callAgentChatBridge({
        action: "find_post",
        postId: input.postId,
      });
      const postRecord = this.extractPostRecordForCommentCuration(
        postResponse,
        input.postId,
      );
      if (!postRecord) return context;
      const author = isRecord(postRecord.author) ? postRecord.author : null;
      context.postAuthorHandle =
        asNonEmptyString(author?.handle) ??
        asNonEmptyString(postRecord.authorHandle);
      context.postText =
        asNonEmptyString(postRecord.textBody) ??
        asNonEmptyString(postRecord.caption) ??
        asNonEmptyString(postRecord.body);
      context.mediaSummary = this.summarizePostMediaForComment(postRecord);
      return context;
    } catch (error: unknown) {
      await this.ctx.memory
        .recordWrite({
          type: "engagement_post_lookup_failed",
          at: nowIso(),
          action: input.action,
          postId: input.postId,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      return context;
    }
  }

  private buildEngagementDecisionPrompt(input: {
    action: "like" | "repost";
    postId: number;
    targetHash: string;
    context: EngagementDecisionContext;
  }): string {
    const actionLabel = input.action === "like" ? "like" : "repost";
    const contextLines = [
      `postId: ${input.postId}`,
      input.context.postAuthorHandle
        ? `postAuthor: @${input.context.postAuthorHandle.replace(/^@+/u, "")}`
        : null,
      input.context.postText ? `postText: ${input.context.postText}` : null,
      input.context.mediaSummary ? `mediaContext: ${input.context.mediaSummary}` : null,
      input.context.payloadHint ? `requestHint: ${input.context.payloadHint}` : null,
      input.context.memorySummary ? `memoryContext: ${input.context.memorySummary}` : null,
    ].filter((entry): entry is string => Boolean(entry));
    return [
      "Decide whether the runtime should execute this social engagement action now.",
      "Return strict JSON only.",
      "Rules:",
      "- shouldExecute=true when context suggests this action is relevant and non-spammy.",
      "- Prefer own-post engagement when it is active and high-signal; avoid repetitive low-value actions.",
      "- reason must be short (6-120 chars) and action-specific.",
      `- action must be exactly \"${actionLabel}\".`,
      "- target fields must match exactly.",
      "Return strict JSON ONLY with this exact shape:",
      `{"action":"${actionLabel}","target":{"postId":${input.postId},"commentId":null,"targetHash":"${input.targetHash}"},"shouldExecute":true,"reason":"<short reason>"}`,
      `Action: ${actionLabel}`,
      "Context:",
      ...contextLines.map((line) => `- ${line}`),
    ].join("\n");
  }

  private async evaluateEngagementActionWithOpenClaw(input: {
    command: Command;
    action: "like" | "repost";
    postId: number;
    payload: Record<string, unknown>;
    targetHash: string;
    lifecycleIdempotencyKey: string;
  }): Promise<EngagementDecision> {
    const context = await this.loadEngagementDecisionContext({
      action: input.action,
      postId: input.postId,
      payload: input.payload,
    });
    const runOpenClawPrompt = this.ctx.runOpenClawPrompt;
    if (!runOpenClawPrompt) {
      return {
        shouldExecute: false,
        reason: "openclaw_required_unavailable",
        source: "openclaw",
        contract: null,
      };
    }
    try {
      this.updateActionLifecycle({
        command: input.command,
        action: input.action,
        idempotencyKey: input.lifecycleIdempotencyKey,
        target: {
          postId: input.postId,
          commentId: null,
          targetHash: input.targetHash,
        },
        state: "llm_running",
      });
      const prompt = this.buildEngagementDecisionPrompt({
        action: input.action,
        postId: input.postId,
        targetHash: input.targetHash,
        context,
      });
      const result = await runOpenClawPrompt({
        prompt,
        purpose: "engagement_action_decision",
      });
      const contract =
        (result
          ? this.extractActionContractFromUnknown({
            value: result.parsed,
            action: input.action,
            expectedPostId: input.postId,
            expectedCommentId: null,
            expectedTargetHash: input.targetHash,
          }) ??
            this.extractActionContractFromUnknown({
              value: result.payloadText,
              action: input.action,
              expectedPostId: input.postId,
              expectedCommentId: null,
              expectedTargetHash: input.targetHash,
            }) ??
            this.extractActionContractFromUnknown({
              value: result.raw,
              action: input.action,
              expectedPostId: input.postId,
              expectedCommentId: null,
              expectedTargetHash: input.targetHash,
            })
          : null) ?? null;
      if (!contract) {
        await this.ctx.memory
          .recordWrite({
            type: "engagement_action_decision_missing",
            at: nowIso(),
            commandId: input.command.id,
            action: input.action,
            postId: input.postId,
          })
          .catch(() => undefined);
        return {
          shouldExecute: false,
          reason: "openclaw_contract_invalid",
          source: "openclaw",
          contract: null,
        };
      }
      return {
        shouldExecute: contract.shouldExecute,
        reason: contract.reason,
        source: "openclaw",
        contract,
      };
    } catch (error: unknown) {
      await this.ctx.memory
        .recordWrite({
          type: "engagement_action_decision_failed",
          at: nowIso(),
          commandId: input.command.id,
          action: input.action,
          postId: input.postId,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      return {
        shouldExecute: false,
        reason: "openclaw_decision_failed",
        source: "openclaw",
        contract: null,
      };
    }
  }

  private async executeWriteVote(command: Command): Promise<CommandOutcome> {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) return this.failedOutcome(command, "Invalid payload for write.votePost.");
    let resolvedTarget: EngagementTargetCandidate | null = null;
    try {
      resolvedTarget =
        (await this.resolveEngagementTargetForDirective({
          payload,
          action: "like",
          commandId: command.id,
        })) ?? null;
    } catch (error: unknown) {
      if (this.isNoTargetDiscoveryFailure(error)) {
        return this.failedOutcome(
          command,
          "No target post candidates found after discovery scan.",
          "no_target_candidates",
        );
      }
      throw error;
    }
    if (!resolvedTarget) {
      throw new RequeueCommandError("like_target_resolution_waiting_for_context:no_target");
    }
    const postId = resolvedTarget.postId;
    payload.postId = postId;
    payload.targetPostId = postId;
    const expectedTarget = {
      postId,
      commentId: null,
      targetHash: buildTargetHash({
        postId,
        commentId: null,
      }),
    };
    const lockMatch = isTargetLockMatch({
      payload,
      expected: expectedTarget,
    });
    if (!lockMatch.ok) {
      return this.failedOutcome(
        command,
        `Target lock mismatch: ${lockMatch.reason}.`,
        "target_lock_mismatch",
      );
    }
    const target = applyTargetLock(payload, {
      postId,
      commentId: null,
    });
    const idempotencyKey = this.buildActionIdempotencyKey({
      command,
      action: "like",
      postId: target.postId,
      commentId: target.commentId,
    });
    const dedupe = this.beginActionLifecycle({
      command,
      action: "like",
      idempotencyKey,
      target,
      state: "context_ready",
    });
    if (!dedupe.allowed) {
      if (dedupe.requeue) {
        throw new RequeueCommandError(
          `engagement_like_waiting_for_backoff:${dedupe.reason}`,
        );
      }
      return this.successOutcome(command, {
        skipped: true,
        action: "like",
        postId: target.postId,
        decision: dedupe.reason,
      });
    }
    const sourceDirectiveId =
      asNonEmptyString(payload.sourceDirectiveId) ??
      command.sourceDirectiveId ??
      null;
    const sourceDirectiveActionNonce =
      asNonEmptyString(payload.sourceDirectiveActionNonce) ??
      command.actionNonce ??
      null;
    const voteRaw =
      typeof payload.vote === "number" && Number.isFinite(payload.vote)
        ? Math.trunc(payload.vote)
        : 1;
    const vote = voteRaw > 0 ? 1 : voteRaw < 0 ? -1 : 0;
    try {
      const grantId = await this.preflightGrantForAction({
        command,
        payload,
        action: "like",
        lifecycle: {
          idempotencyKey,
          target,
        },
      });
      if (vote === 1) {
        const decision = await this.evaluateEngagementActionWithOpenClaw({
          command,
          action: "like",
          postId,
          payload,
          targetHash: target.targetHash,
          lifecycleIdempotencyKey: idempotencyKey,
        });
        const needsRequeue =
          !decision.shouldExecute &&
          decision.reason.trim().toLowerCase().startsWith("openclaw_");
        if (needsRequeue) {
          throw new RequeueCommandError(
            `engagement_like_waiting_for_openclaw:${decision.reason}`,
          );
        }
        await this.ctx.memory
          .recordWrite({
            type: "engagement_action_decision",
            at: nowIso(),
            commandId: command.id,
            action: "like",
            postId,
            shouldExecute: decision.shouldExecute,
            reason: decision.reason,
            source: decision.source,
          })
          .catch(() => undefined);
        if (!decision.shouldExecute) {
          const explicitRequested =
            command.forceNow === true ||
            payload.explicitPublishRequested === true ||
            payload.forceNow === true ||
            payload.userExplicitRequest === true ||
            command.runtimeOrigin === "director_directive" ||
            command.runtimeOrigin === "pending_promotion";
          if (explicitRequested) {
            await this.ctx.memory
              .recordWrite({
                type: "engagement_action_decision_overridden",
                at: nowIso(),
                commandId: command.id,
                action: "like",
                postId,
                reason: decision.reason,
                source: decision.source,
                override: "explicit_request",
              })
              .catch(() => undefined);
          } else {
            this.updateActionLifecycle({
              command,
              action: "like",
              idempotencyKey,
              target,
              state: "acked",
              lastError: null,
            });
            return this.successOutcome(command, {
              skipped: true,
              action: "like",
              postId,
              decision: decision.reason,
            });
          }
        }
      }
      this.updateActionLifecycle({
        command,
        action: "like",
        idempotencyKey,
        target,
        state: "action_running",
      });
      const result = await this.agent().votePost.mutate({
        postId,
        vote,
        grantId,
        ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
        ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
      });
      this.updateActionLifecycle({
        command,
        action: "like",
        idempotencyKey,
        target,
        state: "acked",
        lastError: null,
      });
      return this.successOutcome(command, result);
    } catch (error: unknown) {
      if (error instanceof RequeueCommandError) {
        this.updateActionLifecycle({
          command,
          action: "like",
          idempotencyKey,
          target,
          state: "requeue",
          lastError: error.message,
        });
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (this.isOwnerCapabilityDeniedError(error)) {
        this.registerOwnerCapabilityCooldown({
          action: "like",
          targetHash: target.targetHash,
          reason: "not_granted",
        });
      }
      this.updateActionLifecycle({
        command,
        action: "like",
        idempotencyKey,
        target,
        state: "failed",
        lastError: message,
      });
      throw error;
    }
  }

  private async executeWriteRepost(command: Command): Promise<CommandOutcome> {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) return this.failedOutcome(command, "Invalid payload for write.repostPost.");
    let resolvedTarget: EngagementTargetCandidate | null = null;
    try {
      resolvedTarget =
        (await this.resolveEngagementTargetForDirective({
          payload,
          action: "repost",
          commandId: command.id,
        })) ?? null;
    } catch (error: unknown) {
      if (this.isNoTargetDiscoveryFailure(error)) {
        return this.failedOutcome(
          command,
          "No target post candidates found after discovery scan.",
          "no_target_candidates",
        );
      }
      throw error;
    }
    if (!resolvedTarget) {
      throw new RequeueCommandError("repost_target_resolution_waiting_for_context:no_target");
    }
    const postId = resolvedTarget.postId;
    payload.postId = postId;
    payload.targetPostId = postId;
    const expectedTarget = {
      postId,
      commentId: null,
      targetHash: buildTargetHash({
        postId,
        commentId: null,
      }),
    };
    const lockMatch = isTargetLockMatch({
      payload,
      expected: expectedTarget,
    });
    if (!lockMatch.ok) {
      return this.failedOutcome(
        command,
        `Target lock mismatch: ${lockMatch.reason}.`,
        "target_lock_mismatch",
      );
    }
    const target = applyTargetLock(payload, {
      postId,
      commentId: null,
    });
    const idempotencyKey = this.buildActionIdempotencyKey({
      command,
      action: "repost",
      postId: target.postId,
      commentId: target.commentId,
    });
    const dedupe = this.beginActionLifecycle({
      command,
      action: "repost",
      idempotencyKey,
      target,
      state: "context_ready",
    });
    if (!dedupe.allowed) {
      if (dedupe.requeue) {
        throw new RequeueCommandError(
          `engagement_repost_waiting_for_backoff:${dedupe.reason}`,
        );
      }
      return this.successOutcome(command, {
        skipped: true,
        action: "repost",
        postId: target.postId,
        decision: dedupe.reason,
      });
    }
    const sourceDirectiveId =
      asNonEmptyString(payload.sourceDirectiveId) ??
      command.sourceDirectiveId ??
      null;
    const sourceDirectiveActionNonce =
      asNonEmptyString(payload.sourceDirectiveActionNonce) ??
      command.actionNonce ??
      null;
    const repost = payload.repost === 0 ? 0 : 1;
    try {
      const grantId = await this.preflightGrantForAction({
        command,
        payload,
        action: "repost",
        lifecycle: {
          idempotencyKey,
          target,
        },
      });
      if (repost === 1) {
        const decision = await this.evaluateEngagementActionWithOpenClaw({
          command,
          action: "repost",
          postId,
          payload,
          targetHash: target.targetHash,
          lifecycleIdempotencyKey: idempotencyKey,
        });
        const needsRequeue =
          !decision.shouldExecute &&
          decision.reason.trim().toLowerCase().startsWith("openclaw_");
        if (needsRequeue) {
          throw new RequeueCommandError(
            `engagement_repost_waiting_for_openclaw:${decision.reason}`,
          );
        }
        await this.ctx.memory
          .recordWrite({
            type: "engagement_action_decision",
            at: nowIso(),
            commandId: command.id,
            action: "repost",
            postId,
            shouldExecute: decision.shouldExecute,
            reason: decision.reason,
            source: decision.source,
          })
          .catch(() => undefined);
        if (!decision.shouldExecute) {
          const explicitRequested =
            command.forceNow === true ||
            payload.explicitPublishRequested === true ||
            payload.forceNow === true ||
            payload.userExplicitRequest === true ||
            command.runtimeOrigin === "director_directive" ||
            command.runtimeOrigin === "pending_promotion";
          if (explicitRequested) {
            await this.ctx.memory
              .recordWrite({
                type: "engagement_action_decision_overridden",
                at: nowIso(),
                commandId: command.id,
                action: "repost",
                postId,
                reason: decision.reason,
                source: decision.source,
                override: "explicit_request",
              })
              .catch(() => undefined);
          } else {
            this.updateActionLifecycle({
              command,
              action: "repost",
              idempotencyKey,
              target,
              state: "acked",
              lastError: null,
            });
            return this.successOutcome(command, {
              skipped: true,
              action: "repost",
              postId,
              decision: decision.reason,
            });
          }
        }
      }
      this.updateActionLifecycle({
        command,
        action: "repost",
        idempotencyKey,
        target,
        state: "action_running",
      });
      const result = await this.agent().repostPost.mutate({
        postId,
        repost,
        grantId,
        ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
        ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
      });
      this.updateActionLifecycle({
        command,
        action: "repost",
        idempotencyKey,
        target,
        state: "acked",
        lastError: null,
      });
      return this.successOutcome(command, result);
    } catch (error: unknown) {
      if (error instanceof RequeueCommandError) {
        this.updateActionLifecycle({
          command,
          action: "repost",
          idempotencyKey,
          target,
          state: "requeue",
          lastError: error.message,
        });
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (this.isOwnerCapabilityDeniedError(error)) {
        this.registerOwnerCapabilityCooldown({
          action: "repost",
          targetHash: target.targetHash,
          reason: "not_granted",
        });
      }
      this.updateActionLifecycle({
        command,
        action: "repost",
        idempotencyKey,
        target,
        state: "failed",
        lastError: message,
      });
      throw error;
    }
  }

  private async executeDelegatedFollowAction(input: {
    command: Command;
    payload: Record<string, unknown>;
    action: "follow" | "follow_engagers" | "follow_accept";
  }): Promise<CommandOutcome> {
    const target = this.resolveFollowTargetMode(input.payload);
    const actionLabel = input.action === "follow_engagers"
      ? "follow-engagers"
      : input.action === "follow_accept"
        ? "follow-accept"
        : "follow";
    const applyFollowForHandles = async (handles: string[]) => {
      const followed: string[] = [];
      const alreadyFollowed: string[] = [];
      const notFound: string[] = [];
      const self: string[] = [];
      const blocked: string[] = [];
      const failed: string[] = [];
      const errors: Array<{ handle: string; error: string }> = [];
      for (const handle of handles) {
        const attempt = await this.attemptFollowHandle({
          target,
          handle,
          action: "follow_user",
        });
        if (attempt.status === "followed") {
          followed.push(attempt.handle);
          continue;
        }
        if (attempt.status === "already_followed") {
          alreadyFollowed.push(attempt.handle);
          continue;
        }
        if (attempt.status === "not_found") {
          notFound.push(attempt.handle);
          if (attempt.error) {
            errors.push({ handle: attempt.handle, error: attempt.error });
          }
          continue;
        }
        if (attempt.status === "self") {
          self.push(attempt.handle);
          if (attempt.error) {
            errors.push({ handle: attempt.handle, error: attempt.error });
          }
          continue;
        }
        if (attempt.status === "blocked") {
          blocked.push(attempt.handle);
          if (attempt.error) {
            errors.push({ handle: attempt.handle, error: attempt.error });
          }
          continue;
        }
        failed.push(attempt.handle);
        if (attempt.error) {
          errors.push({ handle: attempt.handle, error: attempt.error });
        }
      }
      return {
        followed,
        alreadyFollowed,
        notFound,
        self,
        blocked,
        failed,
        errors,
      };
    };

    if (input.action === "follow") {
      const handles = this.collectFollowHandlesFromPayload(input.payload);
      if (handles.length === 0) {
        return this.successOutcome(input.command, {
          followAction: actionLabel,
          followInputMissing: true,
          chatCompletion: {
            body: "Usage: /follow [for-me|as-agent] @handle (you can include multiple handles).",
            metadata: {
              automated: true,
              sourceContext: "CHAT",
              actionPreview: {
                type: "follow",
                status: "failed",
                title: "Follow input missing",
              },
            },
          },
        });
      }
      const applied = await applyFollowForHandles(handles);
      const summaryText = this.buildFollowSummaryText({
        target,
        followed: applied.followed,
        alreadyFollowed: applied.alreadyFollowed,
        notFound: applied.notFound,
        self: applied.self,
        blocked: applied.blocked,
        failed: applied.failed,
      });
      await this.recordCommandLifecycleCheckpoint({
        command: input.command,
        stage: "write_mutation",
        status:
          applied.followed.length > 0 || applied.alreadyFollowed.length > 0
            ? "ok"
            : "failed",
        metadata: {
          action: actionLabel,
          target,
          requestedCount: handles.length,
          followedCount: applied.followed.length,
          alreadyFollowedCount: applied.alreadyFollowed.length,
          notFoundCount: applied.notFound.length,
          selfCount: applied.self.length,
          blockedCount: applied.blocked.length,
          failedCount: applied.failed.length,
        },
      });
      return this.successOutcome(input.command, {
        followAction: actionLabel,
        target,
        requestedHandles: handles,
        followedHandles: applied.followed,
        alreadyFollowedHandles: applied.alreadyFollowed,
        notFoundHandles: applied.notFound,
        selfHandles: applied.self,
        blockedHandles: applied.blocked,
        failedHandles: applied.failed,
        errors: applied.errors,
        chatCompletion: {
          body: summaryText,
          metadata: {
            automated: true,
            sourceContext: "CHAT",
            actionPreview: {
              type: "follow",
              status:
                applied.followed.length > 0 || applied.alreadyFollowed.length > 0
                  ? "success"
                  : "failed",
              title: "Follow update",
              summary: summaryText,
            },
          },
        },
      });
    }

    if (input.action === "follow_engagers") {
      const requestedCount = this.resolveFollowEngagersCount(input.payload);
      const lookbackDays = asPositiveInt(input.payload.followLookbackDays) ?? 120;
      let candidateHandles: string[] = [];
      try {
        const lookup = await this.callAgentBridgeLookupCached(
          {
            action: "browse_top_engagers",
            limit: Math.min(60, Math.max(24, requestedCount * 4)),
            windowHours: lookbackDays * 24,
          },
          4_000,
        );
        candidateHandles = this.extractTopEngagerHandlesFromLookup(lookup.value, 60);
      } catch (error: unknown) {
        return this.failedOutcome(
          input.command,
          `Follow-engagers lookup failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "follow_engagers_lookup_failed",
        );
      }
      if (candidateHandles.length === 0) {
        const body =
          target === "agent"
            ? `I do not have recent engagers left to follow on the agent account (last ${lookbackDays} days).`
            : `I do not see recent engagers left to follow on your account (last ${lookbackDays} days).`;
        return this.successOutcome(input.command, {
          followAction: actionLabel,
          target,
          requestedCount,
          lookbackDays,
          candidatesFound: 0,
          chatCompletion: {
            body,
            metadata: {
              automated: true,
              sourceContext: "CHAT",
              actionPreview: {
                type: "follow",
                status: "success",
                title: "No follow candidates",
                summary: body,
              },
            },
          },
        });
      }
      const selectedHandles = candidateHandles.slice(0, requestedCount);
      const applied = await applyFollowForHandles(selectedHandles);
      const remainingCount = Math.max(0, candidateHandles.length - selectedHandles.length);
      const summaryText = this.buildFollowSummaryText({
        target,
        followed: applied.followed,
        alreadyFollowed: applied.alreadyFollowed,
        notFound: applied.notFound,
        self: applied.self,
        blocked: applied.blocked,
        failed: applied.failed,
        remainingCount,
        followEngagers: true,
      });
      await this.recordCommandLifecycleCheckpoint({
        command: input.command,
        stage: "write_mutation",
        status:
          applied.followed.length > 0 || applied.alreadyFollowed.length > 0
            ? "ok"
            : "failed",
        metadata: {
          action: actionLabel,
          target,
          requestedCount,
          candidatesFound: candidateHandles.length,
          followedCount: applied.followed.length,
          alreadyFollowedCount: applied.alreadyFollowed.length,
          failedCount:
            applied.failed.length +
            applied.notFound.length +
            applied.self.length +
            applied.blocked.length,
          remainingCount,
        },
      });
      return this.successOutcome(input.command, {
        followAction: actionLabel,
        target,
        requestedCount,
        lookbackDays,
        candidateHandles,
        selectedHandles,
        followedHandles: applied.followed,
        alreadyFollowedHandles: applied.alreadyFollowed,
        notFoundHandles: applied.notFound,
        selfHandles: applied.self,
        blockedHandles: applied.blocked,
        failedHandles: applied.failed,
        errors: applied.errors,
        remainingCount,
        chatCompletion: {
          body: summaryText,
          metadata: {
            automated: true,
            sourceContext: "CHAT",
            actionPreview: {
              type: "follow",
              status:
                applied.followed.length > 0 || applied.alreadyFollowed.length > 0
                  ? "success"
                  : "failed",
              title: "Follow-engagers update",
              summary: summaryText,
            },
          },
        },
      });
    }

    const followSelections = this.collectFollowSelectionsFromPayload(input.payload)
      .flatMap((entry) => entry.split(","))
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0);
    const explicitHandles = this.collectFollowHandlesFromPayload(input.payload);
    let mappedHandles = [...explicitHandles];
    const wantsAll = followSelections.includes("all");
    const indexSelections = followSelections
      .map((entry) => Number.parseInt(entry, 10))
      .filter((entry) => Number.isFinite(entry) && entry > 0)
      .map((entry) => Math.floor(entry));
    if (wantsAll || indexSelections.length > 0) {
      try {
        const followCount = this.resolveFollowEngagersCount(input.payload);
        const lookup = await this.callAgentBridgeLookupCached(
          {
            action: "browse_top_engagers",
            limit: Math.min(60, Math.max(24, followCount * 4)),
            windowHours: (asPositiveInt(input.payload.followLookbackDays) ?? 120) * 24,
          },
          4_000,
        );
        const rankedHandles = this.extractTopEngagerHandlesFromLookup(lookup.value, 60);
        if (wantsAll) {
          mappedHandles = [...mappedHandles, ...rankedHandles.slice(0, followCount)];
        } else {
          mappedHandles = [
            ...mappedHandles,
            ...indexSelections
              .map((value) => rankedHandles[value - 1] ?? null)
              .filter((value): value is string => Boolean(value)),
          ];
        }
      } catch (error: unknown) {
        return this.failedOutcome(
          input.command,
          `Follow-accept lookup failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "follow_accept_lookup_failed",
        );
      }
    }
    const targetHandles = Array.from(new Set(mappedHandles)).slice(0, 24);
    if (targetHandles.length === 0) {
      return this.successOutcome(input.command, {
        followAction: actionLabel,
        target,
        followInputMissing: true,
        chatCompletion: {
          body:
            "I do not have a pending follow suggestion list for this request. Ask for suggestions first, then confirm with handles or indexes.",
          metadata: {
            automated: true,
            sourceContext: "CHAT",
            actionPreview: {
              type: "follow",
              status: "failed",
              title: "Follow accept pending list missing",
            },
          },
        },
      });
    }

    const applied = await applyFollowForHandles(targetHandles);
    const summaryText = this.buildFollowSummaryText({
      target,
      followed: applied.followed,
      alreadyFollowed: applied.alreadyFollowed,
      notFound: applied.notFound,
      self: applied.self,
      blocked: applied.blocked,
      failed: applied.failed,
    });
    await this.recordCommandLifecycleCheckpoint({
      command: input.command,
      stage: "write_mutation",
      status:
        applied.followed.length > 0 || applied.alreadyFollowed.length > 0
          ? "ok"
          : "failed",
      metadata: {
        action: actionLabel,
        target,
        requestedCount: targetHandles.length,
        followedCount: applied.followed.length,
        alreadyFollowedCount: applied.alreadyFollowed.length,
        failedCount:
          applied.failed.length +
          applied.notFound.length +
          applied.self.length +
          applied.blocked.length,
      },
    });
    return this.successOutcome(input.command, {
      followAction: actionLabel,
      target,
      followSelections,
      selectedHandles: targetHandles,
      followedHandles: applied.followed,
      alreadyFollowedHandles: applied.alreadyFollowed,
      notFoundHandles: applied.notFound,
      selfHandles: applied.self,
      blockedHandles: applied.blocked,
      failedHandles: applied.failed,
      errors: applied.errors,
      chatCompletion: {
        body: summaryText,
        metadata: {
          automated: true,
          sourceContext: "CHAT",
          actionPreview: {
            type: "follow",
            status:
              applied.followed.length > 0 || applied.alreadyFollowed.length > 0
                ? "success"
                : "failed",
            title: "Follow-accept update",
            summary: summaryText,
          },
        },
      },
    });
  }

  private async executeGenerateAndQueue(command: Command): Promise<CommandOutcome> {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) {
      return this.failedOutcome(command, "Invalid payload for generate-and-queue command.");
    }

    const delegatedFollowAction = this.resolveDelegatedFollowAction(payload);
    if (delegatedFollowAction) {
      return this.executeDelegatedFollowAction({
        command,
        payload,
        action: delegatedFollowAction,
      });
    }

    if (payload.chatLiteralGenerate === true) {
      return this.executeChatLiteralGenerate(command, payload);
    }

    const sourceDirectiveId =
      asNonEmptyString(payload.sourceDirectiveId) ??
      command.sourceDirectiveId ??
      command.id;
    const sourceDirectiveActionNonce =
      asNonEmptyString(payload.sourceDirectiveActionNonce) ??
      command.actionNonce ??
      null;
    const provenance = asNonEmptyString(payload.provenance);
    const enforcedDraftAction = this.resolveEnforcedDraftAction(payload);
    if (enforcedDraftAction) {
      const scopedDirective = isRecord(payload.directiveScope) ? payload.directiveScope : null;
      const scopedTarget = scopedDirective && isRecord(scopedDirective.target) ? scopedDirective.target : null;
      const hasTargetPostId =
        asPositiveInt(payload.postId) ??
        asPositiveInt(payload.targetPostId) ??
        (scopedDirective
          ? asPositiveInt(scopedDirective.targetPostId) ??
            (scopedTarget ? asPositiveInt(scopedTarget.postId) : null)
          : null);
      if (!hasTargetPostId) {
        let resolvedTarget: EngagementTargetCandidate | null = null;
        try {
          resolvedTarget = await this.resolveEngagementTargetForDirective({
            payload,
            action: enforcedDraftAction,
            commandId: command.id,
          });
        } catch (error: unknown) {
          if (this.isNoTargetDiscoveryFailure(error)) {
            return this.failedOutcome(
              command,
              `No target candidates found for ${enforcedDraftAction} after discovery scan.`,
              "no_target_candidates",
            );
          }
          throw error;
        }
        if (!resolvedTarget) {
          throw new RequeueCommandError(
            `engagement_target_resolution_waiting_for_context:${enforcedDraftAction}:no_target`,
          );
        }
        payload.postId = resolvedTarget.postId;
        payload.targetPostId = resolvedTarget.postId;
        if (enforcedDraftAction === "comment" && resolvedTarget.commentId) {
          payload.commentId = resolvedTarget.commentId;
          payload.parentId = resolvedTarget.commentId;
          payload.targetCommentId = resolvedTarget.commentId;
        }
        const nextScope = isRecord(payload.directiveScope)
          ? { ...payload.directiveScope }
          : ({} as Record<string, unknown>);
        nextScope.targetPostId = resolvedTarget.postId;
        if (enforcedDraftAction === "comment" && resolvedTarget.commentId) {
          nextScope.targetCommentId = resolvedTarget.commentId;
        }
        const nextScopeTarget = isRecord(nextScope.target)
          ? { ...nextScope.target }
          : ({} as Record<string, unknown>);
        nextScopeTarget.postId = resolvedTarget.postId;
        nextScopeTarget.commentId =
          enforcedDraftAction === "comment" ? (resolvedTarget.commentId ?? null) : null;
        nextScope.target = nextScopeTarget;
        payload.directiveScope = nextScope;
      }
    }

    const inlineDrafts = this.extractInlineDrafts(payload);
    const generateInputRaw =
      inlineDrafts.length > 0
        ? null
        : await this.buildGenerateInputWithRuntimeContext(payload, command);
    const generateInput =
      generateInputRaw && inlineDrafts.length === 0
        ? this.applyPermissionGenerateInputConstraints(
            generateInputRaw,
            payload.permissionState,
          )
        : generateInputRaw;
    if (
      generateInputRaw &&
      generateInput &&
      generateInput !== generateInputRaw
    ) {
      await this.ctx.memory
        .recordWrite({
          type: "generate_input_constrained_by_permissions",
          at: nowIso(),
          commandId: command.id,
          sourceDirectiveId: command.sourceDirectiveId ?? null,
          originalKinds: Array.isArray(generateInputRaw.kinds)
            ? generateInputRaw.kinds
            : [],
          constrainedKinds: Array.isArray(generateInput.kinds)
            ? generateInput.kinds
            : [],
          originalKind: asNonEmptyString(generateInputRaw.kind),
          constrainedKind: asNonEmptyString(generateInput.kind),
        })
        .catch(() => undefined);
    }
    let generatedResult: unknown = null;
    if (!inlineDrafts.length) {
      try {
        generatedResult = await this.agent().generate.mutate(
          generateInput ?? this.buildGenerateInput(payload, command),
        );
        await this.recordCommandLifecycleCheckpoint({
          command,
          stage: "generated",
          status: "ok",
          metadata: {
            hasGeneratedResult: Boolean(generatedResult),
          },
        });
      } catch (error: unknown) {
        await this.recordCommandLifecycleCheckpoint({
          command,
          stage: "generated",
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
    const drafts =
      inlineDrafts.length > 0
        ? inlineDrafts
        : this.extractGeneratedDrafts(generatedResult);
    const executableDrafts =
      enforcedDraftAction === null
        ? drafts
        : drafts.filter(
            (draft) => draft.action.trim().toLowerCase() === enforcedDraftAction,
          );
    const permissionFilteredDrafts = executableDrafts.filter((draft) =>
      this.isGeneratedDraftAllowedByPermissionState(
        draft,
        payload.permissionState,
      ),
    );
    if (
      executableDrafts.length > 0 &&
      permissionFilteredDrafts.length !== executableDrafts.length
    ) {
      const droppedActions = executableDrafts
        .filter((draft) => !permissionFilteredDrafts.includes(draft))
        .map((draft) => draft.action.trim().toLowerCase())
        .slice(0, 12);
      await this.ctx.memory
        .recordWrite({
          type: "generate_draft_filtered_by_permissions",
          at: nowIso(),
          commandId: command.id,
          sourceDirectiveId: command.sourceDirectiveId ?? null,
          beforeCount: executableDrafts.length,
          afterCount: permissionFilteredDrafts.length,
          droppedActions,
        })
        .catch(() => undefined);
    }
    if (enforcedDraftAction !== null && executableDrafts.length === 0) {
      await this.ctx.memory
        .recordWrite({
          type: "generate_draft_action_mismatch",
          at: nowIso(),
          commandId: command.id,
          commandKind: command.kind,
          enforcedAction: enforcedDraftAction,
          generatedActions: drafts
            .map((draft) => draft.action.trim().toLowerCase())
            .filter((action) => action.length > 0)
            .slice(0, 12),
          sourceDirectiveId: command.sourceDirectiveId ?? null,
        })
        .catch(() => undefined);
      return this.failedOutcome(
        command,
        `generate returned no executable ${enforcedDraftAction} draft.`,
        "no_executable_draft",
      );
    }
    if (permissionFilteredDrafts.length === 0) {
      if (payload.requireDraftOnly === true) {
        const previewDelivered = await this.sendDraftFailureMessage({
          payload,
          message: "I couldn't generate a draft right now. Please try again.",
        }).catch(() => false);
        const failed = this.failedOutcome(
          command,
          "generate returned no permission-allowed drafts.",
          "no_permitted_drafts",
        );
        return {
          ...failed,
          data: {
            mode: "draft_preview",
            chatDeliveryHandled: previewDelivered,
          },
        };
      }
      return this.failedOutcome(
        command,
        "generate returned no permission-allowed drafts.",
        "no_permitted_drafts",
      );
    }

    const requireDraftOnly = payload.requireDraftOnly === true;
    if (requireDraftOnly) {
      const draftPreview = this.buildDraftPreviewPayload(permissionFilteredDrafts);
      if (!draftPreview) {
        const previewDelivered = await this.sendDraftFailureMessage({
          payload,
          message: "I generated output, but couldn't shape a readable draft preview.",
        }).catch(() => false);
        const failed = this.failedOutcome(
          command,
          "generate returned drafts without previewable text.",
          "draft_preview_missing",
        );
        return {
          ...failed,
          data: {
            mode: "draft_preview",
            chatDeliveryHandled: previewDelivered,
          },
        };
      }
      const previewDelivered = await this.sendDraftPreviewMessage({
        payload,
        preview: draftPreview,
      }).catch(() => false);
      if (!previewDelivered) {
        return this.failedOutcome(
          command,
          "Draft generated, but preview delivery to chat failed.",
          "draft_preview_delivery_failed",
        );
      }
      return this.successOutcome(command, {
        generated: generatedResult,
        draftOnly: true,
        draftCount: permissionFilteredDrafts.length,
        chatDeliveryHandled: previewDelivered,
        preview: {
          summary: draftPreview.summary,
          postKind: draftPreview.draftPostKind,
          mode: draftPreview.draftMode,
          slideCount: draftPreview.draftSlideCount,
        },
      });
    }

    const requireExplicitPublishVerb = payload.requireExplicitPublishVerb === true;
    const explicitPublishRequested = payload.explicitPublishRequested === true;
    if (
      requireExplicitPublishVerb &&
      !explicitPublishRequested &&
      this.shouldEnforceExplicitPublishGate(payload)
    ) {
      const blockedDraftCount = permissionFilteredDrafts.filter((draft) => {
        const action = draft.action.trim().toLowerCase();
        return action === "post" || action === "story";
      }).length;
      if (blockedDraftCount > 0) {
        await this.ctx.memory.recordWrite({
          type: "publish_blocked_missing_explicit_request",
          at: nowIso(),
          commandId: command.id,
          commandKind: command.kind,
          blockedDraftCount,
          sourceDirectiveId: command.sourceDirectiveId ?? null,
        }).catch(() => undefined);
        return this.failedOutcome(
          command,
          "Publish action blocked: explicit post/publish/share/story request required.",
          "publish_verb_required",
        );
      }
    }

    const executedOutcomes: CommandOutcome[] = [];
    for (const draft of permissionFilteredDrafts) {
      if (!draft) continue;
      const draftCommand = this.mapDraftToWriteCommand({
        draft,
        command,
        sourceDirectiveId,
        sourceDirectiveActionNonce,
        provenance,
      });
      if (!draftCommand) continue;
      const outcome = await this.executeCommandFromMappedDraft(draftCommand);
      executedOutcomes.push(outcome);
      if (!outcome.ok) {
        break;
      }
    }

    const firstFailure = executedOutcomes.find((entry) => !entry.ok);
    if (firstFailure) {
      await this.recordCommandLifecycleCheckpoint({
        command,
        stage: "write_mutation",
        status: "failed",
        message: firstFailure.error?.message ?? null,
        metadata: {
          executedCount: executedOutcomes.length,
        },
      });
      return this.failedOutcome(
        command,
        firstFailure.error?.message ?? "generated draft execution failed.",
        firstFailure.error?.code,
      );
    }

    if (executedOutcomes.length > 0) {
      await this.recordCommandLifecycleCheckpoint({
        command,
        stage: "write_mutation",
        status: "ok",
        metadata: {
          executedCount: executedOutcomes.length,
          executedKinds: executedOutcomes.map((entry) => entry.kind),
        },
      });
    }

    return this.successOutcome(command, {
      generated: generatedResult,
      executed: executedOutcomes.map((entry) => ({
        commandId: entry.commandId,
        kind: entry.kind,
        ok: entry.ok,
      })),
    });
  }

  private shouldEnforceExplicitPublishGate(payload: Record<string, unknown>): boolean {
    if (payload.chatLiteralGenerate === true) return false;
    const goal = asNonEmptyString(payload.goal)?.toLowerCase() ?? "";
    if (goal === "chat" || goal === "settings" || goal === "moderation") {
      return false;
    }

    const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
    const commandName = asNonEmptyString(chatContext?.commandName)?.toLowerCase() ?? "";
    if (
      commandName === "follow" ||
      commandName === "follow-engagers" ||
      commandName === "followengagers" ||
      commandName === "follow-accept" ||
      commandName === "followaccept" ||
      commandName === "agent-status" ||
      commandName === "chat-status" ||
      commandName === "settings"
    ) {
      return false;
    }

    const serverIntentHint = isRecord(chatContext?.serverIntentHint)
      ? chatContext.serverIntentHint
      : null;
    const actionFamily =
      asNonEmptyString(serverIntentHint?.actionFamily)?.toLowerCase() ?? "";
    if (
      actionFamily === "conversation" ||
      actionFamily === "settings" ||
      actionFamily === "assist" ||
      actionFamily === "research"
    ) {
      return false;
    }

    return true;
  }

  private parseGeneratedCustomAssetKind(
    value: unknown,
  ): GeneratedCustomAssetKind | null {
    const normalized = asNonEmptyString(value)?.toLowerCase() ?? "";
    if (normalized === "emote") return "emote";
    if (normalized === "sticker") return "sticker";
    if (normalized === "gif") return "gif";
    return null;
  }

  private parseGeneratedCustomAssetScope(
    value: unknown,
  ): GeneratedCustomAssetScope | null {
    const normalized = asNonEmptyString(value)?.toLowerCase() ?? "";
    if (normalized === "mine") return "mine";
    if (normalized === "group") return "group";
    if (normalized === "server") return "server";
    return null;
  }

  private parseGeneratedCustomAssetTransformSpec(
    payload: Record<string, unknown>,
  ): CustomAssetTransformSpec | undefined {
    const explicitRoot = isRecord(payload.generatedCustomAssetSave)
      ? payload.generatedCustomAssetSave
      : null;
    const explicitTransform = isRecord(explicitRoot?.transform)
      ? explicitRoot.transform
      : isRecord(payload.generatedCustomAssetTransform)
        ? payload.generatedCustomAssetTransform
        : null;
    if (!explicitTransform) return undefined;
    const parseNumeric = (
      value: unknown,
      clampMin: number,
      clampMax: number,
    ): number | undefined => {
      if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
      return Math.max(clampMin, Math.min(clampMax, value));
    };
    const parseIntNumeric = (
      value: unknown,
      clampMin: number,
      clampMax: number,
    ): number | undefined => {
      const parsed = parseNumeric(value, clampMin, clampMax);
      return typeof parsed === "number" ? Math.floor(parsed) : undefined;
    };
    const fitRaw = asNonEmptyString(explicitTransform.fit)?.toLowerCase();
    const fit =
      fitRaw === "cover" || fitRaw === "contain" || fitRaw === "inside"
        ? fitRaw
        : undefined;
    const formatRaw = asNonEmptyString(explicitTransform.format)?.toLowerCase();
    const format =
      formatRaw === "gif" ||
      formatRaw === "webp" ||
      formatRaw === "png" ||
      formatRaw === "jpeg"
        ? formatRaw
        : undefined;
    const width = parseIntNumeric(explicitTransform.width, 16, 2048);
    const height = parseIntNumeric(explicitTransform.height, 16, 2048);
    const rotateDeg = parseNumeric(explicitTransform.rotateDeg, -360, 360);
    const brightness = parseNumeric(explicitTransform.brightness, 0.1, 3);
    const contrast = parseNumeric(explicitTransform.contrast, 0.2, 3);
    const saturation = parseNumeric(explicitTransform.saturation, 0, 3);
    const blur = parseNumeric(explicitTransform.blur, 0, 20);
    const sharpen = parseNumeric(explicitTransform.sharpen, 0, 10);
    const quality = parseIntNumeric(explicitTransform.quality, 30, 100);
    const spec: CustomAssetTransformSpec = {
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(fit ? { fit } : {}),
      ...(rotateDeg !== undefined ? { rotateDeg } : {}),
      ...(brightness !== undefined ? { brightness } : {}),
      ...(contrast !== undefined ? { contrast } : {}),
      ...(saturation !== undefined ? { saturation } : {}),
      ...(blur !== undefined ? { blur } : {}),
      ...(sharpen !== undefined ? { sharpen } : {}),
      ...(quality !== undefined ? { quality } : {}),
      ...(format ? { format } : {}),
    };
    if (Object.keys(spec).length === 0) return undefined;
    return spec;
  }

  private async prepareGeneratedCustomAssetForSave(input: {
    command: Command;
    payload: Record<string, unknown>;
    sourcePrompt: string;
    sourceUrl: string;
    sourceMimeType: string;
    intent: GeneratedCustomAssetSaveIntent;
  }): Promise<{
    mediaUrl: string;
    mimeType: string;
    width: number | undefined;
    height: number | undefined;
    isAnimated: boolean | undefined;
    transformNotes: string[];
  }> {
    const fallbackMimeType = input.sourceMimeType;
    const transformSpec = this.parseGeneratedCustomAssetTransformSpec(input.payload);
    try {
      const transformed = await transformCustomAssetMedia({
        sourceUrl: input.sourceUrl,
        sourceMimeType: input.sourceMimeType,
        kind: input.intent.kind,
        ...(transformSpec ? { spec: transformSpec } : {}),
      });
      if (!transformed?.bytes?.byteLength) {
        return {
          mediaUrl: input.sourceUrl,
          mimeType: fallbackMimeType,
          width: undefined,
          height: undefined,
          isAnimated:
            input.intent.kind === "gif" || fallbackMimeType.trim().toLowerCase() === "image/gif"
              ? true
              : undefined,
          transformNotes: ["transform_skipped_empty_output"],
        };
      }

      const fileExt = mimeToExt(transformed.mimeType);
      const uploadFilename = `${input.intent.kind}-${Date.now()}.${fileExt}`;
      const chunkUploaded = await this.uploadBytesViaChunkRoute({
        bytes: transformed.bytes,
        mimeType: transformed.mimeType,
        filename: uploadFilename,
      });
      const uploaded =
        chunkUploaded ??
        this.mapUploadResult(
          await this.agent().uploadDataUri.mutate({
            dataUri: `data:${transformed.mimeType};base64,${transformed.bytes.toString("base64")}`,
          }),
        );
      const transformedMime = transformed.mimeType.trim().toLowerCase();
      return {
        mediaUrl: uploaded.mediaUrl,
        mimeType: transformedMime || fallbackMimeType,
        width:
          typeof transformed.width === "number" && Number.isFinite(transformed.width)
            ? transformed.width
            : undefined,
        height:
          typeof transformed.height === "number" && Number.isFinite(transformed.height)
            ? transformed.height
            : undefined,
        isAnimated:
          input.intent.kind === "gif" || transformedMime === "image/gif" ? true : undefined,
        transformNotes: transformed.notes,
      };
    } catch (error: unknown) {
      await this.ctx.memory
        .recordWrite({
          type: "generated_custom_asset_transform_failed",
          at: nowIso(),
          commandId: input.command.id,
          kind: input.intent.kind,
          sourcePrompt: truncateText(input.sourcePrompt, 220),
          sourceUrl: input.sourceUrl,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      return {
        mediaUrl: input.sourceUrl,
        mimeType: fallbackMimeType,
        width: undefined,
        height: undefined,
        isAnimated:
          input.intent.kind === "gif" || fallbackMimeType.trim().toLowerCase() === "image/gif"
            ? true
            : undefined,
        transformNotes: ["transform_failed_fallback_source"],
      };
    }
  }

  private resolveGeneratedCustomAssetSaveIntent(
    payload: Record<string, unknown>,
    sourcePrompt: string,
  ): GeneratedCustomAssetSaveIntent | null {
    const explicit = isRecord(payload.generatedCustomAssetSave)
      ? payload.generatedCustomAssetSave
      : null;
    if (explicit) {
      const explicitKind = this.parseGeneratedCustomAssetKind(explicit.kind);
      const explicitScope =
        this.parseGeneratedCustomAssetScope(explicit.scope) ?? "mine";
      if (explicitKind) {
        return {
          kind: explicitKind,
          scope: explicitScope,
          nameHint: asNonEmptyString(explicit.nameHint),
        };
      }
    }

    const normalized = sourcePrompt.trim().toLowerCase();
    if (!normalized.length) return null;
    const inferredScope: GeneratedCustomAssetScope =
      /\b(?:group|conversation|this group)\b/iu.test(normalized)
        ? "group"
        : /\b(?:server|guild|channel|this server)\b/iu.test(normalized)
          ? "server"
          : "mine";
    const kindCandidates: Array<{
      kind: GeneratedCustomAssetKind;
      index: number;
    }> = [
      { kind: "emote" as const, index: normalized.search(/\bemote(?:s)?\b/iu) },
      { kind: "sticker" as const, index: normalized.search(/\bsticker(?:s)?\b/iu) },
      { kind: "gif" as const, index: normalized.search(/\bgif(?:s)?\b/iu) },
    ].filter((entry) => entry.index >= 0);
    kindCandidates.sort((a, b) => a.index - b.index);
    const inferredKind = kindCandidates[0]?.kind ?? null;

    const hasSaveVerb = /\b(?:attach|add|save|store|put|set)\b/iu.test(normalized);
    const hasTargetHint = /\b(?:to|as|in|into|for)\b/iu.test(normalized);
    if (hasSaveVerb && hasTargetHint && inferredKind) {
      return { kind: inferredKind, scope: inferredScope, nameHint: null };
    }

    const hasGenerateVerb = /\b(?:generate|create|make|render|draw|design)\b/iu.test(
      normalized,
    );
    if (hasGenerateVerb && inferredKind) {
      return { kind: inferredKind, scope: inferredScope, nameHint: null };
    }
    return null;
  }

  private buildGeneratedCustomAssetName(input: {
    kind: GeneratedCustomAssetKind;
    sourcePrompt: string;
    nameHint: string | null;
  }): string {
    const maxLen = input.kind === "gif" ? 64 : 32;
    const normalized = (input.nameHint ?? input.sourcePrompt)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]+/gu, " ")
      .replace(/[\s-]+/gu, "_")
      .replace(/_+/gu, "_")
      .replace(/^_+|_+$/gu, "")
      .slice(0, maxLen);
    if (normalized.length >= 2) return normalized;
    return `${input.kind}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  }

  private resolveGeneratedAssetServerId(payload: Record<string, unknown>): string | null {
    const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
    return (
      asNonEmptyString(payload.serverId) ??
      asNonEmptyString(payload.chatServerId) ??
      asNonEmptyString(payload.targetServerId) ??
      asNonEmptyString(chatContext?.serverId)
    );
  }

  private async saveGeneratedCustomAsset(input: {
    command: Command;
    payload: Record<string, unknown>;
    intent: GeneratedCustomAssetSaveIntent;
    sourcePrompt: string;
    mediaUrl: string;
    mimeType: string;
    chatTarget: { conversationId?: string; channelId?: string };
  }): Promise<GeneratedCustomAssetSaveResult> {
    if (!this.ctx.callAgentChatBridge) {
      throw new Error("chat_bridge_unavailable");
    }

    if (input.intent.scope === "group" && !input.chatTarget.conversationId) {
      throw new Error("group_custom_asset_requires_conversation_context");
    }

    const serverId = this.resolveGeneratedAssetServerId(input.payload);
    if (input.intent.scope === "server" && !serverId) {
      throw new Error("server_custom_asset_requires_server_id");
    }

    const name = this.buildGeneratedCustomAssetName({
      kind: input.intent.kind,
      sourcePrompt: input.sourcePrompt,
      nameHint: input.intent.nameHint,
    });

    const prepared = await this.prepareGeneratedCustomAssetForSave({
      command: input.command,
      payload: input.payload,
      sourcePrompt: input.sourcePrompt,
      sourceUrl: input.mediaUrl,
      sourceMimeType: input.mimeType,
      intent: input.intent,
    });

    const result = await this.ctx.callAgentChatBridge({
      action: "save_custom_asset",
      kind: input.intent.kind,
      scope: input.intent.scope,
      name,
      url: prepared.mediaUrl,
      ...(input.intent.kind === "gif" ? { previewUrl: prepared.mediaUrl } : {}),
      mimeType: prepared.mimeType,
      ...(prepared.width !== undefined ? { width: prepared.width } : {}),
      ...(prepared.height !== undefined ? { height: prepared.height } : {}),
      ...(prepared.isAnimated !== undefined
        ? { isAnimated: prepared.isAnimated }
        : {}),
      ...(input.chatTarget.conversationId
        ? { conversationId: input.chatTarget.conversationId }
        : {}),
      ...(serverId ? { serverId } : {}),
    });

    if (prepared.transformNotes.length > 0) {
      await this.ctx.memory
        .recordWrite({
          type: "generated_custom_asset_saved",
          at: nowIso(),
          commandId: input.command.id,
          kind: input.intent.kind,
          scope: input.intent.scope,
          sourceUrl: input.mediaUrl,
          savedUrl: prepared.mediaUrl,
          transformNotes: prepared.transformNotes,
        })
        .catch(() => undefined);
    }

    const resultRecord = isRecord(result) ? result : null;
    const savedRecord = resultRecord && isRecord(resultRecord.saved)
      ? resultRecord.saved
      : null;
    const id =
      savedRecord && typeof savedRecord.id === "number" && Number.isFinite(savedRecord.id)
        ? Math.floor(savedRecord.id)
        : null;
    return {
      kind: input.intent.kind,
      scope: input.intent.scope,
      name,
      id,
    };
  }

  private resolveGeneratedAssetType(value: unknown): GeneratedAssetType {
    const normalized = asNonEmptyString(value)?.toLowerCase() ?? "image";
    if (normalized === "gif") return "gif";
    if (normalized === "pdf") return "pdf";
    if (normalized === "csv") return "csv";
    if (normalized === "code") return "code";
    if (normalized === "file") return "file";
    if (normalized === "txt") return "txt";
    if (normalized === "md") return "md";
    return "image";
  }

  private resolveGeneratedAttachmentMimeType(input: {
    generatedAssetType: GeneratedAssetType;
    mediaUrl: string;
    mediaType?: "image" | "video";
  }): string {
    const fromUrl = inferMimeTypeFromUrl(input.mediaUrl);
    if (fromUrl && fromUrl !== "application/octet-stream") return fromUrl;
    if (input.generatedAssetType === "gif") return "image/gif";
    if (input.generatedAssetType === "pdf") return "application/pdf";
    if (input.generatedAssetType === "csv") return "text/csv";
    if (input.generatedAssetType === "md") return "text/markdown";
    if (input.generatedAssetType === "txt") return "text/plain";
    if (input.generatedAssetType === "code") return "text/plain";
    if (input.mediaType === "video") return "video/mp4";
    return "image/png";
  }

  private async executeChatLiteralGenerate(
    command: Command,
    payload: Record<string, unknown>,
  ): Promise<CommandOutcome> {
    const chatTarget = resolveChatTargetFromPayload(payload);
    if (!chatTarget) {
      return this.failedOutcome(
        command,
        "Missing chat context for literal generate request.",
        "chat_context_missing",
      );
    }
    if (!this.ctx.callAgentChatBridge) {
      return this.failedOutcome(
        command,
        "Chat bridge unavailable for literal generate request.",
        "chat_bridge_unavailable",
      );
    }

    const requestedAction = asNonEmptyString(payload.requestedAction)?.toLowerCase() ?? "";
    const avatarRequest =
      payload.avatarRequest === true || requestedAction === "avatar";
    const bannerRequest =
      !avatarRequest && (payload.bannerRequest === true || requestedAction === "banner");
    const avatarTargetRaw = asNonEmptyString(payload.avatarTarget)?.toLowerCase();
    const avatarTarget = avatarTargetRaw === "owner" ? "owner" : "agent";
    const bannerTargetRaw = asNonEmptyString(payload.bannerTarget)?.toLowerCase();
    const bannerTarget = bannerTargetRaw === "owner" ? "owner" : "agent";
    const defaultAvatarPrompt =
      avatarTarget === "owner"
        ? "Create a profile avatar for my account on this social app."
        : "Create a profile avatar for your account on this social app.";
    const defaultBannerPrompt =
      bannerTarget === "owner"
        ? "Create a profile banner for my account on this social app."
        : "Create a profile banner for your account on this social app.";
    const basePrompt =
      asNonEmptyString(payload.mediaPrompt) ??
      asNonEmptyString(payload.imagePrompt) ??
      asNonEmptyString(payload.prompt) ??
      asNonEmptyString(payload.topic) ??
      asNonEmptyString(payload.requestText) ??
      (avatarRequest
        ? defaultAvatarPrompt
        : bannerRequest
          ? defaultBannerPrompt
          : null);
    if (!basePrompt) {
      return this.failedOutcome(
        command,
        "No prompt provided for literal generate request.",
        "missing_prompt",
      );
    }
    const recentGeneratedAsset = isRecord(payload.recentGeneratedAsset)
      ? payload.recentGeneratedAsset
      : null;
    const recentGeneratedAssetType =
      asNonEmptyString(recentGeneratedAsset?.type)?.toLowerCase() ?? "";
    const recentGeneratedAssetSummary = asNonEmptyString(
      recentGeneratedAsset?.summary,
    );
    const recentGeneratedAssetHref = asNonEmptyString(recentGeneratedAsset?.href);
    const shouldReusePersonaReference =
      avatarRequest &&
      avatarTarget === "agent" &&
      (recentGeneratedAssetType === "persona" ||
        recentGeneratedAssetType === "avatar");
    const profileCropSpec = avatarRequest
      ? normalizeProfileCropSpec(buildProfileCropSpec("avatar"))
      : bannerRequest
        ? normalizeProfileCropSpec(buildProfileCropSpec("banner"))
        : null;
    const promptBase = shouldReusePersonaReference
      ? [
          basePrompt,
          "Maintain visual persona continuity with the previous avatar.",
          recentGeneratedAssetSummary
            ? `Previous persona summary: ${recentGeneratedAssetSummary}`
            : null,
          recentGeneratedAssetHref
            ? `Previous persona reference URL: ${recentGeneratedAssetHref}`
            : null,
        ]
          .filter((entry): entry is string => Boolean(entry))
          .join("\n")
      : basePrompt;
    const prompt = profileCropSpec
      ? [promptBase, buildProfileCropPromptHint(profileCropSpec)]
          .filter((entry) => entry.trim().length > 0)
          .join("\n\n")
      : promptBase;
    const provenance = asNonEmptyString(payload.provenance);
    const sourceDirectiveId =
      asNonEmptyString(payload.sourceDirectiveId) ??
      command.sourceDirectiveId ??
      command.id;
    const sourceDirectiveActionNonce =
      asNonEmptyString(payload.sourceDirectiveActionNonce) ??
      command.actionNonce ??
      null;

    const generatedAssetType = this.resolveGeneratedAssetType(payload.generatedAssetType);
    const referenceInputs = this.collectMediaReferenceInputs(payload);
    if (
      shouldReusePersonaReference &&
      recentGeneratedAssetHref &&
      !referenceInputs.includes(recentGeneratedAssetHref)
    ) {
      referenceInputs.unshift(recentGeneratedAssetHref);
    }
    const generatedLabel =
      bannerRequest
        ? "banner"
        : generatedAssetType === "gif"
          ? "GIF"
          : "image";
    const generatedCustomAssetSaveIntent =
      !avatarRequest && !bannerRequest
        ? this.resolveGeneratedCustomAssetSaveIntent(payload, basePrompt)
        : null;
    const summary = truncateText(basePrompt, 220);
    const chatRoute = chatTarget.conversationId
      ? { conversationId: chatTarget.conversationId }
      : { channelId: chatTarget.channelId };
    const previewType = avatarRequest
      ? "persona"
      : bannerRequest
        ? "banner"
        : generatedAssetType;
    const processingTitle =
      avatarRequest
        ? "Generating avatar"
        : bannerRequest
          ? "Generating banner"
          : `${generatedLabel.charAt(0).toUpperCase()}${generatedLabel.slice(1)} in progress`;
    const processingBody =
      avatarRequest
        ? "Working on your avatar now..."
        : bannerRequest
          ? "Working on your banner now..."
          : `Generating ${generatedLabel} for "${summary}".`;
    let previewMessageId: string | null = null;
    let previewMessageCreateAttempted = false;
    let previewProgressFingerprint = "";
    let previewProgressUpdatedAtMs = 0;
    let latestMediaProgress: MediaGenerationProgress | null = null;
    let generationCompleted = false;
    let uploadCompleted = false;
    const snapshotStreamFrames = (): MediaGeneratorStreamFrame[] => {
      const progress = latestMediaProgress;
      return progress && Array.isArray(progress.streamFrames)
        ? progress.streamFrames
        : [];
    };
    const buildProcessingActionPreview = (progress?: MediaGenerationProgress) => ({
      type: previewType,
      status: "processing",
      title: processingTitle,
      summary,
      ...(progress?.latestPreviewUrl ? { previewUrl: progress.latestPreviewUrl } : {}),
      ...(progress
        ? {
            streamFrames: progress.streamFrames,
            streamFrameCount: progress.streamFrameCount,
            latestStreamFrameIndex: progress.latestStreamFrameIndex,
            hasFinalStreamFrame: progress.hasFinalStreamFrame,
            streamRevealProgress: progress.streamRevealProgress,
          }
        : {}),
    });
    const previewClientMessageId = `runtime_generate_${command.id}`;
    let previewLookupBackoffUntilMs = 0;
    const maybeResolvePreviewMessageId = async (force: boolean): Promise<string | null> => {
      if (previewMessageId) return previewMessageId;
      const callAgentChatBridge = this.ctx.callAgentChatBridge;
      if (!callAgentChatBridge) return null;
      const nowMs = Date.now();
      if (!force && nowMs < previewLookupBackoffUntilMs) {
        return null;
      }
      previewLookupBackoffUntilMs = nowMs + 800;
      try {
        const listed = await callAgentChatBridge({
          action: "list_messages",
          ...chatRoute,
          limit: 80,
        });
        const data = isRecord(listed) ? listed : null;
        const items = data ? toUnknownArray(data.items) : [];
        for (const rawItem of items) {
          if (!isRecord(rawItem)) continue;
          const message = isRecord(rawItem.message) ? rawItem.message : null;
          if (!message) continue;
          const messageId = asNonEmptyString(message.id);
          const clientMessageId = asNonEmptyString(message.clientMessageId);
          if (!messageId || !clientMessageId) continue;
          if (
            clientMessageId === previewClientMessageId ||
            clientMessageId.startsWith(`${previewClientMessageId}_`)
          ) {
            previewMessageId = messageId;
            return previewMessageId;
          }
        }
      } catch {
        return null;
      }
      return null;
    };
    const tryEditPreviewMessage = async (input: {
      body: string;
      attachments?: Array<{
        url: string;
        mimeType: string;
        sizeBytes: number;
        metadata?: Record<string, unknown>;
      }>;
      metadata: Record<string, unknown>;
      kind: "processing" | "success" | "failed";
    }): Promise<boolean> => {
      const callAgentChatBridge = this.ctx.callAgentChatBridge;
      if (!callAgentChatBridge) return false;
      const runEdit = async (messageId: string | null): Promise<string | null> => {
        const edited = await callAgentChatBridge({
          action: "edit_message",
          ...(messageId ? { messageId } : {}),
          clientMessageId: previewClientMessageId,
          ...chatRoute,
          body: input.body,
          ...(input.attachments ? { attachments: input.attachments } : {}),
          metadata: input.metadata,
        });
        return extractBridgeMessageId(edited);
      };
      let messageId = previewMessageId ?? (await maybeResolvePreviewMessageId(true));
      try {
        const editedMessageId = await runEdit(messageId);
        previewMessageId = messageId ?? editedMessageId ?? previewMessageId;
        if (!previewMessageId) {
          previewMessageId = await maybeResolvePreviewMessageId(true);
        }
        return true;
      } catch (firstError: unknown) {
        previewMessageId = null;
        messageId = await maybeResolvePreviewMessageId(true);
        try {
          const editedMessageId = await runEdit(messageId);
          previewMessageId = messageId ?? editedMessageId ?? previewMessageId;
          if (!previewMessageId) {
            previewMessageId = await maybeResolvePreviewMessageId(true);
          }
          return true;
        } catch (retryError: unknown) {
          await this.ctx.memory
            .recordWrite({
              type: "chat_literal_generate_preview_edit_failed",
              at: nowIso(),
              commandId: command.id,
              kind: input.kind,
              message:
                retryError instanceof Error ? retryError.message : String(retryError),
            })
            .catch(() => undefined);
          return false;
        }
      }
    };
    const sendOrEditPreviewMessage = async (input: {
      body: string;
      attachments?: Array<{
        url: string;
        mimeType: string;
        sizeBytes: number;
        metadata?: Record<string, unknown>;
      }>;
      metadata: Record<string, unknown>;
      kind: "processing" | "success" | "failed";
    }): Promise<boolean> => {
      const callAgentChatBridge = this.ctx.callAgentChatBridge;
      if (!callAgentChatBridge) return false;
      const sendFreshPreviewMessage = async (attachments?: Array<{
        url: string;
        mimeType: string;
        sizeBytes: number;
        metadata?: Record<string, unknown>;
      }>): Promise<boolean> => {
        if (previewMessageCreateAttempted) return false;
        previewMessageCreateAttempted = true;
        try {
          const created = await callAgentChatBridge({
            action: "send_message",
            clientMessageId: previewClientMessageId,
            ...chatRoute,
            body: input.body,
            format: "markdown",
            ...(attachments ? { attachments } : {}),
            metadata: input.metadata,
          });
          previewMessageId ??= extractBridgeMessageId(created);
          if (!previewMessageId) {
            for (let attempt = 0; attempt < 5 && !previewMessageId; attempt += 1) {
              if (attempt > 0) {
                await sleep(90 + attempt * 70);
              }
              previewMessageId ??= await maybeResolvePreviewMessageId(true);
            }
          }
          return true;
        } catch (error: unknown) {
          previewMessageCreateAttempted = false;
          throw error;
        }
      };
      if (
        previewMessageId ||
        previewMessageCreateAttempted ||
        input.kind !== "processing"
      ) {
        const edited = await tryEditPreviewMessage(input);
        if (edited) {
          return true;
        }
        if (input.kind !== "processing") {
          if (!previewMessageCreateAttempted) {
            return sendFreshPreviewMessage(input.attachments);
          }
          return false;
        }
      }
      const sent = await sendFreshPreviewMessage(input.attachments);
      if (!sent) {
        await maybeResolvePreviewMessageId(true);
      }
      return sent;
    };
    const emitStreamProgress = async (progress: MediaGenerationProgress): Promise<void> => {
      latestMediaProgress = progress;
      if (!previewMessageId) {
        await maybeResolvePreviewMessageId(true);
      }
      if (!previewMessageId) return;
      const nowMs = Date.now();
      if (nowMs - previewProgressUpdatedAtMs < 120) return;
      const fingerprint = [
        progress.contextId ?? "",
        progress.contextStatus ?? "",
        progress.latestPreviewUrl ?? "",
        progress.streamFrameCount,
        progress.latestStreamFrameIndex ?? "",
        progress.hasFinalStreamFrame ? "1" : "0",
        progress.streamRevealProgress,
        progress.timedOut ? "1" : "0",
      ].join("|");
      if (fingerprint === previewProgressFingerprint) return;
      previewProgressFingerprint = fingerprint;
      previewProgressUpdatedAtMs = nowMs;
      const edited = await tryEditPreviewMessage({
        kind: "processing",
        body: processingBody,
        metadata: {
          automated: true,
          sourceContext: "CHAT",
          actionPreview: buildProcessingActionPreview(progress),
        },
      });
      if (!edited) return;
    };
    try {
      await sendOrEditPreviewMessage({
        kind: "processing",
        body: processingBody,
        metadata: {
          automated: true,
          sourceContext: "CHAT",
          actionPreview: buildProcessingActionPreview(),
        },
      });
      const media = await this.generateAndUploadMediaFromPrompt(prompt, {
        generatedAssetType: avatarRequest || bannerRequest ? "image" : generatedAssetType,
        mode: avatarRequest
          ? "chat_avatar_update"
          : bannerRequest
            ? "chat_banner_update"
            : "chat_literal_generate",
        referenceInputs,
        onProgress: emitStreamProgress,
      });
      generationCompleted = true;
      const mimeType = this.resolveGeneratedAttachmentMimeType({
        generatedAssetType,
        mediaUrl: media.mediaUrl,
        ...(media.mediaType ? { mediaType: media.mediaType } : {}),
      });
      const sizeBytes =
        typeof media.mediaSizeBytes === "number" &&
        Number.isFinite(media.mediaSizeBytes) &&
        media.mediaSizeBytes > 0
          ? Math.max(1, Math.floor(media.mediaSizeBytes))
          : 1;
      await this.recordCommandLifecycleCheckpoint({
        command,
        stage: "generated",
        status: "ok",
        metadata: {
          generatedAssetType,
          mode: avatarRequest
            ? "chat_avatar_update"
            : bannerRequest
              ? "chat_banner_update"
              : "chat_literal_generate",
        },
      });
      await this.recordCommandLifecycleCheckpoint({
        command,
        stage: "uploaded",
        status: "ok",
        metadata: {
          generatedAssetType,
          mediaUrl: media.mediaUrl,
          mimeType,
          mode: avatarRequest
            ? "chat_avatar_update"
            : bannerRequest
              ? "chat_banner_update"
              : "chat_literal_generate",
        },
      });
      uploadCompleted = true;
      if (avatarRequest) {
        const avatarCropSpec =
          profileCropSpec?.target === "avatar"
            ? profileCropSpec
            : normalizeProfileCropSpec(buildProfileCropSpec("avatar"));
        const avatarResult = await this.updateAvatar({
          target: avatarTarget,
          imageUrl: media.mediaUrl,
          ...(media.mediaOriginalUrl ? { originalUrl: media.mediaOriginalUrl } : {}),
          ...(media.mediaOptimizedUrl ? { optimizedUrl: media.mediaOptimizedUrl } : {}),
          ...(media.mediaContentHash ? { contentHash: media.mediaContentHash } : {}),
          ...(media.mediaIpfsCid ? { ipfsCid: media.mediaIpfsCid } : {}),
          ...(typeof media.mediaSizeBytes === "number"
            ? { sizeBytes: media.mediaSizeBytes }
            : {}),
          ...(provenance ? { provenance } : {}),
          ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
          ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
        });
        const avatarData = isRecord(avatarResult) ? avatarResult : null;
        const avatarUser = isRecord(avatarData?.user) ? avatarData.user : null;
        const avatarHandle = asNonEmptyString(avatarUser?.handle);
        const avatarUserId = asNonEmptyString(avatarUser?.id);
        const avatarProfileHref = avatarTarget === "owner" && avatarHandle
          ? `/u/${avatarHandle.replace(/^@+/u, "")}?edit=avatar&crop=1`
          : null;
        const streamedFrames = snapshotStreamFrames();
        const needsExplicitFinalFrame =
          streamedFrames.length === 0 ||
          streamedFrames[streamedFrames.length - 1]?.previewUrl !== media.mediaUrl;
        const streamFramesForSuccess = needsExplicitFinalFrame
          ? [
              ...streamedFrames,
              {
                sourceFileName: null,
                isStreamPart: false,
                streamPartIndex: null,
                isFinalStreamFrame: true,
                previewUrl: media.mediaUrl,
                outputPath: null,
                metadataId: null,
                source: "runtime.final",
              },
            ]
          : streamedFrames;
        const completionText =
          avatarTarget === "owner"
            ? "Done. Here is your new avatar. If framing looks off, tap Crop avatar and keep your face in the center safe zone."
            : "Done. Here is my new avatar. If framing looks off, tap Crop avatar and keep the face in the center safe zone.";
        const chatDeliveryHandled = await sendOrEditPreviewMessage({
          kind: "success",
          body: completionText,
          attachments: [
            {
              url: media.mediaUrl,
              mimeType,
              sizeBytes,
              metadata: {
                source: "runtime.avatar",
                generatedAssetType: "persona",
                personaType: "persona",
                cropZones: avatarCropSpec,
              },
            },
          ],
          metadata: {
            automated: true,
            sourceContext: "CHAT",
            actionPreview: {
              type: "persona",
              status: "success",
              title: "Persona avatar updated",
              summary,
              previewUrl: media.mediaUrl,
              href: media.mediaUrl,
              hrefLabel: "Open avatar image",
              ...(streamFramesForSuccess.length > 0
                ? {
                    streamFrames: streamFramesForSuccess,
                    streamFrameCount: streamFramesForSuccess.length,
                    latestStreamFrameIndex: streamFramesForSuccess.length - 1,
                    hasFinalStreamFrame: true,
                    streamRevealProgress: 1,
                  }
                : {}),
              cropHint: avatarCropSpec.guidance,
              cropZones: avatarCropSpec,
              ...(avatarProfileHref
                ? {
                    secondaryHref: avatarProfileHref,
                    secondaryHrefLabel: "Crop avatar",
                  }
                : {}),
              avatarTarget,
              ...(avatarHandle ? { handle: avatarHandle } : {}),
              ...(avatarUserId ? { userId: avatarUserId } : {}),
            },
          },
        });
        if (!chatDeliveryHandled) {
          throw new Error("chat_preview_finalize_failed:chat_avatar_update");
        }
        await this.ctx.memory.recordWrite({
            type: "chat_avatar_updated",
            at: nowIso(),
            commandId: command.id,
            avatarTarget,
            mediaUrl: media.mediaUrl,
            prompt: summary,
            personaType: "persona",
            cropZones: avatarCropSpec,
            userId: avatarUserId,
            handle: avatarHandle,
            targetConversationId: chatTarget.conversationId ?? null,
            targetChannelId: chatTarget.channelId ?? null,
        });
        return this.successOutcome(command, {
          mode: "chat_avatar_update",
          avatarTarget,
          mediaUrl: media.mediaUrl,
          prompt: summary,
          updateResult: avatarResult,
          chatDeliveryHandled,
        });
      }
      if (bannerRequest) {
        const bannerCropSpec =
          profileCropSpec?.target === "banner"
            ? profileCropSpec
            : normalizeProfileCropSpec(buildProfileCropSpec("banner"));
        const bannerResult = await this.updateBanner({
          target: bannerTarget,
          bannerUrl: media.mediaUrl,
          ...(media.mediaOriginalUrl ? { originalUrl: media.mediaOriginalUrl } : {}),
          ...(media.mediaOptimizedUrl ? { optimizedUrl: media.mediaOptimizedUrl } : {}),
          ...(media.mediaContentHash ? { contentHash: media.mediaContentHash } : {}),
          ...(media.mediaIpfsCid ? { ipfsCid: media.mediaIpfsCid } : {}),
          ...(typeof media.mediaSizeBytes === "number"
            ? { sizeBytes: media.mediaSizeBytes }
            : {}),
          ...(provenance ? { provenance } : {}),
          ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
          ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
        });
        const bannerData = isRecord(bannerResult) ? bannerResult : null;
        const bannerUser = isRecord(bannerData?.user) ? bannerData.user : null;
        const bannerHandle = asNonEmptyString(bannerUser?.handle);
        const bannerUserId = asNonEmptyString(bannerUser?.id);
        const bannerProfileHref = bannerTarget === "owner" && bannerHandle
          ? `/u/${bannerHandle.replace(/^@+/u, "")}?edit=banner&crop=1`
          : null;
        const streamedFrames = snapshotStreamFrames();
        const needsExplicitFinalFrame =
          streamedFrames.length === 0 ||
          streamedFrames[streamedFrames.length - 1]?.previewUrl !== media.mediaUrl;
        const streamFramesForSuccess = needsExplicitFinalFrame
          ? [
              ...streamedFrames,
              {
                sourceFileName: null,
                isStreamPart: false,
                streamPartIndex: null,
                isFinalStreamFrame: true,
                previewUrl: media.mediaUrl,
                outputPath: null,
                metadataId: null,
                source: "runtime.final",
              },
            ]
          : streamedFrames;
        const completionText =
          bannerTarget === "owner"
            ? "Done. Here is your new banner. If framing looks off, tap Crop banner and keep key details in the center safe zone."
            : "Done. Here is my new banner. If framing looks off, keep key details in the center safe zone.";
        const chatDeliveryHandled = await sendOrEditPreviewMessage({
          kind: "success",
          body: completionText,
          attachments: [
            {
              url: media.mediaUrl,
              mimeType,
              sizeBytes,
              metadata: {
                source: "runtime.banner",
                generatedAssetType: "banner",
                cropZones: bannerCropSpec,
              },
            },
          ],
          metadata: {
            automated: true,
            sourceContext: "CHAT",
            actionPreview: {
              type: "banner",
              status: "success",
              title: "Profile banner updated",
              summary,
              previewUrl: media.mediaUrl,
              href: media.mediaUrl,
              hrefLabel: "Open banner image",
              ...(streamFramesForSuccess.length > 0
                ? {
                    streamFrames: streamFramesForSuccess,
                    streamFrameCount: streamFramesForSuccess.length,
                    latestStreamFrameIndex: streamFramesForSuccess.length - 1,
                    hasFinalStreamFrame: true,
                    streamRevealProgress: 1,
                  }
                : {}),
              cropHint: bannerCropSpec.guidance,
              cropZones: bannerCropSpec,
              ...(bannerProfileHref
                ? {
                    secondaryHref: bannerProfileHref,
                    secondaryHrefLabel: "Crop banner",
                  }
                : {}),
              bannerTarget,
              ...(bannerHandle ? { handle: bannerHandle } : {}),
              ...(bannerUserId ? { userId: bannerUserId } : {}),
            },
          },
        });
        if (!chatDeliveryHandled) {
          throw new Error("chat_preview_finalize_failed:chat_banner_update");
        }
        await this.ctx.memory.recordWrite({
          type: "chat_banner_updated",
          at: nowIso(),
          commandId: command.id,
          bannerTarget,
          mediaUrl: media.mediaUrl,
          prompt: summary,
          cropZones: bannerCropSpec,
          userId: bannerUserId,
          handle: bannerHandle,
          targetConversationId: chatTarget.conversationId ?? null,
          targetChannelId: chatTarget.channelId ?? null,
        });
        return this.successOutcome(command, {
          mode: "chat_banner_update",
          bannerTarget,
          mediaUrl: media.mediaUrl,
          prompt: summary,
          updateResult: bannerResult,
          chatDeliveryHandled,
        });
      }

      const streamedFrames = snapshotStreamFrames();
      const needsExplicitFinalFrame =
        streamedFrames.length === 0 ||
        streamedFrames[streamedFrames.length - 1]?.previewUrl !== media.mediaUrl;
      const streamFramesForSuccess = needsExplicitFinalFrame
        ? [
            ...streamedFrames,
            {
              sourceFileName: null,
              isStreamPart: false,
              streamPartIndex: null,
              isFinalStreamFrame: true,
              previewUrl: media.mediaUrl,
              outputPath: null,
              metadataId: null,
              source: "runtime.final",
            },
          ]
        : streamedFrames;
      let generatedCustomAssetSaveResult: GeneratedCustomAssetSaveResult | null = null;
      let generatedCustomAssetSaveError: string | null = null;
      if (generatedCustomAssetSaveIntent) {
        try {
          generatedCustomAssetSaveResult = await this.saveGeneratedCustomAsset({
            command,
            payload,
            intent: generatedCustomAssetSaveIntent,
            sourcePrompt: basePrompt,
            mediaUrl: media.mediaUrl,
            mimeType,
            chatTarget,
          });
        } catch (error: unknown) {
          generatedCustomAssetSaveError =
            error instanceof Error ? error.message : String(error);
        }
      }
      const customAssetScopeLabel =
        generatedCustomAssetSaveResult?.scope === "group"
          ? "this group"
          : generatedCustomAssetSaveResult?.scope === "server"
            ? "this server"
            : "your library";
      const successBody =
        generatedCustomAssetSaveResult
          ? `Generated ${generatedLabel} for "${summary}". Saved as ${generatedCustomAssetSaveResult.kind} \`${generatedCustomAssetSaveResult.name}\` in ${customAssetScopeLabel}.`
          : generatedCustomAssetSaveError && generatedCustomAssetSaveIntent
            ? `Generated ${generatedLabel} for "${summary}". Could not save to ${generatedCustomAssetSaveIntent.scope} ${generatedCustomAssetSaveIntent.kind}s (${truncateText(generatedCustomAssetSaveError, 120)}).`
            : `Generated ${generatedLabel} for "${summary}".`;
      const chatDeliveryHandled = await sendOrEditPreviewMessage({
        kind: "success",
        body: successBody,
        attachments: [
          {
            url: media.mediaUrl,
            mimeType,
            sizeBytes,
            metadata: {
              source: "runtime.generate",
              generatedAssetType,
            },
          },
        ],
        metadata: {
          automated: true,
          sourceContext: "CHAT",
          actionPreview: {
            type: generatedAssetType,
            status: "success",
            title: `${generatedLabel.charAt(0).toUpperCase()}${generatedLabel.slice(1)} generated`,
            summary,
            previewUrl: media.mediaUrl,
            href: media.mediaUrl,
            hrefLabel: `Open ${generatedLabel}`,
            ...(generatedCustomAssetSaveResult
              ? {
                  customAsset: {
                    kind: generatedCustomAssetSaveResult.kind,
                    scope: generatedCustomAssetSaveResult.scope,
                    name: generatedCustomAssetSaveResult.name,
                    id: generatedCustomAssetSaveResult.id,
                  },
                }
              : generatedCustomAssetSaveError && generatedCustomAssetSaveIntent
                ? {
                    customAssetSaveError: truncateText(
                      generatedCustomAssetSaveError,
                      180,
                    ),
                  }
                : {}),
            ...(streamFramesForSuccess.length > 0
              ? {
                  streamFrames: streamFramesForSuccess,
                  streamFrameCount: streamFramesForSuccess.length,
                  latestStreamFrameIndex: streamFramesForSuccess.length - 1,
                  hasFinalStreamFrame: true,
                  streamRevealProgress: 1,
                }
              : {}),
          },
        },
      });
      if (!chatDeliveryHandled) {
        throw new Error("chat_preview_finalize_failed:chat_literal_generate");
      }
      await this.ctx.memory.recordWrite({
        type: "chat_literal_generate_sent",
        at: nowIso(),
        commandId: command.id,
        generatedAssetType,
        mediaUrl: media.mediaUrl,
        prompt: summary,
        customAssetKind: generatedCustomAssetSaveResult?.kind ?? null,
        customAssetScope: generatedCustomAssetSaveResult?.scope ?? null,
        customAssetName: generatedCustomAssetSaveResult?.name ?? null,
        customAssetId: generatedCustomAssetSaveResult?.id ?? null,
        customAssetSaveError: generatedCustomAssetSaveError,
        targetConversationId: chatTarget.conversationId ?? null,
        targetChannelId: chatTarget.channelId ?? null,
      });
      return this.successOutcome(command, {
        generatedAssetType,
        mediaUrl: media.mediaUrl,
        prompt: summary,
        ...(generatedCustomAssetSaveResult
          ? { customAsset: generatedCustomAssetSaveResult }
          : {}),
        ...(generatedCustomAssetSaveError && generatedCustomAssetSaveIntent
          ? { customAssetSaveError: generatedCustomAssetSaveError }
          : {}),
        mode: "chat_literal_generate",
        chatDeliveryHandled,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const isPromptCurationFailure = /prompt_curation_/iu.test(message);
      const isChatDeliveryFailure = /chat_preview_finalize_failed:/iu.test(message);
      const failureStage: CommandLifecycleCheckpointStage = isChatDeliveryFailure
        ? "chat_delivery"
        : uploadCompleted
          ? "uploaded"
          : generationCompleted
            ? "generated"
            : "generated";
      const previewFailureDelivered = await sendOrEditPreviewMessage({
        kind: "failed",
        body: avatarRequest
          ? "I could not update that avatar right now. Please retry in a moment."
          : bannerRequest
            ? "I could not update that banner right now. Please retry in a moment."
            : isChatDeliveryFailure
              ? `I generated that ${generatedLabel}, but failed to finalize delivery in chat. Please retry.`
            : isPromptCurationFailure
              ? `I could not prepare a generation prompt for that ${generatedLabel} right now. Please retry in a moment.`
              : `I could not generate that ${generatedLabel} right now. Please retry in a moment.`,
        metadata: {
          automated: true,
          sourceContext: "CHAT",
          actionPreview: {
            type: avatarRequest ? "persona" : bannerRequest ? "banner" : generatedAssetType,
            status: "failed",
            title:
              avatarRequest
                ? "Avatar update failed"
                : bannerRequest
                  ? "Banner update failed"
                  : isChatDeliveryFailure
                    ? "Delivery failed"
                  : isPromptCurationFailure
                    ? "Prompt curation failed"
                    : `${generatedLabel.charAt(0).toUpperCase()}${generatedLabel.slice(1)} generation failed`,
            error: truncateText(message, 240),
          },
        },
      }).catch(() => false);
      await this.recordCommandLifecycleCheckpoint({
        command,
        stage: failureStage,
        status:
          failureStage === "chat_delivery" && previewFailureDelivered
            ? "ok"
            : "failed",
        message:
          failureStage === "chat_delivery" && previewFailureDelivered
            ? null
            : message,
        metadata: {
          generatedAssetType,
          avatarRequest,
          bannerRequest,
          ...(failureStage === "chat_delivery"
            ? { recoveredWithFailureMessage: previewFailureDelivered }
            : {}),
        },
      });
      await this.ctx.memory.recordWrite({
        type: "chat_literal_generate_failed",
        at: nowIso(),
        commandId: command.id,
        generatedAssetType,
        avatarRequest,
        bannerRequest,
        error: message,
      });
      const failed = this.failedOutcome(
        command,
        avatarRequest
          ? `Avatar update failed: ${message}`
          : bannerRequest
            ? `Banner update failed: ${message}`
          : isChatDeliveryFailure
            ? `Literal generate delivery failed: ${message}`
          : `Literal generate failed: ${message}`,
        avatarRequest
          ? "avatar_update_failed"
          : bannerRequest
            ? "banner_update_failed"
            : isChatDeliveryFailure
              ? "chat_delivery_failed"
            : "literal_generate_failed",
      );
      return {
        ...failed,
        data: {
          mode: "chat_literal_generate",
          generatedAssetType,
          chatDeliveryHandled: previewFailureDelivered,
          chatDeliveryCheckpointRecorded: failureStage === "chat_delivery",
        },
      };
    }
  }

  private async executeCommandFromMappedDraft(command: Command): Promise<CommandOutcome> {
    const kind = command.kind.trim().toLowerCase();
    if (kind === "write.createpost") return this.executeWriteCreatePost(command);
    if (kind === "write.createstory") return this.executeWriteCreateStory(command);
    if (kind === "write.updateavatar") return this.executeWriteUpdateAvatar(command);
    if (kind === "write.updatebanner") return this.executeWriteUpdateBanner(command);
    if (kind === "write.commentpost" || kind === "write.comment") {
      return this.executeWriteComment(command);
    }
    if (kind === "write.votepost" || kind === "write.like") {
      return this.executeWriteVote(command);
    }
    if (kind === "write.repostpost" || kind === "write.repost") {
      return this.executeWriteRepost(command);
    }
    return this.failedOutcome(command, `Unsupported generated draft command kind: ${command.kind}`);
  }

  private buildGenerateInput(
    payload: Record<string, unknown>,
    command: Command,
  ): Record<string, unknown> {
    const goal =
      asNonEmptyString(payload.goal)?.toLowerCase() ??
      asNonEmptyString(payload.kind)?.toLowerCase() ??
      "story";
    const mappedKind = this.mapGoalToGenerateKind(goal);
    const requestedKinds = this.resolveRequestedGenerateKinds(payload, mappedKind);
    const scopedKinds = this.resolveDirectiveScopeGenerateKinds(payload);
    const mergedKinds = [...requestedKinds];
    for (const scopedKind of scopedKinds) {
      if (!mergedKinds.includes(scopedKind)) {
        mergedKinds.push(scopedKind);
      }
    }
    const primaryKind = mergedKinds[0] ?? mappedKind;
    const scope = isRecord(payload.directiveScope) ? payload.directiveScope : null;
    const scopedTarget = scope && isRecord(scope.target) ? scope.target : null;
    const postId =
      asPositiveInt(payload.postId) ??
      asPositiveInt(payload.targetPostId) ??
      (scope
        ? asPositiveInt(scope.targetPostId) ??
          (scopedTarget ? asPositiveInt(scopedTarget.postId) : null)
        : null);
    const commentId =
      asPositiveInt(payload.commentId) ??
      asPositiveInt(payload.targetCommentId) ??
      (scope
        ? asPositiveInt(scope.targetCommentId) ??
          (scopedTarget ? asPositiveInt(scopedTarget.commentId) : null)
        : null);
    const count = asPositiveInt(payload.count);
    const topic =
      asNonEmptyString(payload.topic) ??
      asNonEmptyString(payload.requestText) ??
      asNonEmptyString(payload.prompt) ??
      null;
    const mood = asNonEmptyString(payload.mood);
    const tags = Array.isArray(payload.tags)
      ? payload.tags
          .map((entry) => asNonEmptyString(entry))
          .filter((entry): entry is string => Boolean(entry))
          .slice(0, 8)
      : [];
    const provenance = asNonEmptyString(payload.provenance);
    const sourceDirectiveId =
      asNonEmptyString(payload.sourceDirectiveId) ??
      command.sourceDirectiveId ??
      command.id;
    const sourceDirectiveActionNonce =
      asNonEmptyString(payload.sourceDirectiveActionNonce) ??
      command.actionNonce;
    return {
      kind: primaryKind,
      ...(mergedKinds.length > 0 ? { kinds: mergedKinds } : {}),
      ...(count ? { count } : {}),
      ...(topic ? { topic } : {}),
      ...(mood ? { mood } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(postId ? { postId } : {}),
      ...(commentId ? { commentId } : {}),
      ...(provenance ? { provenance } : {}),
      ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
      ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
      ...(command.grantId ? { grantId: command.grantId } : {}),
    };
  }

  private collectBridgeRecordItems(value: unknown): Record<string, unknown>[] {
    const collected: Record<string, unknown>[] = [];
    const seen = new Set<Record<string, unknown>>();
    const push = (entry: unknown): void => {
      if (!isRecord(entry) || seen.has(entry)) return;
      seen.add(entry);
      collected.push(entry);
    };
    if (Array.isArray(value)) {
      for (const entry of value) push(entry);
      return collected;
    }
    if (!isRecord(value)) return collected;
    for (const key of ["items", "results", "posts", "comments", "data"] as const) {
      const nested = value[key];
      if (Array.isArray(nested)) {
        for (const entry of nested) push(entry);
      } else {
        push(nested);
      }
    }
    push(value.post);
    push(value.comment);
    if (collected.length === 0) push(value);
    return collected;
  }

  private extractEngagementTargetCandidateFromRecord(
    record: Record<string, unknown>,
    source: string,
  ): EngagementTargetCandidate | null {
    const parseFrom = (entry: Record<string, unknown>): EngagementTargetCandidate | null => {
      const looksLikeCommentRecord =
        asPositiveInt(entry.commentId) !== null ||
        asPositiveInt(entry.parentId) !== null ||
        (asPositiveInt(entry.postId) !== null &&
          (asNonEmptyString(entry.body) !== null ||
            asNonEmptyString(entry.textBody) !== null));
      const postId =
        asPositiveInt(entry.postId) ??
        asPositiveInt(entry.targetPostId) ??
        (looksLikeCommentRecord ? null : asPositiveInt(entry.id));
      if (!postId) return null;
      const commentId =
        asPositiveInt(entry.commentId) ??
        asPositiveInt(entry.parentId) ??
        asPositiveInt(entry.targetCommentId) ??
        null;
      const author = isRecord(entry.author) ? entry.author : null;
      const authorId =
        asNonEmptyString(entry.authorId) ??
        asNonEmptyString(author?.id) ??
        null;
      return {
        postId,
        commentId,
        authorId,
        source,
      };
    };
    const direct = parseFrom(record);
    if (direct) return direct;
    for (const key of ["target", "post", "comment", "data"] as const) {
      const nested = isRecord(record[key]) ? record[key] : null;
      if (!nested) continue;
      const parsed = parseFrom(nested);
      if (parsed) return parsed;
    }
    return null;
  }

  private async resolveEngagementTargetForDirective(input: {
    payload: Record<string, unknown>;
    action: "comment" | "like" | "repost";
    commandId: string;
  }): Promise<EngagementTargetCandidate | null> {
    const scopedDirective = isRecord(input.payload.directiveScope)
      ? input.payload.directiveScope
      : null;
    const scopedTarget = scopedDirective && isRecord(scopedDirective.target)
      ? scopedDirective.target
      : null;
    const explicitPostId =
      asPositiveInt(input.payload.postId) ??
      asPositiveInt(input.payload.targetPostId) ??
      (scopedDirective
        ? asPositiveInt(scopedDirective.targetPostId) ??
          (scopedTarget ? asPositiveInt(scopedTarget.postId) : null)
        : null);
    const explicitCommentId =
      asPositiveInt(input.payload.parentId) ??
      asPositiveInt(input.payload.commentId) ??
      asPositiveInt(input.payload.targetCommentId) ??
      (scopedDirective
        ? asPositiveInt(scopedDirective.targetCommentId) ??
          (scopedTarget ? asPositiveInt(scopedTarget.commentId) : null)
        : null);
    if (explicitPostId) {
      return {
        postId: explicitPostId,
        commentId: input.action === "comment" ? (explicitCommentId ?? null) : null,
        authorId: null,
        source: "directive_payload",
      };
    }

    const hints = this.extractEngagementLookupHints(input.payload);
    const hintedPostId = hints.postId;
    const hintedCommentId = hints.commentId;
    if (hintedPostId) {
      return {
        postId: hintedPostId,
        commentId: input.action === "comment" ? hintedCommentId : null,
        authorId: null,
        source: "payload_hint",
      };
    }

    const hasBridge = Boolean(this.ctx.callAgentChatBridge);
    let bridgeQuerySuccessCount = 0;
    let bridgeQueryFailureCount = 0;

    const cacheKey = this.buildEngagementTargetCacheKey({
      action: input.action,
      payload: input.payload,
      hints,
    });
    const nowMs = Date.now();
    this.pruneEngagementTargetCache(nowMs);
    const cachedResolution = this.engagementTargetCache.get(cacheKey);
    if (cachedResolution && cachedResolution.expiresAtMs > nowMs) {
      return {
        ...cachedResolution.candidate,
        commentId:
          input.action === "comment"
            ? (cachedResolution.candidate.commentId ?? null)
            : null,
      };
    }

    type LookupPlan = {
      source: string;
      request: Record<string, unknown>;
      parser?: (value: unknown) => EngagementTargetCandidate[];
    };
    const trace: EngagementResolutionTrace[] = [];
    const candidates: EngagementTargetCandidate[] = [];
    const seenTargetKeys = new Set<string>();
    const pushCandidate = (candidate: EngagementTargetCandidate | null): void => {
      if (!candidate) return;
      const key = `${candidate.postId}:${candidate.commentId ?? 0}`;
      if (seenTargetKeys.has(key)) return;
      seenTargetKeys.add(key);
      candidates.push(candidate);
    };
    const addCandidatesFrom = (value: unknown, source: string): number => {
      let added = 0;
      for (const item of this.collectBridgeRecordItems(value)) {
        const parsed = this.extractEngagementTargetCandidateFromRecord(item, source);
        if (!parsed) continue;
        const before = candidates.length;
        pushCandidate(parsed);
        if (candidates.length > before) added += 1;
      }
      return added;
    };
    const runLookupStep = async (
      step: string,
      plans: LookupPlan[],
    ): Promise<void> => {
      if (!hasBridge || plans.length === 0) return;
      let queryCount = 0;
      let cacheHits = 0;
      let addedCandidates = 0;
      for (const plan of plans) {
        try {
          const result = await this.callAgentBridgeLookupCached(plan.request);
          bridgeQuerySuccessCount += 1;
          queryCount += 1;
          if (result.cacheHit) cacheHits += 1;
          if (typeof plan.parser === "function") {
            for (const candidate of plan.parser(result.value)) {
              const before = candidates.length;
              pushCandidate(candidate);
              if (candidates.length > before) addedCandidates += 1;
            }
          } else {
            addedCandidates += addCandidatesFrom(result.value, plan.source);
          }
        } catch (error: unknown) {
          bridgeQueryFailureCount += 1;
          await this.ctx.memory
            .recordWrite({
              type: "engagement_target_lookup_failed",
              at: nowIso(),
              commandId: input.commandId,
              action: input.action,
              step,
              source: plan.source,
              lookupAction: asNonEmptyString(plan.request.action) ?? "unknown",
              error: error instanceof Error ? error.message : String(error),
            })
            .catch(() => undefined);
        }
      }
      trace.push({
        step,
        queryCount,
        cacheHits,
        addedCandidates,
        totalCandidates: candidates.length,
      });
    };

    let agentMainUserId: string | null = null;
    let agentHandle: string | null = null;
    if (hasBridge) {
      const profileResult = await this.callAgentBridgeLookupCached({
        action: "agent_profile",
      }).catch((error: unknown) => {
        bridgeQueryFailureCount += 1;
        void this.ctx.memory
          .recordWrite({
            type: "engagement_target_lookup_failed",
            at: nowIso(),
            commandId: input.commandId,
            action: input.action,
            step: "agent_profile",
            source: "agent_profile",
            lookupAction: "agent_profile",
            error: error instanceof Error ? error.message : String(error),
          })
          .catch(() => undefined);
        return null;
      });
      if (profileResult) {
        bridgeQuerySuccessCount += 1;
        if (isRecord(profileResult.value) && isRecord(profileResult.value.agent)) {
          const agentRecord = profileResult.value.agent;
          agentMainUserId = asNonEmptyString(agentRecord.mainUserId) ?? null;
          agentHandle =
            asNonEmptyString(agentRecord.handle)?.replace(/^@+/u, "").toLowerCase() ??
            null;
        }
        trace.push({
          step: "agent_profile",
          queryCount: 1,
          cacheHits: profileResult.cacheHit ? 1 : 0,
          addedCandidates: 0,
          totalCandidates: 0,
        });
      }
    }

    const parseNotificationTargets = (
      value: unknown,
      source: string,
    ): EngagementTargetCandidate[] => {
      const resolved: EngagementTargetCandidate[] = [];
      const seen = new Set<string>();
      const push = (candidate: EngagementTargetCandidate | null): void => {
        if (!candidate) return;
        if (!candidate.postId || candidate.postId <= 0) return;
        const key = `${candidate.postId}:${candidate.commentId ?? 0}`;
        if (seen.has(key)) return;
        seen.add(key);
        resolved.push(candidate);
      };
      for (const row of this.collectBridgeRecordItems(value)) {
        push(this.extractEngagementTargetCandidateFromRecord(row, source));

        const entityType =
          asNonEmptyString(row.entityType)?.toLowerCase() ??
          asNonEmptyString(row.targetType)?.toLowerCase() ??
          null;
        const entityId =
          asPositiveInt(row.entityId) ??
          asPositiveInt(row.targetId) ??
          null;
        const postIdFromFields =
          asPositiveInt(row.postId) ??
          asPositiveInt(row.targetPostId) ??
          (isRecord(row.post) ? asPositiveInt(row.post.id) : null) ??
          (isRecord(row.target)
            ? asPositiveInt(row.target.postId) ??
              (isRecord(row.target.post) ? asPositiveInt(row.target.post.id) : null)
            : null);
        const commentIdFromFields =
          asPositiveInt(row.commentId) ??
          asPositiveInt(row.targetCommentId) ??
          asPositiveInt(row.parentId) ??
          (isRecord(row.comment) ? asPositiveInt(row.comment.id) : null) ??
          (isRecord(row.target)
            ? asPositiveInt(row.target.commentId) ??
              (isRecord(row.target.comment) ? asPositiveInt(row.target.comment.id) : null)
            : null);
        const postId =
          postIdFromFields ??
          (entityType === "post" ? entityId : null) ??
          null;
        const commentId =
          commentIdFromFields ??
          (entityType === "comment" ? entityId : null) ??
          null;
        if (!postId) continue;
        push({
          postId,
          commentId: input.action === "comment" ? commentId : null,
          authorId: null,
          source,
        });
      }
      return resolved;
    };
    if (hasBridge) {
      await runLookupStep("notifications_priority", [
        {
          source: "notifications_unread",
          request: {
            action: "browse_notifications",
            unreadOnly: true,
            limit: 24,
          },
          parser: (value: unknown): EngagementTargetCandidate[] =>
            parseNotificationTargets(value, "notifications_unread"),
        },
        {
          source: "notifications_recent",
          request: {
            action: "browse_notifications",
            unreadOnly: false,
            limit: 24,
          },
          parser: (value: unknown): EngagementTargetCandidate[] =>
            parseNotificationTargets(value, "notifications_recent"),
        },
      ]);
    }

    if (typeof this.ctx.memory.buildContext === "function") {
      try {
        const request: ContextRequest = {
          mode: "engagement",
          audience: "runtime_write",
          maxRecentEvents: 80,
          maxArchiveEvents: 40,
          includeKeywordRetrieval: true,
          retrievalIntent: "engagement",
          retrievalMaxItems: 12,
          retrievalQuery: [
            input.action,
            hints.rawQuery,
            "target resolution",
          ]
            .filter((entry) => entry.trim().length > 0)
            .join(" · "),
        };
        const bundle = await this.ctx.memory.buildContext(request);
        const before = candidates.length;
        const envelopes = [
          ...(Array.isArray(bundle.target?.events) ? bundle.target.events : []),
          ...(Array.isArray(bundle.recent) ? bundle.recent : []),
          ...(Array.isArray(bundle.archive) ? bundle.archive : []),
        ];
        for (const envelope of envelopes) {
          if (!isRecord(envelope) || !isRecord(envelope.payload)) continue;
          pushCandidate(
            this.extractEngagementTargetCandidateFromRecord(
              envelope.payload,
              "memory_event",
            ),
          );
        }
        if (isRecord(bundle.retrieval) && Array.isArray(bundle.retrieval.lines)) {
          for (const line of bundle.retrieval.lines) {
            if (typeof line !== "string") continue;
            const parsedIds = this.parseTargetIdsFromTextLine(line);
            if (!parsedIds.postId) continue;
            pushCandidate({
              postId: parsedIds.postId,
              commentId: input.action === "comment" ? (parsedIds.commentId ?? null) : null,
              authorId: null,
              source: "memory_retrieval",
            });
          }
        }
        if (
          isRecord(bundle.retrieval) &&
          Array.isArray(bundle.retrieval.lookupPlans)
        ) {
          for (const plan of bundle.retrieval.lookupPlans) {
            if (!isRecord(plan)) continue;
            const args = isRecord(plan.args) ? plan.args : null;
            if (!args) continue;
            const postId = asPositiveInt(args.postId);
            const commentId = asPositiveInt(args.commentId) ?? null;
            if (!postId) continue;
            pushCandidate({
              postId,
              commentId:
                input.action === "comment" ? (commentId ?? null) : null,
              authorId: null,
              source: "memory_lookup_plan",
            });
          }
        }
        trace.push({
          step: "memory_context",
          queryCount: 1,
          cacheHits: 0,
          addedCandidates: candidates.length - before,
          totalCandidates: candidates.length,
        });
      } catch (error: unknown) {
        await this.ctx.memory
          .recordWrite({
            type: "engagement_target_lookup_failed",
            at: nowIso(),
            commandId: input.commandId,
            action: input.action,
            step: "memory_context",
            source: "memory",
            lookupAction: "buildContext",
            error: error instanceof Error ? error.message : String(error),
          })
          .catch(() => undefined);
      }
    }

    const hintPlans: LookupPlan[] = [];
    if (hintedPostId) {
      hintPlans.push({
        source: "hint_post_lookup",
        request: { action: "find_post", postId: hintedPostId },
      });
    }
    for (const handle of hints.handles.slice(0, 4)) {
      hintPlans.push({
        source: "hint_handle_latest",
        request: {
          action: "find_post",
          authorHandle: `@${handle}`,
          latest: true,
        },
      });
    }
    await runLookupStep("payload_hints", hintPlans);

    const mentionParser = (value: unknown): EngagementTargetCandidate[] => {
      const resolved: EngagementTargetCandidate[] = [];
      for (const row of this.collectBridgeRecordItems(value)) {
        const targetType = asNonEmptyString(row.targetType)?.toLowerCase() ?? "";
        if (targetType !== "post") continue;
        const targetId = asPositiveInt(row.targetId);
        if (!targetId) continue;
        const targetCommentId = asPositiveInt(row.targetCommentId) ?? null;
        resolved.push({
          postId: targetId,
          commentId: input.action === "comment" ? targetCommentId : null,
          authorId: null,
          source: "unanswered_mention",
        });
      }
      return resolved;
    };
    const ownCommentPlans: LookupPlan[] = [];
    if (input.action === "comment" && agentHandle) {
      ownCommentPlans.push({
        source: "own_latest",
        request: {
          action: "find_post",
          authorHandle: `@${agentHandle}`,
          latest: true,
        },
      });
    }
    ownCommentPlans.push({
      source: "unanswered_mention",
      request: {
        action: "browse_unanswered_mentions",
        limit: 24,
        sinceHours: 24 * 14,
      },
      parser: mentionParser,
    });
    await runLookupStep("high_signal", ownCommentPlans);

    let topEngagerHandles: string[] = [];
    if (hasBridge) {
      const topEngagerResult = await this.callAgentBridgeLookupCached({
        action: "browse_top_engagers",
        limit: 10,
        windowHours: 24 * 14,
      }).catch((error: unknown) => {
        bridgeQueryFailureCount += 1;
        void this.ctx.memory
          .recordWrite({
            type: "engagement_target_lookup_failed",
            at: nowIso(),
            commandId: input.commandId,
            action: input.action,
            step: "browse_top_engagers",
            source: "browse_top_engagers",
            lookupAction: "browse_top_engagers",
            error: error instanceof Error ? error.message : String(error),
          })
          .catch(() => undefined);
        return null;
      });
      if (topEngagerResult) {
        bridgeQuerySuccessCount += 1;
        topEngagerHandles = this.collectBridgeRecordItems(topEngagerResult.value)
          .map((row) => {
            const user = isRecord(row.user) ? row.user : null;
            return asNonEmptyString(user?.handle) ?? asNonEmptyString(row.handle) ?? null;
          })
          .filter((entry): entry is string => Boolean(entry))
          .map((entry) => entry.replace(/^@+/u, "").toLowerCase())
          .slice(0, 4);
        trace.push({
          step: "browse_top_engagers",
          queryCount: 1,
          cacheHits: topEngagerResult.cacheHit ? 1 : 0,
          addedCandidates: 0,
          totalCandidates: candidates.length,
        });
      }
    }
    const topEngagerPlans: LookupPlan[] = topEngagerHandles.map((handle) => ({
      source: "top_engager_latest",
      request: {
        action: "find_post",
        authorHandle: `@${handle}`,
        latest: true,
      },
    }));
    topEngagerPlans.push({
      source: "recent_actions",
      request: {
        action: "browse_recent_actions",
        limit: 18,
      },
    });
    await runLookupStep("engagement_network", topEngagerPlans);

    const hasConfidentCandidate = (): boolean =>
      candidates.some((candidate) => {
        if (input.action === "comment") {
          return (
            candidate.source === "notifications_unread" ||
            candidate.source === "notifications_recent" ||
            candidate.source === "own_latest" ||
            candidate.source === "unanswered_mention"
          );
        }
        return (
          candidate.source === "notifications_unread" ||
          candidate.source === "notifications_recent" ||
          candidate.source === "unanswered_mention" ||
          candidate.source === "top_engager_latest" ||
          candidate.source === "recent_actions"
        );
      });

    if (!hasConfidentCandidate()) {
      await runLookupStep("broad_feed", [
        {
          source: "home_feed",
          request: { action: "browse_home_feed", limit: 24 },
        },
        {
          source: "trending",
          request: { action: "browse_trending", limit: 24 },
        },
        {
          source: "explore",
          request: { action: "browse_posts", limit: 24 },
        },
      ]);
    }

    if (!hasConfidentCandidate() && hints.rawQuery.trim().length > 2) {
      await runLookupStep("search_global", [
        {
          source: "search_global",
          request: {
            action: "search_global",
            query: truncateText(hints.rawQuery, 220),
            limit: 24,
          },
        },
      ]);
    }

    if (candidates.length === 0) {
      await this.ctx.memory
        .recordWrite({
          type: "engagement_target_resolution_failed",
          at: nowIso(),
          commandId: input.commandId,
          action: input.action,
          reason:
            bridgeQuerySuccessCount > 0
              ? "no_candidates_discovery_exhausted"
              : bridgeQueryFailureCount > 0
                ? "lookup_transient_failure"
                : hasBridge
                  ? "no_candidates_unknown"
                  : "bridge_unavailable",
          query: hints.rawQuery,
          bridgeQuerySuccessCount,
          bridgeQueryFailureCount,
          trace,
        })
        .catch(() => undefined);
      if (bridgeQuerySuccessCount > 0) {
        throw new Error("engagement_target_unavailable:no_targets_discovered");
      }
      return null;
    }

    const byTargetKey = new Map<string, EngagementTargetCandidate>();
    for (const candidate of candidates) {
      const key = `${candidate.postId}:${candidate.commentId ?? 0}`;
      byTargetKey.set(key, candidate);
    }
    const hydrationPool = [...byTargetKey.values()].slice(0, 10);
    await runLookupStep(
      "candidate_hydration",
      hydrationPool.map((candidate) => ({
        source: "hydrate_find_post",
        request: {
          action: "find_post",
          postId: candidate.postId,
        },
        parser: (value: unknown): EngagementTargetCandidate[] => {
          const postRecord = this.extractPostRecordForCommentCuration(value, candidate.postId);
          if (!postRecord) return [];
          const author = isRecord(postRecord.author) ? postRecord.author : null;
          const authorId =
            asNonEmptyString(author?.mainUserId) ??
            asNonEmptyString(author?.id) ??
            asNonEmptyString(postRecord.authorId) ??
            candidate.authorId;
          return [
            {
              ...candidate,
              authorId,
              source: candidate.source,
            },
          ];
        },
      })),
    );

    const preferredSourceOrderComment = new Map<string, number>([
      ["notifications_unread", 0],
      ["notifications_recent", 1],
      ["payload_hint", 2],
      ["memory_lookup_plan", 2],
      ["memory_retrieval", 2],
      ["own_latest", 3],
      ["unanswered_mention", 4],
      ["top_engager_latest", 5],
      ["recent_actions", 6],
      ["home_feed", 7],
      ["trending", 8],
      ["search_global", 9],
      ["explore", 10],
      ["memory_event", 11],
      ["directive_payload", 12],
    ]);
    const preferredSourceOrderEngagement = new Map<string, number>([
      ["notifications_unread", 0],
      ["notifications_recent", 1],
      ["payload_hint", 2],
      ["memory_lookup_plan", 2],
      ["unanswered_mention", 2],
      ["top_engager_latest", 3],
      ["recent_actions", 4],
      ["home_feed", 5],
      ["trending", 6],
      ["search_global", 7],
      ["explore", 8],
      ["memory_retrieval", 9],
      ["memory_event", 10],
      ["own_latest", 11],
      ["directive_payload", 12],
    ]);

    const rankTable =
      input.action === "comment"
        ? preferredSourceOrderComment
        : preferredSourceOrderEngagement;
    const scoreCandidate = (candidate: EngagementTargetCandidate): number => {
      const sourceRank = rankTable.get(candidate.source) ?? 999;
      const isOwn =
        Boolean(agentMainUserId) && candidate.authorId === agentMainUserId;
      const ownBias =
        input.action === "comment"
          ? isOwn
            ? 80
            : 15
          : isOwn
            ? -140
            : 40;
      const commentBias =
        input.action === "comment" && candidate.commentId ? 26 : 0;
      return 10_000 - sourceRank * 120 + ownBias + commentBias + (candidate.postId % 17);
    };
    candidates.sort((a, b) => {
      const delta = scoreCandidate(b) - scoreCandidate(a);
      if (delta !== 0) return delta;
      if (a.postId !== b.postId) return b.postId - a.postId;
      const aComment = a.commentId ?? 0;
      const bComment = b.commentId ?? 0;
      return bComment - aComment;
    });
    let selected = candidates[0] ?? null;
    if (!selected) return null;

    if (input.action === "comment" && !selected.commentId) {
      const selectedPostId = selected.postId;
      try {
        const commentLookup = await this.callAgentBridgeLookupCached({
          action: "browse_comments",
          postId: selectedPostId,
          limit: 12,
        });
        const commentRecords = this.collectBridgeRecordItems(commentLookup.value)
          .map((entry) => {
            const postId = asPositiveInt(entry.postId);
            const commentId = asPositiveInt(entry.commentId) ?? asPositiveInt(entry.id);
            if (!postId || postId !== selectedPostId || !commentId) return null;
            const author = isRecord(entry.author) ? entry.author : null;
            const authorId =
              asNonEmptyString(author?.mainUserId) ??
              asNonEmptyString(author?.id) ??
              asNonEmptyString(entry.authorId) ??
              null;
            const createdAtRaw =
              asNonEmptyString(entry.createdAt) ??
              asNonEmptyString(entry.created_at);
            const createdAtMs = createdAtRaw ? Date.parse(createdAtRaw) : NaN;
            return {
              commentId,
              authorId,
              createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : -1,
            };
          })
          .filter(
            (
              value,
            ): value is { commentId: number; authorId: string | null; createdAtMs: number } =>
              Boolean(value),
          )
          .filter((value) => !agentMainUserId || value.authorId !== agentMainUserId)
          .sort((a, b) => b.createdAtMs - a.createdAtMs);
        if (commentRecords.length > 0) {
          selected = {
            ...selected,
            commentId: commentRecords[0]?.commentId ?? null,
            source: `${selected.source}+comment_thread`,
          };
        }
      } catch {
        // best-effort parent comment enrichment only
      }
    }

    const resolved = {
      ...selected,
      commentId: input.action === "comment" ? (selected.commentId ?? null) : null,
    };
    this.engagementTargetCache.set(cacheKey, {
      expiresAtMs: Date.now() + ENGAGEMENT_TARGET_CACHE_TTL_MS,
      candidate: resolved,
    });
    this.pruneEngagementTargetCache(Date.now());
    await this.ctx.memory
      .recordWrite({
        type: "engagement_target_resolved",
        at: nowIso(),
        commandId: input.commandId,
        action: input.action,
        postId: resolved.postId,
        commentId: resolved.commentId,
        source: resolved.source,
        query: hints.rawQuery,
        candidatesConsidered: candidates.length,
        trace,
      })
      .catch(() => undefined);
    return resolved;
  }

  private mapAllowedWriteKindToGenerateKind(commandKind: string): string | null {
    const normalized = commandKind.trim().toLowerCase();
    if (normalized === "write.commentpost") return "comment";
    if (normalized === "write.votepost") return "like";
    if (normalized === "write.repostpost") return "repost";
    if (normalized === "write.createstory") return "story";
    if (normalized === "write.createpost") return "thread";
    return null;
  }

  private resolveDirectiveScopeGenerateKinds(payload: Record<string, unknown>): string[] {
    const scope = isRecord(payload.directiveScope) ? payload.directiveScope : null;
    if (!scope || !Array.isArray(scope.allowedCommandKinds)) return [];
    const resolved: string[] = [];
    const seen = new Set<string>();
    for (const value of scope.allowedCommandKinds) {
      if (typeof value !== "string") continue;
      const mapped = this.mapAllowedWriteKindToGenerateKind(value);
      if (!mapped || seen.has(mapped)) continue;
      seen.add(mapped);
      resolved.push(mapped);
    }
    return resolved;
  }

  private async buildGenerateInputWithRuntimeContext(
    payload: Record<string, unknown>,
    command: Command,
  ): Promise<Record<string, unknown>> {
    const base = this.buildGenerateInput(payload, command);
    const postId = asPositiveInt(base.postId);
    const commentId = asPositiveInt(base.commentId);
    const payloadHint = this.extractCommentPayloadHint(payload);
    const contextLines: string[] = [];

    if (postId && this.ctx.callAgentChatBridge) {
      try {
        const postResponse = await this.ctx.callAgentChatBridge({
          action: "find_post",
          postId,
        });
        const postRecord = this.extractPostRecordForCommentCuration(postResponse, postId);
        if (postRecord) {
          const postText =
            asNonEmptyString(postRecord.textBody) ??
            asNonEmptyString(postRecord.caption) ??
            asNonEmptyString(postRecord.body);
          if (postText) contextLines.push(`targetPostText: ${truncateText(postText, 260)}`);
          const mediaSummary = this.summarizePostMediaForComment(postRecord);
          if (mediaSummary) contextLines.push(`targetMedia: ${mediaSummary}`);
        }
      } catch {
        // best effort context enrichment only
      }
    }

    if (postId && commentId && this.ctx.callAgentChatBridge) {
      try {
        const commentResponse = await this.ctx.callAgentChatBridge({
          action: "find_comment",
          postId,
          commentId,
        });
        const commentRecord = this.extractCommentRecordForCommentCuration(commentResponse);
        if (commentRecord) {
          const body =
            asNonEmptyString(commentRecord.body) ??
            asNonEmptyString(commentRecord.textBody);
          if (body) contextLines.push(`targetComment: ${truncateText(body, 220)}`);
        }
      } catch {
        // best effort context enrichment only
      }
    }

    if (typeof this.ctx.memory.buildContext === "function") {
      try {
        const bundle = await this.ctx.memory.buildContext({
          mode: "directive",
          audience: "runtime_generate",
          ...(postId ? { postId } : {}),
          ...(commentId ? { commentId } : {}),
          maxRecentEvents: 120,
          maxArchiveEvents: 40,
          includeViewState: true,
          viewStateMaxItems: 10,
          includeKeywordRetrieval: true,
          retrievalIntent: "directive",
          retrievalMaxItems: 10,
          retrievalQuery: [
            payloadHint ?? "",
            postId ? `post ${postId}` : "",
            commentId ? `comment ${commentId}` : "",
          ]
            .filter((value) => value.length > 0)
            .join(" · "),
        });
        const memorySummary = this.buildCompactEngagementMemorySummary(bundle);
        if (memorySummary) {
          contextLines.push(`memory: ${truncateText(memorySummary, 900)}`);
        }
      } catch {
        // best effort context enrichment only
      }
    }

    const contextHint = truncateText(
      [
        payloadHint ? `directiveHint: ${payloadHint}` : "",
        ...contextLines,
      ]
        .filter((value) => value.length > 0)
        .join("\n"),
      2200,
    );

    const topic =
      asNonEmptyString(base.topic) ??
      payloadHint ??
      (contextLines.length > 0 ? truncateText(contextLines.join(" | "), 120) : null);

    return {
      ...base,
      ...(topic ? { topic: truncateText(topic, 120) } : {}),
      ...(contextHint.length > 0 ? { contextHint } : {}),
    };
  }

  private normalizeRequestedGenerateKind(value: unknown): string | null {
    const raw = asNonEmptyString(value)?.toLowerCase();
    if (!raw) return null;
    const normalized = raw.replace(/[\s-]+/gu, "_");
    if (
      normalized === "story" ||
      normalized === "thread" ||
      normalized === "comment" ||
      normalized === "like" ||
      normalized === "repost" ||
      normalized === "media" ||
      normalized === "multi_media"
    ) {
      return normalized;
    }
    if (normalized === "reply") return "comment";
    if (normalized === "engagement") return "like";
    if (normalized === "boost") return "repost";
    if (
      normalized === "post" ||
      normalized === "image" ||
      normalized === "avatar" ||
      normalized === "banner"
    ) {
      return "media";
    }
    if (normalized === "carousel") return "multi_media";
    return null;
  }

  private resolveRequestedGenerateKinds(
    payload: Record<string, unknown>,
    fallbackKind: string,
  ): string[] {
    const kinds: string[] = [];
    const seen = new Set<string>();
    const pushKind = (value: unknown): void => {
      const normalized = this.normalizeRequestedGenerateKind(value);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      kinds.push(normalized);
    };
    const pushArray = (value: unknown): void => {
      if (!Array.isArray(value)) return;
      for (const entry of value) {
        pushKind(entry);
      }
    };
    const pushCsvLike = (value: unknown): void => {
      const text = asNonEmptyString(value);
      if (!text) return;
      for (const token of text.split(/[,|]/u)) {
        pushKind(token);
      }
    };

    pushArray(payload.kinds);
    pushArray(payload.generateKinds);
    if (!Array.isArray(payload.kinds)) {
      pushCsvLike(payload.kinds);
    }
    if (!Array.isArray(payload.generateKinds)) {
      pushCsvLike(payload.generateKinds);
    }
    if (Array.isArray(payload.generateKind)) {
      pushArray(payload.generateKind);
    } else {
      pushKind(payload.generateKind);
    }

    if (kinds.length === 0) pushKind(payload.goal);
    if (kinds.length === 0) pushKind(payload.kind);
    if (kinds.length === 0) pushKind(fallbackKind);
    return kinds.slice(0, 6);
  }

  private parsePermissionCanState(permissionState: unknown): {
    hasHints: boolean;
    can: {
      postMedia: boolean;
      postText: boolean;
      story: boolean;
      comment: boolean;
      like: boolean;
      repost: boolean;
    };
  } {
    const canState = isRecord(permissionState)
      ? (isRecord(permissionState.can) ? permissionState.can : permissionState)
      : null;
    const readBoolean = (key: string): boolean | null => {
      if (!canState || typeof canState[key] !== "boolean") return null;
      return canState[key] === true;
    };
    const values = {
      postMedia: readBoolean("postMedia"),
      postText: readBoolean("postText"),
      story: readBoolean("story"),
      comment: readBoolean("comment"),
      like: readBoolean("like"),
      repost: readBoolean("repost"),
    };
    return {
      hasHints: Object.values(values).some(
        (value) => typeof value === "boolean",
      ),
      can: {
        postMedia: values.postMedia === true,
        postText: values.postText === true,
        story: values.story === true,
        comment: values.comment === true,
        like: values.like === true,
        repost: values.repost === true,
      },
    };
  }

  private constrainGenerateKindsByPermissionState(
    kinds: string[],
    permissionState: unknown,
  ): string[] {
    const permission = this.parsePermissionCanState(permissionState);
    if (!permission.hasHints || kinds.length === 0) return kinds;
    const allowed = new Set<string>();
    if (permission.can.postMedia || permission.can.postText) {
      allowed.add("thread");
      allowed.add("media");
      allowed.add("multi_media");
    }
    if (permission.can.story) allowed.add("story");
    if (permission.can.comment) allowed.add("comment");
    if (permission.can.like) allowed.add("like");
    if (permission.can.repost) allowed.add("repost");
    if (allowed.size === 0) return kinds;

    const filtered = kinds.filter((kind) => allowed.has(kind));
    if (filtered.length > 0) return filtered.slice(0, 6);

    const fallbackOrder = [
      "comment",
      "like",
      "repost",
      "thread",
      "media",
      "multi_media",
      "story",
    ] as const;
    const fallback = fallbackOrder
      .filter((kind) => allowed.has(kind))
      .slice(0, 6);
    return fallback.length > 0 ? fallback : kinds;
  }

  private applyPermissionGenerateInputConstraints(
    generateInput: Record<string, unknown>,
    permissionState: unknown,
  ): Record<string, unknown> {
    const normalizedKinds: string[] = [];
    const seen = new Set<string>();
    const push = (value: unknown): void => {
      const normalized = this.normalizeRequestedGenerateKind(value);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      normalizedKinds.push(normalized);
    };
    if (Array.isArray(generateInput.kinds)) {
      for (const value of generateInput.kinds) push(value);
    }
    push(generateInput.kind);
    if (normalizedKinds.length === 0) return generateInput;
    const constrained = this.constrainGenerateKindsByPermissionState(
      normalizedKinds,
      permissionState,
    );
    if (
      constrained.length === normalizedKinds.length &&
      constrained.every((value, index) => value === normalizedKinds[index])
    ) {
      return generateInput;
    }
    return {
      ...generateInput,
      kind: constrained[0] ?? generateInput.kind,
      kinds: constrained,
    };
  }

  private isGeneratedDraftAllowedByPermissionState(
    draft: GeneratedDraft,
    permissionState: unknown,
  ): boolean {
    const permission = this.parsePermissionCanState(permissionState);
    if (!permission.hasHints) return true;
    const action = draft.action.trim().toLowerCase();
    if (action === "comment") return permission.can.comment;
    if (action === "like") return permission.can.like;
    if (action === "repost") return permission.can.repost;
    if (action === "story") return permission.can.story;
    if (action === "post") {
      const payload = isRecord(draft.payload) ? draft.payload : null;
      const postType = asNonEmptyString(payload?.postType)?.toLowerCase() ?? "";
      if (postType === "text") return permission.can.postText;
      if (postType === "media") return permission.can.postMedia;
      return permission.can.postMedia || permission.can.postText;
    }
    return true;
  }

  private mapGoalToGenerateKind(goal: string): string {
    if (goal === "avatar") return "media";
    if (goal === "banner") return "media";
    if (goal === "story") return "story";
    if (goal === "thread") return "thread";
    if (goal === "comment" || goal === "reply") return "comment";
    if (goal === "like" || goal === "engagement") return "like";
    if (goal === "repost" || goal === "boost") return "repost";
    if (goal === "multi_media" || goal === "carousel") return "multi_media";
    if (goal === "media" || goal === "image" || goal === "post") return "media";
    return "story";
  }

  private resolveEnforcedDraftAction(
    payload: Record<string, unknown>,
  ): "comment" | "like" | "repost" | null {
    const goal = asNonEmptyString(payload.goal)?.toLowerCase() ?? "";
    if (goal === "comment" || goal === "like" || goal === "repost") return goal;

    const normalizedKinds = this.resolveRequestedGenerateKinds(payload, "story");
    if (normalizedKinds.length === 1) {
      const onlyKind = normalizedKinds[0];
      if (onlyKind === "comment" || onlyKind === "like" || onlyKind === "repost") {
        return onlyKind;
      }
    }
    return null;
  }

  private extractInlineDrafts(payload: Record<string, unknown>): GeneratedDraft[] {
    const drafts = Array.isArray(payload.drafts) ? payload.drafts : [];
    return drafts
      .map((entry) => {
        if (!isRecord(entry) || !isRecord(entry.payload)) return null;
        const action = asNonEmptyString(entry.action);
        if (!action) return null;
        return {
          action,
          payload: entry.payload,
        } satisfies GeneratedDraft;
      })
      .filter((entry): entry is GeneratedDraft => Boolean(entry));
  }

  private extractGeneratedDrafts(generatedResult: unknown): GeneratedDraft[] {
    if (!isRecord(generatedResult) || !Array.isArray(generatedResult.items)) return [];
    const drafts: GeneratedDraft[] = [];
    for (const item of generatedResult.items) {
      if (!isRecord(item) || !Array.isArray(item.drafts)) continue;
      for (const draft of item.drafts) {
        if (!isRecord(draft) || !isRecord(draft.payload)) continue;
        const action = asNonEmptyString(draft.action);
        if (!action) continue;
        drafts.push({
          action,
          payload: draft.payload,
        });
      }
    }
    return drafts;
  }

  private mapDraftToWriteCommand(input: {
    draft: GeneratedDraft;
    command: Command;
    sourceDirectiveId: string;
    sourceDirectiveActionNonce: string | null;
    provenance: string | null;
  }): Command | null {
    const draft = input.draft;
    const action = draft.action.trim().toLowerCase();
    const inheritedPayload = inheritChatContextIntoPayload({
      payload: draft.payload,
      sourcePayload: input.command.payload,
    });
    const payload = isRecord(inheritedPayload) ? inheritedPayload : null;
    if (!payload) return null;

    const basePayload: Record<string, unknown> = {
      ...payload,
      ...(input.provenance ? { provenance: input.provenance } : {}),
      sourceDirectiveId: input.sourceDirectiveId,
      ...(input.sourceDirectiveActionNonce
        ? { sourceDirectiveActionNonce: input.sourceDirectiveActionNonce }
        : {}),
    };

    const id = `draft_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const createdAt = nowIso();

    const mappedKind =
      action === "story"
        ? "write.createStory"
        : action === "comment"
          ? "write.commentPost"
          : action === "repost"
            ? "write.repostPost"
          : action === "avatar"
            ? "write.updateAvatar"
            : action === "banner"
              ? "write.updateBanner"
            : action === "like"
              ? "write.votePost"
              : action === "post"
              ? "write.createPost"
              : null;
    if (!mappedKind) return null;

    const sourcePayload = isRecord(input.command.payload) ? input.command.payload : null;
    const sourcePostId = sourcePayload
      ? asPositiveInt(sourcePayload.postId) ??
        asPositiveInt(sourcePayload.targetPostId)
      : null;
    const sourceCommentId = sourcePayload
      ? asPositiveInt(sourcePayload.parentId) ??
        asPositiveInt(sourcePayload.commentId) ??
        asPositiveInt(sourcePayload.targetCommentId)
      : null;

    if (mappedKind === "write.votePost") {
      basePayload.vote = 1;
    }
    if (
      mappedKind === "write.commentPost" ||
      mappedKind === "write.votePost" ||
      mappedKind === "write.repostPost"
    ) {
      const lockedPostId = sourcePostId ?? asPositiveInt(basePayload.postId);
      const lockedCommentId =
        mappedKind === "write.commentPost"
          ? sourceCommentId ?? asPositiveInt(basePayload.parentId)
          : null;
      if (lockedPostId) {
        basePayload.postId = lockedPostId;
        if (mappedKind === "write.commentPost" && lockedCommentId) {
          basePayload.parentId = lockedCommentId;
          basePayload.commentId = lockedCommentId;
        }
        applyTargetLock(basePayload, {
          postId: lockedPostId,
          commentId: lockedCommentId ?? null,
        });
      }
    }
    if (mappedKind === "write.createPost") {
      const postTypeRaw = asNonEmptyString(basePayload.postType)?.toLowerCase();
      if (!postTypeRaw) {
        if (asNonEmptyString(basePayload.textBody)) {
          basePayload.postType = "text";
        } else {
          basePayload.postType = "media";
        }
      }
    }

    const command: Command = {
      id,
      createdAt,
      kind: mappedKind,
      grantId: input.command.grantId,
      payload: basePayload,
      sig: null,
      sourceDirectiveId: input.sourceDirectiveId,
      pendingDirectiveId: input.command.pendingDirectiveId,
      actionNonce: input.sourceDirectiveActionNonce,
      challenge: null,
      forceNow: input.command.forceNow,
      runtimeSessionId: null,
      runtimeOrigin: null,
      runtimeSig: null,
    };
    if (this.ctx.controlKey) {
      command.sig = computeCommandSignature(this.ctx.controlKey, command);
    }
    return command;
  }

  private collectMediaReferenceInputs(payload: Record<string, unknown>): string[] {
    const context = isRecord(payload.context) ? payload.context : null;
    const collected: string[] = [];
    const pushMaybe = (value: unknown): void => {
      if (typeof value !== "string") return;
      const trimmed = value.trim();
      if (!trimmed.length) return;
      collected.push(trimmed);
    };
    const pushMaybeArray = (value: unknown): void => {
      if (!Array.isArray(value)) return;
      for (const entry of value) {
        if (typeof entry === "string") {
          pushMaybe(entry);
          continue;
        }
        if (!isRecord(entry)) continue;
        pushMaybe(entry.mediaRef);
        pushMaybe(entry.uploadedUrl);
        pushMaybe(entry.originalUrl);
        pushMaybe(entry.url);
        pushMaybe(entry.image);
        pushMaybe(entry.imageUrl);
        pushMaybe(entry.mediaUrl);
        pushMaybe(entry.file);
        pushMaybe(entry.path);
        pushMaybe(entry.href);
      }
    };

    [
      payload.mediaReferenceUrls,
      payload.mediaReferenceFiles,
      payload.mediaReferenceMedia,
      payload.referenceMedia,
      payload.referenceImages,
      payload.taggedUsers,
      payload.mediaItems,
      context?.mediaReferenceUrls,
      context?.mediaReferenceFiles,
      context?.mediaReferenceMedia,
      context?.referenceMedia,
      context?.referenceImages,
      context?.taggedUsers,
      context?.mediaItems,
    ].forEach((value) => pushMaybeArray(value));
    [
      payload.mediaReferenceUrl,
      payload.mediaReferenceFile,
      payload.referenceImage,
      payload.referenceMediaUrl,
      context?.mediaReferenceUrl,
      context?.mediaReferenceFile,
      context?.referenceImage,
      context?.referenceMediaUrl,
    ].forEach((value) => pushMaybe(value));

    const recentGeneratedAsset = isRecord(payload.recentGeneratedAsset)
      ? payload.recentGeneratedAsset
      : null;
    pushMaybe(recentGeneratedAsset?.href);
    pushMaybe(recentGeneratedAsset?.url);
    pushMaybe(recentGeneratedAsset?.imageUrl);
    pushMaybe(recentGeneratedAsset?.mediaUrl);

    return Array.from(new Set(collected)).slice(0, MAX_COLLECTED_REFERENCE_INPUTS);
  }

  private async resolveLocalReferencePath(reference: string): Promise<string | null> {
    const trimmed = reference.trim();
    if (!trimmed.length) return null;

    if (isFileUrl(trimmed)) {
      try {
        const parsed = new URL(trimmed);
        let candidatePath = decodeURIComponent(parsed.pathname);
        if (process.platform === "win32" && /^\/[a-zA-Z]:/u.test(candidatePath)) {
          candidatePath = candidatePath.slice(1);
        }
        const absolutePath = path.resolve(candidatePath);
        await fs.access(absolutePath);
        return absolutePath;
      } catch {
        return null;
      }
    }

    if (isHttpUrl(trimmed) || isDataUri(trimmed)) return null;
    const absolutePath = path.resolve(trimmed);
    const fileStat = await fs.stat(absolutePath).catch(() => null);
    if (!fileStat?.isFile()) return null;
    return absolutePath;
  }

  private async materializeMediaReferenceFiles(input: {
    requestDir: string;
    referenceInputs: string[];
    maxReferenceInputs?: number;
  }): Promise<string[]> {
    const maxReferenceInputsRaw =
      typeof input.maxReferenceInputs === "number" &&
      Number.isFinite(input.maxReferenceInputs)
        ? Math.floor(input.maxReferenceInputs)
        : MAX_MEDIA_REFERENCE_INPUTS;
    const maxReferenceInputs = Math.max(
      0,
      Math.min(MAX_MEDIA_REFERENCE_INPUTS, maxReferenceInputsRaw),
    );
    if (maxReferenceInputs === 0 || input.referenceInputs.length === 0) return [];
    const refsDir = path.join(input.requestDir, "refs");
    await ensureDir(refsDir);
    const resolved: string[] = [];
    const seen = new Set<string>();

    const pushResolved = (value: string): void => {
      if (resolved.length >= maxReferenceInputs) return;
      const normalized = path.resolve(value);
      if (seen.has(normalized)) return;
      seen.add(normalized);
      resolved.push(normalized);
    };

    for (const rawReference of input.referenceInputs) {
      if (resolved.length >= maxReferenceInputs) break;
      const reference = rawReference.trim();
      if (!reference.length) continue;

      const localPath = await this.resolveLocalReferencePath(reference);
      if (localPath) {
        pushResolved(localPath);
        continue;
      }

      if (isDataUri(reference)) {
        const parsed = parseDataUriPayload(reference);
        if (!parsed) continue;
        const targetPath = path.join(
          refsDir,
          `data-${resolved.length + 1}.${mimeToExt(parsed.mime)}`,
        );
        await fs
          .writeFile(targetPath, Buffer.from(parsed.data, "base64"))
          .then(() => pushResolved(targetPath))
          .catch(() => undefined);
        continue;
      }

      if (isHttpUrl(reference)) {
        try {
          const response = await fetch(reference);
          if (!response.ok) continue;
          const bytes = Buffer.from(await response.arrayBuffer());
          if (!bytes.byteLength) continue;
          const contentType =
            response.headers.get("content-type") ??
            inferMimeTypeFromUrl(reference) ??
            "application/octet-stream";
          const targetPath = path.join(
            refsDir,
            `remote-${resolved.length + 1}.${mimeToExt(contentType)}`,
          );
          await fs.writeFile(targetPath, bytes);
          pushResolved(targetPath);
        } catch {
          // best effort only for reference enrichment
        }
      }
    }

    return resolved;
  }

  private async resolveMediaUpload(input: {
    payload: Record<string, unknown>;
    keepOriginal?: boolean;
    promptFallbacks: Array<string | null>;
    command?: Command;
  }): Promise<ResolvedMediaUpload> {
    const payload = input.payload;
    const keepOriginal = input.keepOriginal === true;
    const markUploaded = async (
      result: ResolvedMediaUpload,
      source: string,
    ): Promise<ResolvedMediaUpload> => {
      if (input.command) {
        await this.recordCommandLifecycleCheckpoint({
          command: input.command,
          stage: "uploaded",
          status: "ok",
          metadata: {
            source,
            mediaUrl: result.mediaUrl,
            mediaType: result.mediaType ?? null,
          },
        });
      }
      return result;
    };
    const existingMediaUrl = asNonEmptyString(payload.mediaUrl);
    if (existingMediaUrl) {
      const resolved = await this.uploadResolvedMediaSource(existingMediaUrl, { keepOriginal });
      return markUploaded(resolved, "payload.mediaUrl");
    }

    const mediaItems = Array.isArray(payload.mediaItems) ? payload.mediaItems : [];
    for (const mediaItem of mediaItems) {
      if (!isRecord(mediaItem)) continue;
      const mediaUrl = asNonEmptyString(mediaItem.mediaUrl);
      if (mediaUrl) {
        const resolved = await this.uploadResolvedMediaSource(mediaUrl, { keepOriginal });
        return markUploaded(resolved, "payload.mediaItems");
      }
    }

    const prompt =
      input.promptFallbacks.find((entry) => typeof entry === "string" && entry.trim().length > 0) ??
      null;
    if (!prompt) {
      throw new Error("no_media_url");
    }
    const generated = await this.generateAndUploadMediaFromPrompt(prompt, {
      generatedAssetType: this.resolveGeneratedAssetType(payload.generatedAssetType),
      mode: "write_media_generate",
      referenceInputs: this.collectMediaReferenceInputs(payload),
      keepOriginal,
    });
    return markUploaded(generated, "generated_prompt");
  }

  private async uploadResolvedMediaSource(
    source: string,
    options?: { keepOriginal?: boolean },
  ): Promise<ResolvedMediaUpload> {
    const keepOriginal = options?.keepOriginal === true;
    const trimmed = source.trim();
    if (isDataUri(trimmed)) {
      const parsed = parseDataUriPayload(trimmed);
      if (parsed) {
        const bytes = Buffer.from(parsed.data, "base64");
        if (bytes.byteLength > 0) {
          const uploadedByChunk = await this.uploadBytesViaChunkRoute({
            bytes,
            mimeType: parsed.mime,
            filename: `upload-${Date.now()}.${mimeToExt(parsed.mime)}`,
            keepOriginal,
          });
          if (uploadedByChunk) return uploadedByChunk;
        }
      }
      const uploaded = await this.agent().uploadDataUri.mutate({
        dataUri: trimmed,
        keepOriginal,
      });
      return this.mapUploadResult(uploaded);
    }
    if (isHttpUrl(trimmed)) {
      const uploaded = await this.agent().uploadRemote.mutate({
        url: trimmed,
        keepOriginal,
      });
      return this.mapUploadResult(uploaded);
    }
    const localPath = path.resolve(trimmed);
    const bytes = await fs.readFile(localPath);
    if (!bytes.byteLength) {
      throw new Error("media_source_empty");
    }
    const mimeByExt = extToMime(localPath);
    const mime =
      mimeByExt === "application/octet-stream"
        ? sniffMimeTypeFromBytes(bytes) ?? mimeByExt
        : mimeByExt;
    const uploadedByChunk = await this.uploadBytesViaChunkRoute({
      bytes,
      mimeType: mime,
      filename: path.basename(localPath) || `upload-${Date.now()}.${mimeToExt(mime)}`,
      keepOriginal,
    });
    if (uploadedByChunk) return uploadedByChunk;
    const dataUri = `data:${mime};base64,${bytes.toString("base64")}`;
    const uploaded = await this.agent().uploadDataUri.mutate({
      dataUri,
      keepOriginal,
    });
    return this.mapUploadResult(uploaded);
  }

  private async uploadBytesViaChunkRoute(input: {
    bytes: Buffer;
    mimeType: string;
    filename: string;
    keepOriginal?: boolean;
  }): Promise<ResolvedMediaUpload | null> {
    const callAgentUploadChunk = this.ctx.callAgentUploadChunk;
    if (!callAgentUploadChunk) return null;
    const totalBytes = input.bytes.byteLength;
    if (!totalBytes) return null;
    let uploadId: string | null = null;
    try {
      const started = await callAgentUploadChunk({
        op: "start",
        filename: input.filename,
        mimeType: input.mimeType,
        totalBytes,
        keepOriginal: input.keepOriginal === true,
      });
      if (!isRecord(started) || typeof started.uploadId !== "string") {
        throw new Error("chunk_upload_start_invalid");
      }
      uploadId = started.uploadId.trim();
      if (!uploadId.length) {
        throw new Error("chunk_upload_start_missing_id");
      }
      const chunkMaxBytes =
        typeof started.chunkMaxBytes === "number" &&
        Number.isFinite(started.chunkMaxBytes)
          ? Math.max(64 * 1024, Math.floor(started.chunkMaxBytes))
          : 256 * 1024;
      let chunkIndex = 0;
      for (let offset = 0; offset < totalBytes; offset += chunkMaxBytes) {
        const end = Math.min(totalBytes, offset + chunkMaxBytes);
        const chunk = input.bytes.subarray(offset, end);
        await callAgentUploadChunk({
          op: "append",
          uploadId,
          chunkIndex,
          chunkBase64: chunk.toString("base64"),
        });
        chunkIndex += 1;
      }
      const completed = await callAgentUploadChunk({
        op: "complete",
        uploadId,
      });
      return this.mapUploadResult(completed);
    } catch (error: unknown) {
      await this.ctx.memory
        .recordWrite({
          type: "chunk_upload_failed",
          at: nowIso(),
          filename: input.filename,
          sizeBytes: totalBytes,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      if (uploadId) {
        await callAgentUploadChunk({
          op: "abort",
          uploadId,
        })
          .catch(() => undefined);
      }
      return null;
    }
  }

  private mapUploadResult(uploaded: unknown): ResolvedMediaUpload {
    const data = isRecord(uploaded) ? uploaded : null;
    const mediaUrl =
      asNonEmptyString(data?.optimizedUrl) ??
      asNonEmptyString(data?.url) ??
      asNonEmptyString(data?.mediaUrl);
    if (!mediaUrl) {
      throw new Error("no_media_url");
    }
    const mediaTypeRaw = asNonEmptyString(data?.mediaType)?.toLowerCase();
    const mediaType =
      mediaTypeRaw === "video"
        ? ("video" as const)
        : mediaTypeRaw === "image"
          ? ("image" as const)
          : undefined;
    const originalUrl = asNonEmptyString(data?.originalUrl) ?? mediaUrl;
    const optimizedUrl = asNonEmptyString(data?.optimizedUrl) ?? mediaUrl;
    const result: ResolvedMediaUpload = {
      mediaUrl,
      mediaOriginalUrl: originalUrl,
      mediaOptimizedUrl: optimizedUrl,
    };
    const contentHash = asNonEmptyString(data?.contentHash);
    const ipfsCid = asNonEmptyString(data?.ipfsCid);
    if (contentHash) result.mediaContentHash = contentHash;
    if (ipfsCid) result.mediaIpfsCid = ipfsCid;
    if (typeof data?.sizeBytes === "number" && Number.isFinite(data.sizeBytes)) {
      result.mediaSizeBytes = Math.max(1, Math.floor(data.sizeBytes));
    }
    if (mediaType) result.mediaType = mediaType;
    return result;
  }

  private normalizeCuratedMediaPrompt(value: string): string {
    const unfenced = value
      .replace(/^```(?:json|text|markdown)?\s*/iu, "")
      .replace(/```$/u, "")
      .trim();
    const unquoted = unfenced.replace(/^["'`]|["'`]$/gu, "").trim();
    const withoutLabel = unquoted.replace(
      /^(?:prompt|image prompt|media prompt)\s*:\s*/iu,
      "",
    );
    const withoutGenerationVerb = withoutLabel.replace(
      /^(?:please\s+)?(?:generate|create|make|draw|render)\s+(?:an?\s+)?(?:image|gif|avatar|file|video|audio|pdf|csv|code|markdown|md|txt)\s*(?:of|for)?\s*:?\s*/iu,
      "",
    );
    return stripEmDashCharacters(withoutGenerationVerb).trim();
  }

  private extractCuratedMediaPromptFromUnknown(value: unknown): string | null {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed.length) return null;
      const parsed = parseJsonFromMixedText(trimmed);
      if (parsed !== null && parsed !== value) {
        const fromParsed = this.extractCuratedMediaPromptFromUnknown(parsed);
        if (fromParsed) return fromParsed;
      }
      const normalized = this.normalizeCuratedMediaPrompt(trimmed);
      return normalized.length > 0 ? normalized : null;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const extracted = this.extractCuratedMediaPromptFromUnknown(entry);
        if (extracted) return extracted;
      }
      return null;
    }
    if (!isRecord(value)) return null;

    const directPromptKeys = [
      "prompt",
      "mediaPrompt",
      "imagePrompt",
      "filePrompt",
      "text",
      "output",
      "result",
      "content",
    ] as const;
    for (const key of directPromptKeys) {
      const extracted = this.extractCuratedMediaPromptFromUnknown(value[key]);
      if (extracted) return extracted;
    }
    return null;
  }

  private buildMediaPromptCurationRequest(input: {
    sourcePrompt: string;
    generatedAssetType: GeneratedAssetType;
    mode: string;
  }): string {
    const assetLabel =
      input.generatedAssetType === "gif"
        ? "animated GIF"
        : input.generatedAssetType === "pdf"
          ? "PDF file"
          : input.generatedAssetType === "csv"
            ? "CSV file"
            : input.generatedAssetType === "code"
              ? "code file"
              : input.generatedAssetType === "md"
                ? "markdown file"
                : input.generatedAssetType === "txt"
                  ? "text file"
                  : input.generatedAssetType === "file"
                    ? "file"
                    : "image";
    const rules = [
      "- Do not include wrappers like \"Generate an image of\".",
      "- Do not mention social-app internals, APIs, tools, or instructions.",
      "- Keep it concrete, visual/technical, and production-ready.",
      "- Preserve user intent and style.",
    ];
    if (input.generatedAssetType === "gif") {
      rules.push(
        "- For GIF output include explicit animation direction and motion beats.",
        "- Include exact output size 256x256 and keep the main subject centered.",
        "- Favor a seamless loop and avoid tiny unreadable details.",
      );
    }
    return [
      "You are Clawdbot prompt-crafter for media/file generation.",
      `Target output type: ${assetLabel}.`,
      `Execution mode: ${input.mode}.`,
      "Rewrite the user request into one high-quality generator prompt.",
      "Return strict JSON only with exactly this shape: {\"prompt\":\"...\"}.",
      "Rules:",
      ...rules,
      `User request: ${input.sourcePrompt}`,
    ].join("\n");
  }

  private async curateMediaPromptWithOpenClaw(input: {
    sourcePrompt: string;
    generatedAssetType: GeneratedAssetType;
    mode: string;
  }): Promise<string> {
    const runOpenClawPrompt = this.ctx.runOpenClawPrompt;
    if (!runOpenClawPrompt) {
      throw new Error("prompt_curation_unavailable");
    }
    const curationPrompt = this.buildMediaPromptCurationRequest(input);
    const result = await runOpenClawPrompt({
      prompt: curationPrompt,
      purpose: "media_prompt_curation",
    });
    const curatedPrompt =
      (result
        ? this.extractCuratedMediaPromptFromUnknown(result.parsed) ??
          this.extractCuratedMediaPromptFromUnknown(result.payloadText) ??
          this.extractCuratedMediaPromptFromUnknown(result.raw)
        : null) ?? null;
    if (!curatedPrompt || curatedPrompt.trim().length < 8) {
      await this.ctx.memory
        .recordWrite({
          type: "media_prompt_curation_failed",
          at: nowIso(),
          mode: input.mode,
          generatedAssetType: input.generatedAssetType,
          sourcePrompt: truncateText(input.sourcePrompt, 220),
          reason: "openclaw_no_usable_prompt",
        })
        .catch(() => undefined);
      throw new Error("prompt_curation_failed");
    }
    await this.ctx.memory
      .recordWrite({
        type: "media_prompt_curated",
        at: nowIso(),
        mode: input.mode,
        generatedAssetType: input.generatedAssetType,
        sourcePrompt: truncateText(input.sourcePrompt, 220),
        curatedPrompt: truncateText(curatedPrompt, 360),
      })
      .catch(() => undefined);
    return curatedPrompt;
  }

  private resolveMediaGeneratorBaseUrl(): string | null {
    const explicit = asNonEmptyString(process.env.MG_AGENT_MEDIA_GENERATOR_BASE_URL);
    if (explicit) {
      return explicit.replace(/\/+$/u, "");
    }
    const portRaw = asNonEmptyString(process.env.PW_PORT);
    if (portRaw) {
      const port = Number.parseInt(portRaw, 10);
      if (Number.isFinite(port) && port > 0 && port <= 65535) {
        return `http://127.0.0.1:${port}`;
      }
    }
    return MEDIA_GENERATOR_DEFAULT_BASE_URL;
  }

  private extractMediaGeneratorContextId(payload: unknown): string | null {
    if (!isRecord(payload)) return null;
    const direct = asNonEmptyString(payload.contextId);
    if (direct) return direct;
    const context = isRecord(payload.context) ? payload.context : null;
    if (!context) return null;
    return asNonEmptyString(context.id);
  }

  private extractMediaGeneratorContextRecord(payload: unknown): Record<string, unknown> | null {
    if (!isRecord(payload)) return null;
    const nested = isRecord(payload.context) ? payload.context : null;
    if (nested) return nested;
    const hasContextShape =
      payload.status !== undefined ||
      payload.streamEvents !== undefined ||
      payload.savedFiles !== undefined ||
      payload.observedOutputFiles !== undefined;
    return hasContextShape ? payload : null;
  }

  private isTerminalMediaGeneratorStatus(status: string | null): boolean {
    if (!status) return false;
    const normalized = status.trim().toLowerCase();
    return (
      normalized === "done" ||
      normalized === "completed" ||
      normalized === "complete" ||
      normalized === "success" ||
      normalized === "failed" ||
      normalized === "error" ||
      normalized === "cancelled" ||
      normalized === "canceled"
    );
  }

  private parseMediaGenerationProgress(
    payload: unknown,
    timedOut: boolean,
  ): MediaGenerationProgress {
    const context = this.extractMediaGeneratorContextRecord(payload);
    const contextId =
      this.extractMediaGeneratorContextId(payload) ??
      (context ? asNonEmptyString(context.id) : null);
    const contextStatus = context ? asNonEmptyString(context.status) : null;
    const streamEvents = context ? toUnknownArray(context.streamEvents) : [];
    const streamFrames: MediaGeneratorStreamFrame[] = [];
    let latestPreviewUrl: string | null = null;

    for (const rawEntry of streamEvents) {
      if (!isRecord(rawEntry)) continue;
      const sourceFileName =
        asNonEmptyString(rawEntry.sourceFileName) ??
        asNonEmptyString(rawEntry.file_name);
      const streamPartIndexFromName =
        sourceFileName && STREAM_PART_INDEX_PATTERN.test(sourceFileName)
          ? Number.parseInt(
              STREAM_PART_INDEX_PATTERN.exec(sourceFileName)?.[1] ?? "",
              10,
            )
          : null;
      const streamPartIndexRaw =
        typeof rawEntry.streamPartIndex === "number" &&
        Number.isFinite(rawEntry.streamPartIndex)
          ? Math.max(0, Math.floor(rawEntry.streamPartIndex))
          : streamPartIndexFromName !== null && Number.isFinite(streamPartIndexFromName)
            ? Math.max(0, Math.floor(streamPartIndexFromName))
            : null;
      const isStreamPartFromName =
        sourceFileName !== null && STREAM_PART_ARTIFACT_PATTERN.test(sourceFileName);
      const isStreamPart =
        rawEntry.isStreamPart === true ||
        (typeof streamPartIndexRaw === "number" && Number.isFinite(streamPartIndexRaw)) ||
        isStreamPartFromName;
      const isFinalStreamFrame =
        rawEntry.isFinalStreamFrame === true ||
        rawEntry.streamIsFinalFrame === true ||
        (sourceFileName !== null && !isStreamPartFromName);
      const previewCandidate =
        asNonEmptyString(rawEntry.previewUrl) ??
        asNonEmptyString(rawEntry.url) ??
        asNonEmptyString(rawEntry.resolvedUrl) ??
        asNonEmptyString(rawEntry.fileUrl) ??
        asNonEmptyString(rawEntry.mediaUrl) ??
        asNonEmptyString(rawEntry.outputUrl) ??
        asNonEmptyString(rawEntry.downloadUrl) ??
        asNonEmptyString(rawEntry.dataUri);
      const previewUrl =
        previewCandidate &&
        (isHttpUrl(previewCandidate) || isDataUri(previewCandidate))
          ? previewCandidate
          : null;
      if (previewUrl) {
        latestPreviewUrl = previewUrl;
      }
      const outputPath =
        asNonEmptyString(rawEntry.outputPath) ??
        asNonEmptyString(rawEntry.savedOutputPath) ??
        asNonEmptyString(rawEntry.path);
      const metadataId = asNonEmptyString(rawEntry.metadataId);
      const source = asNonEmptyString(rawEntry.source);
      if (!previewUrl && !sourceFileName && !outputPath && !isStreamPart && !isFinalStreamFrame) {
        continue;
      }
      streamFrames.push({
        sourceFileName,
        isStreamPart,
        streamPartIndex:
          typeof streamPartIndexRaw === "number" && Number.isFinite(streamPartIndexRaw)
            ? streamPartIndexRaw
            : null,
        isFinalStreamFrame,
        previewUrl,
        outputPath,
        metadataId,
        source,
      });
    }

    const latestFromFinalFrame =
      [...streamFrames]
        .reverse()
        .find((entry) => entry.isFinalStreamFrame && typeof entry.previewUrl === "string")
        ?.previewUrl ?? null;
    const latestFromAnyFrame =
      [...streamFrames]
        .reverse()
        .map((entry) => entry.previewUrl)
        .find((entry): entry is string => typeof entry === "string" && entry.length > 0) ?? null;
    const latestPreview =
      latestFromFinalFrame ??
      latestFromAnyFrame ??
      latestPreviewUrl ??
      (context
        ? asNonEmptyString(context.latestPreviewUrl) ??
          asNonEmptyString(context.previewUrl)
        : null);
    const streamFrameCount = streamFrames.length;
    const hasFinalStreamFrame = streamFrames.some((entry) => entry.isFinalStreamFrame);
    const latestStreamFrameIndex = streamFrameCount > 0 ? streamFrameCount - 1 : null;
    const revealBase = 1 - Math.exp(-streamFrameCount * 0.45);
    const streamRevealProgress = hasFinalStreamFrame
      ? 1
      : Math.min(0.92, Number(revealBase.toFixed(3)));
    return {
      contextId,
      contextStatus,
      latestPreviewUrl: latestPreview,
      streamFrameCount,
      latestStreamFrameIndex,
      hasFinalStreamFrame,
      streamRevealProgress,
      streamFrames,
      timedOut,
    };
  }

  private mediaGenerationProgressFingerprint(progress: MediaGenerationProgress): string {
    return [
      progress.contextId ?? "",
      progress.contextStatus ?? "",
      progress.latestPreviewUrl ?? "",
      progress.streamFrameCount,
      progress.latestStreamFrameIndex ?? "",
      progress.hasFinalStreamFrame ? "1" : "0",
      progress.streamRevealProgress,
      progress.timedOut ? "1" : "0",
    ].join("|");
  }

  private async runMediaGeneratorViaHttp(input: {
    prompt: string;
    generatedAssetType: GeneratedAssetType;
    requestDir: string;
    referenceFiles: string[];
    timeoutMs: number;
    stream: boolean;
    onProgress?: ((progress: MediaGenerationProgress) => Promise<void> | void) | undefined;
  }): Promise<{ payload: unknown; timedOut: boolean } | null> {
    const baseUrl = this.resolveMediaGeneratorBaseUrl();
    if (!baseUrl) return null;
    const useFileGenerator = input.generatedAssetType !== "image";
    const streamEnabled = !useFileGenerator && input.stream === true;
    const requiresFinalStreamFrame = streamEnabled;
    const requestBody: Record<string, unknown> = {
      prompt: input.prompt,
      command: useFileGenerator ? "generateFile" : "generateImage",
      mode: useFileGenerator ? "file" : "image",
      stream: streamEnabled,
      sync: false,
      count: 1,
      dir: input.requestDir,
    };
    if (input.referenceFiles.length > 0) {
      requestBody.files = input.referenceFiles;
    }
    if (useFileGenerator) {
      requestBody.type = input.generatedAssetType === "gif" ? "gif" : "file";
    }

    const hasFinalArtifactInList = (value: unknown): boolean => {
      const items = toUnknownArray(value);
      for (const item of items) {
        const direct =
          asNonEmptyString(item) ??
          (isRecord(item)
            ? asNonEmptyString(item.outputPath) ??
              asNonEmptyString(item.savedOutputPath) ??
              asNonEmptyString(item.path) ??
              asNonEmptyString(item.fileUrl) ??
              asNonEmptyString(item.mediaUrl) ??
              asNonEmptyString(item.outputUrl) ??
              asNonEmptyString(item.downloadUrl) ??
              asNonEmptyString(item.url)
            : null);
        if (!direct) continue;
        if (!STREAM_PART_ARTIFACT_PATTERN.test(direct)) return true;
      }
      return false;
    };

    const controller = new AbortController();
    const openTimeout = setTimeout(
      () => controller.abort(),
      Math.max(5_000, Math.min(MEDIA_GENERATOR_OPEN_TIMEOUT_MS, input.timeoutMs)),
    );
    let payload: unknown = null;
    try {
      const response = await fetch(`${baseUrl}/open`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      const text = await response.text();
      payload = text.length > 0 ? (JSON.parse(text) as unknown) : null;
      if (!response.ok) {
        await this.ctx.memory
          .recordWrite({
            type: "media_generation_service_http_failed",
            at: nowIso(),
            status: response.status,
            generatedAssetType: input.generatedAssetType,
          })
          .catch(() => undefined);
        return null;
      }
    } catch (error: unknown) {
      await this.ctx.memory
        .recordWrite({
          type: "media_generation_service_unavailable",
          at: nowIso(),
          generatedAssetType: input.generatedAssetType,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      return null;
    } finally {
      clearTimeout(openTimeout);
    }

    const emitProgress = async (
      progressPayload: unknown,
      timedOut: boolean,
      previousFingerprint: string | null,
    ): Promise<string | null> => {
      if (!input.onProgress) return previousFingerprint;
      const progress = this.parseMediaGenerationProgress(progressPayload, timedOut);
      const fingerprint = this.mediaGenerationProgressFingerprint(progress);
      if (fingerprint === previousFingerprint) return previousFingerprint;
      try {
        await input.onProgress(progress);
      } catch {
        // Ignore progress callback failures.
      }
      return fingerprint;
    };

    let latestPayload: unknown = payload;
    let latestFingerprint: string | null = await emitProgress(
      latestPayload,
      false,
      null,
    );
    const contextId = this.extractMediaGeneratorContextId(payload);
    if (!contextId) {
      return { payload: latestPayload, timedOut: false };
    }

    const deadlineMs = Date.now() + Math.max(5_000, input.timeoutMs);
    while (Date.now() <= deadlineMs) {
      try {
        const response = await fetch(
          `${baseUrl}/context?id=${encodeURIComponent(contextId)}`,
        );
        const text = await response.text();
        const contextPayload = text.length > 0 ? (JSON.parse(text) as unknown) : null;
        if (!response.ok) {
          await sleep(MEDIA_GENERATOR_POLL_MS);
          continue;
        }
        latestPayload = contextPayload;
        const progress = this.parseMediaGenerationProgress(contextPayload, false);
        latestFingerprint = await emitProgress(latestPayload, false, latestFingerprint);
        const context = this.extractMediaGeneratorContextRecord(contextPayload);
        const status = context ? asNonEmptyString(context.status) : null;
        const savedFiles = toUnknownArray(context?.savedFiles);
        const observedOutputFiles = toUnknownArray(context?.observedOutputFiles);
        const savedFilesCount = savedFiles.length;
        const observedOutputFilesCount = observedOutputFiles.length;
        const hasArtifacts = savedFilesCount > 0 || observedOutputFilesCount > 0;
        const hasFinalStreamFrame = progress.hasFinalStreamFrame;
        const hasAnyStreamFrames = progress.streamFrameCount > 0;
        const hasFinalStreamArtifact = progress.streamFrames.some(
          (frame) =>
            frame.isFinalStreamFrame &&
            typeof frame.outputPath === "string" &&
            frame.outputPath.trim().length > 0,
        );
        const hasFinalArtifactFile =
          hasFinalArtifactInList(savedFiles) || hasFinalArtifactInList(observedOutputFiles);
        const resolvedCandidate =
          this.extractMediaSourceFromParsedOutput(contextPayload, input.requestDir, {
            requireFinalStreamFrame: requiresFinalStreamFrame,
          }) ?? null;
        const generationReady = requiresFinalStreamFrame
          ? hasAnyStreamFrames
            ? hasFinalStreamFrame || hasFinalStreamArtifact
            : hasFinalStreamFrame ||
              hasFinalStreamArtifact ||
              hasFinalArtifactFile ||
              (this.isTerminalMediaGeneratorStatus(status) &&
                (hasFinalStreamFrame ||
                  hasFinalStreamArtifact ||
                  hasFinalArtifactFile))
          : useFileGenerator
            ? hasArtifacts || this.isTerminalMediaGeneratorStatus(status)
            : Boolean(resolvedCandidate);
        if (generationReady) {
          return { payload: latestPayload, timedOut: false };
        }
      } catch {
        // keep polling until timeout
      }
      await sleep(MEDIA_GENERATOR_POLL_MS);
    }

    latestFingerprint = await emitProgress(latestPayload, true, latestFingerprint);
    return {
      payload: latestPayload,
      timedOut: true,
    };
  }

  private async generateAndUploadMediaFromPrompt(
    prompt: string,
    opts?: {
      generatedAssetType?: GeneratedAssetType;
      mode?: string;
      referenceInputs?: string[];
      maxReferenceInputs?: number;
      keepOriginal?: boolean;
      onProgress?: ((progress: MediaGenerationProgress) => Promise<void> | void) | undefined;
    },
  ): Promise<ResolvedMediaUpload> {
    const sourcePrompt = prompt.trim();
    if (!sourcePrompt.length) {
      throw new Error("missing_prompt");
    }
    const generatedAssetType = opts?.generatedAssetType ?? "image";
    const mode = opts?.mode ?? "media_generation";
    const streamEnabled =
      generatedAssetType === "image" && /^chat_/iu.test(mode);
    const curatedPromptBase = await this.curateMediaPromptWithOpenClaw({
      sourcePrompt,
      generatedAssetType,
      mode,
    });
    const curatedPrompt =
      generatedAssetType === "gif"
        ? constrainGifPromptTo256(curatedPromptBase)
        : curatedPromptBase;
    const useFileGenerator = generatedAssetType !== "image";
    const template = useFileGenerator
      ? this.ctx.config.fileGenerateCmd
      : this.ctx.config.imageGenerateCmd;
    if (!template?.trim().length) {
      throw new Error(
        useFileGenerator
          ? "file_generator_unconfigured"
          : "image_generator_unconfigured",
      );
    }
    const requestDir = path.join(
      this.ctx.ipcPaths.generatedDir,
      `generate-${Date.now()}-${crypto.randomUUID()}`,
    );
    await ensureDir(requestDir);

    const promptFilePath = path.join(requestDir, "prompt.txt");
    const outputPath = path.join(
      requestDir,
      `output.${outputExtensionForGeneratedAssetType(generatedAssetType)}`,
    );
    await fs.writeFile(promptFilePath, `${curatedPrompt}\n`, "utf8").catch(() => undefined);
    const referenceInputs = Array.isArray(opts?.referenceInputs)
      ? opts.referenceInputs.filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.trim().length > 0,
        )
      : [];
    const referenceFiles = await this.materializeMediaReferenceFiles({
      requestDir,
      referenceInputs,
      ...(typeof opts?.maxReferenceInputs === "number"
        ? { maxReferenceInputs: opts.maxReferenceInputs }
        : {}),
    });

    const refs =
      process.platform === "win32"
        ? {
            prompt: "%MG_IMAGE_PROMPT%",
            dir: "%MG_IMAGE_PROMPT_DIR%",
            output: "%MG_IMAGE_OUTPUT%",
            promptFile: "%MG_IMAGE_PROMPT_FILE%",
            files: "%MG_IMAGE_FILES%",
            type: "%MG_IMAGE_TYPE%",
          }
        : {
            prompt: "$MG_IMAGE_PROMPT",
            dir: "$MG_IMAGE_PROMPT_DIR",
            output: "$MG_IMAGE_OUTPUT",
            promptFile: "$MG_IMAGE_PROMPT_FILE",
            files: "$MG_IMAGE_FILES",
            type: "$MG_IMAGE_TYPE",
          };
    let command = template
      .replaceAll("{prompt}", refs.prompt)
      .replaceAll("{dir}", refs.dir)
      .replaceAll("{output}", refs.output)
      .replaceAll("{prompt_file}", refs.promptFile)
      .replaceAll("{files}", refs.files)
      .replaceAll("{type}", refs.type)
      .trim();
    if (referenceFiles.length === 0) {
      command = stripEmptyFilesFlag(command, refs.files);
    }
    if (!command.includes(refs.prompt)) {
      command = `${command} "${refs.prompt}"`.trim();
    }

    await this.ctx.memory.recordWrite({
      type: "image_generation_invoked",
      at: nowIso(),
      provider: "command",
      mode,
      generatedAssetType,
      sourcePromptChars: sourcePrompt.length,
      promptChars: curatedPrompt.length,
      referenceInputCount: referenceInputs.length,
      referenceFileCount: referenceFiles.length,
      commandPreview: command.slice(0, 240),
    }).catch(() => undefined);

    const serviceRun = await this.runMediaGeneratorViaHttp({
      prompt: curatedPrompt,
      generatedAssetType,
      requestDir,
      referenceFiles,
      timeoutMs: this.ctx.config.imageGenerateTimeoutMs,
      stream: streamEnabled,
      onProgress: streamEnabled ? opts?.onProgress : undefined,
    });
    const execResult = serviceRun
      ? {
          ok: true,
          stdout: JSON.stringify(serviceRun.payload),
          stderr: "",
          error: null,
          timedOut: serviceRun.timedOut,
        }
      : await this.runShellCommand(command, {
          MG_IMAGE_PROMPT: curatedPrompt,
          MG_IMAGE_PROMPT_DIR: requestDir,
          MG_IMAGE_OUTPUT: outputPath,
          MG_IMAGE_PROMPT_FILE: promptFilePath,
          MG_IMAGE_FILES: referenceFiles.join(","),
          MG_IMAGE_TYPE: generatedAssetType,
        });
    if (!execResult.ok) {
      const reason = execResult.timedOut
        ? `image_generation_timeout_after_${this.ctx.config.imageGenerateTimeoutMs}ms`
        : execResult.error ?? execResult.stderr ?? "image_generation_failed";
      await this.ctx.memory.recordWrite({
        type: "image_generation_failed",
        at: nowIso(),
        provider: "command",
        reason: String(reason).slice(0, 600),
      }).catch(() => undefined);
      throw new Error(String(reason));
    }

    const resolvedSource = await this.resolveGeneratedMediaSourceWithRetry({
      requestDir,
      outputPath,
      stdout: execResult.stdout,
      maxWaitMs: Math.min(
        30_000,
        Math.max(3_000, Math.floor(this.ctx.config.imageGenerateTimeoutMs / 10)),
      ),
      requireFinalStreamFrame: generatedAssetType === "image" && streamEnabled,
    });
    if (!resolvedSource) {
      throw new Error("no_media_url");
    }
    try {
      return await this.uploadResolvedMediaSource(resolvedSource, {
        keepOriginal: opts?.keepOriginal === true,
      });
    } catch (error: unknown) {
      if (!isMissingFileError(error)) {
        throw error;
      }
      await this.ctx.memory
        .recordWrite({
          type: "image_generation_source_missing_retrying",
          at: nowIso(),
          mode,
          generatedAssetType,
          sourcePreview: truncateText(resolvedSource, 260),
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      const retrySource = await this.resolveGeneratedMediaSourceWithRetry({
        requestDir,
        outputPath,
        stdout: execResult.stdout,
        maxWaitMs: 12_000,
        requireFinalStreamFrame: generatedAssetType === "image" && streamEnabled,
      });
      if (!retrySource) {
        throw error;
      }
      return this.uploadResolvedMediaSource(retrySource, {
        keepOriginal: opts?.keepOriginal === true,
      });
    }
  }

  private async resolveGeneratedMediaSourceWithRetry(input: {
    requestDir: string;
    outputPath: string;
    stdout: string;
    maxWaitMs: number;
    requireFinalStreamFrame?: boolean;
  }): Promise<string | null> {
    const deadlineMs = Date.now() + Math.max(0, Math.floor(input.maxWaitMs));
    let lastCandidate: string | null = null;
    do {
      const candidate = await this.resolveGeneratedMediaSource({
        requestDir: input.requestDir,
        outputPath: input.outputPath,
        stdout: input.stdout,
        requireFinalStreamFrame: input.requireFinalStreamFrame === true,
      });
      if (candidate) {
        if (isHttpUrl(candidate) || isDataUri(candidate)) {
          return candidate;
        }
        const absolute = path.isAbsolute(candidate)
          ? candidate
          : path.resolve(input.requestDir, candidate);
        const exists = await fs
          .access(absolute)
          .then(() => true)
          .catch(() => false);
        if (exists) {
          return absolute;
        }
        lastCandidate = absolute;
      }
      if (Date.now() >= deadlineMs) {
        return lastCandidate;
      }
      await sleep(300);
    } while (true);
  }

  private async resolveGeneratedMediaSource(input: {
    requestDir: string;
    outputPath: string;
    stdout: string;
    requireFinalStreamFrame: boolean;
  }): Promise<string | null> {
    const outputExists = await fs
      .access(input.outputPath)
      .then(() => true)
      .catch(() => false);
    if (outputExists) return input.outputPath;

    const parsed = parseJsonFromMixedText(input.stdout);
    const fromParsed = this.extractMediaSourceFromParsedOutput(
      parsed,
      input.requestDir,
      {
        requireFinalStreamFrame: input.requireFinalStreamFrame,
      },
    );
    if (fromParsed) return fromParsed;

    const discovered = await this.findFirstMediaFile(input.requestDir, 3);
    if (discovered) return discovered;
    return null;
  }

  private isFinalStreamFrameEntry(entry: Record<string, unknown>): boolean {
    const sourceFileName =
      asNonEmptyString(entry.sourceFileName) ??
      asNonEmptyString(entry.file_name);
    const isStreamPartFromName =
      sourceFileName !== null &&
      STREAM_PART_ARTIFACT_PATTERN.test(sourceFileName);
    return (
      entry.isFinalStreamFrame === true ||
      entry.streamIsFinalFrame === true ||
      (sourceFileName !== null && !isStreamPartFromName)
    );
  }

  private summarizeStreamEventsFinality(value: unknown): {
    hasEvents: boolean;
    hasFinalStreamFrame: boolean;
  } {
    const events = toUnknownArray(value);
    if (events.length === 0) {
      return {
        hasEvents: false,
        hasFinalStreamFrame: false,
      };
    }
    let hasFinalStreamFrame = false;
    for (const rawEntry of events) {
      if (!isRecord(rawEntry)) continue;
      if (this.isFinalStreamFrameEntry(rawEntry)) {
        hasFinalStreamFrame = true;
        break;
      }
    }
    return {
      hasEvents: true,
      hasFinalStreamFrame,
    };
  }

  private extractMediaSourceFromParsedOutput(
    parsed: unknown,
    requestDir: string,
    options?: {
      requireFinalStreamFrame?: boolean;
    },
  ): string | null {
    const requireFinalStreamFrame = options?.requireFinalStreamFrame === true;
    const resolveCandidate = (value: unknown): string | null => {
      const candidate = asNonEmptyString(value);
      if (!candidate) return null;
      if (STREAM_PART_ARTIFACT_PATTERN.test(candidate)) return null;
      if (isHttpUrl(candidate) || isDataUri(candidate)) return candidate;
      const absolute = path.isAbsolute(candidate)
        ? candidate
        : path.resolve(requestDir, candidate);
      if (STREAM_PART_ARTIFACT_PATTERN.test(absolute)) return null;
      return absolute;
    };

    const resolveFromStreamEvents = (
      value: unknown,
    ): {
      resolved: string | null;
      hasEvents: boolean;
      hasFinalStreamFrame: boolean;
    } => {
      const events = toUnknownArray(value);
      if (events.length === 0) {
        return {
          resolved: null,
          hasEvents: false,
          hasFinalStreamFrame: false,
        };
      }
      const resolveFromEntry = (
        entry: Record<string, unknown>,
      ): {
        resolved: string | null;
        finalFramePreview: string | null;
        isFinalStreamFrame: boolean;
      } => {
        const sourceFileName =
          asNonEmptyString(entry.sourceFileName) ??
          asNonEmptyString(entry.file_name);
        const isStreamPartFromName =
          sourceFileName !== null &&
          STREAM_PART_ARTIFACT_PATTERN.test(sourceFileName);
        const isFinalStreamFrame =
          entry.isFinalStreamFrame === true ||
          entry.streamIsFinalFrame === true ||
          (sourceFileName !== null && !isStreamPartFromName);
        const artifactCandidates: unknown[] = [
          entry.outputPath,
          entry.savedOutputPath,
          entry.path,
          entry.lastOutputPath,
          entry.lastOutputFile,
          entry.fileUrl,
          entry.mediaUrl,
          entry.outputUrl,
          entry.downloadUrl,
        ];
        for (const candidate of artifactCandidates) {
          const resolved = resolveCandidate(candidate);
          if (resolved) {
            return { resolved, finalFramePreview: null, isFinalStreamFrame };
          }
        }
        const finalFramePreviewCandidates: unknown[] =
          isFinalStreamFrame
            ? [
                entry.previewUrl,
                entry.resolvedUrl,
                entry.url,
                entry.dataUri,
              ]
            : [];
        for (const candidate of finalFramePreviewCandidates) {
          const resolved = resolveCandidate(candidate);
          if (resolved) {
            return {
              resolved: null,
              finalFramePreview: resolved,
              isFinalStreamFrame,
            };
          }
        }
        return { resolved: null, finalFramePreview: null, isFinalStreamFrame };
      };
      let hasFinalStreamFrame = false;
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const entry = events[i];
        if (!isRecord(entry)) continue;
        const resolved = resolveFromEntry(entry);
        if (resolved.isFinalStreamFrame) {
          hasFinalStreamFrame = true;
        }
        if (resolved.isFinalStreamFrame && resolved.resolved) {
          return {
            resolved: resolved.resolved,
            hasEvents: true,
            hasFinalStreamFrame,
          };
        }
        if (resolved.isFinalStreamFrame && resolved.finalFramePreview) {
          return {
            resolved: resolved.finalFramePreview,
            hasEvents: true,
            hasFinalStreamFrame,
          };
        }
      }
      if (requireFinalStreamFrame) {
        return {
          resolved: null,
          hasEvents: true,
          hasFinalStreamFrame,
        };
      }
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const entry = events[i];
        if (!isRecord(entry)) continue;
        const resolved = resolveFromEntry(entry);
        if (resolved.isFinalStreamFrame) {
          hasFinalStreamFrame = true;
        }
        if (resolved.resolved) {
          if (!resolved.isFinalStreamFrame && isHttpUrl(resolved.resolved)) {
            continue;
          }
          return {
            resolved: resolved.resolved,
            hasEvents: true,
            hasFinalStreamFrame,
          };
        }
      }
      return {
        resolved: null,
        hasEvents: true,
        hasFinalStreamFrame,
      };
    };

    if (!isRecord(parsed)) return null;
    const streamResolved = resolveFromStreamEvents(parsed.streamEvents);
    if (streamResolved.resolved) return streamResolved.resolved;
    const urlKeys = [
      "lastOutputPath",
      "latestOutputPath",
      "lastOutputFile",
      "latestOutputFile",
      "finalOutputPath",
      "finalOutputFile",
      "outputPath",
      "savedOutputPath",
      "savedPath",
      "url",
      "mediaUrl",
      "outputUrl",
      "fileUrl",
      "imageUrl",
    ];
    const scanArtifactArray = (value: unknown): string | null => {
      const items = toUnknownArray(value);
      if (items.length === 0) return null;
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const entry = items[i];
        const direct = resolveCandidate(entry);
        if (direct) return direct;
        if (!isRecord(entry)) continue;
        const resolved = resolveCandidate(
          asNonEmptyString(entry.outputPath) ??
            asNonEmptyString(entry.savedOutputPath) ??
            asNonEmptyString(entry.path) ??
            asNonEmptyString(entry.lastOutputPath) ??
            asNonEmptyString(entry.lastOutputFile) ??
            asNonEmptyString(entry.latestOutputPath) ??
            asNonEmptyString(entry.latestOutputFile) ??
            asNonEmptyString(entry.fileUrl) ??
            asNonEmptyString(entry.mediaUrl) ??
            asNonEmptyString(entry.outputUrl) ??
            asNonEmptyString(entry.downloadUrl) ??
            asNonEmptyString(entry.url),
        );
        if (resolved) return resolved;
      }
      return null;
    };
    const arrayKeys = [
      "savedFiles",
      "observedOutputFiles",
      "files",
      "outputFiles",
    ];
    for (const key of arrayKeys) {
      const resolved = scanArtifactArray(parsed[key]);
      if (resolved) return resolved;
    }
    for (const key of urlKeys) {
      const resolved = resolveCandidate(parsed[key]);
      if (resolved) return resolved;
    }

    const context = isRecord(parsed.context) ? parsed.context : null;
    if (context) {
      const contextStreamResolved = resolveFromStreamEvents(context.streamEvents);
      if (contextStreamResolved.resolved) return contextStreamResolved.resolved;
      for (const key of arrayKeys) {
        const resolved = scanArtifactArray(context[key]);
        if (resolved) return resolved;
      }
      const keepAlive = isRecord(context.keepAlive) ? context.keepAlive : null;
      if (keepAlive) {
        for (const key of urlKeys) {
          const resolved = resolveCandidate(keepAlive[key]);
          if (resolved) return resolved;
        }
      }
      for (const key of urlKeys) {
        const resolved = resolveCandidate(context[key]);
        if (resolved) return resolved;
      }
    }

    if (Array.isArray(parsed.runs)) {
      for (const run of parsed.runs) {
        if (!isRecord(run)) continue;
        const runStreamResolved = resolveFromStreamEvents(run.streamEvents);
        if (runStreamResolved.resolved) return runStreamResolved.resolved;
        for (const key of arrayKeys) {
          const resolved = scanArtifactArray(run[key]);
          if (resolved) return resolved;
        }
        for (const key of urlKeys) {
          const resolved = resolveCandidate(run[key]);
          if (resolved) return resolved;
        }
        const runContext = isRecord(run.context) ? run.context : null;
        if (runContext) {
          const runContextStreamResolved = resolveFromStreamEvents(runContext.streamEvents);
          if (runContextStreamResolved.resolved) return runContextStreamResolved.resolved;
          for (const key of arrayKeys) {
            const resolved = scanArtifactArray(runContext[key]);
            if (resolved) return resolved;
          }
          const runKeepAlive = isRecord(runContext.keepAlive)
            ? runContext.keepAlive
            : null;
          if (runKeepAlive) {
            for (const key of urlKeys) {
              const resolved = resolveCandidate(runKeepAlive[key]);
              if (resolved) return resolved;
            }
          }
          for (const key of urlKeys) {
            const resolved = resolveCandidate(runContext[key]);
            if (resolved) return resolved;
          }
        }
      }
    }
    return null;
  }

  private async findFirstMediaFile(dirPath: string, maxDepth: number): Promise<string | null> {
    const walk = async (currentPath: string, depth: number): Promise<string | null> => {
      if (depth < 0) return null;
      const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => []);
      const fileEntries = entries.filter(
        (entry) => entry.isFile() && MEDIA_FILE_RE.test(entry.name),
      );
      const stableCandidates = fileEntries.filter(
        (entry) => !STREAM_PART_ARTIFACT_PATTERN.test(entry.name),
      );
      const pickNewestPath = async (candidates: typeof fileEntries): Promise<string | null> => {
        if (candidates.length === 0) return null;
        const withMtime = await Promise.all(
          candidates.map(async (entry) => {
            const filePath = path.join(currentPath, entry.name);
            const stat = await fs.stat(filePath).catch(() => null);
            return {
              filePath,
              mtimeMs:
                stat && Number.isFinite(stat.mtimeMs)
                  ? stat.mtimeMs
                  : Number.NEGATIVE_INFINITY,
            };
          }),
        );
        withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
        return withMtime[0]?.filePath ?? null;
      };
      const stablePath = await pickNewestPath(stableCandidates);
      if (stablePath) return stablePath;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const nested = await walk(path.join(currentPath, entry.name), depth - 1);
        if (nested) return nested;
      }
      return null;
    };
    return walk(dirPath, maxDepth);
  }

  private async runShellCommand(
    command: string,
    extraEnv: Record<string, string>,
  ): Promise<{
    ok: boolean;
    stdout: string;
    stderr: string;
    error: string | null;
    timedOut: boolean;
  }> {
    return await new Promise((resolve) => {
      const child = spawn(command, {
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ...extraEnv,
        },
      });
      const stdoutParts: string[] = [];
      const stderrParts: string[] = [];
      let timedOut = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }, 5_000);
      }, this.ctx.config.imageGenerateTimeoutMs);

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdoutParts.push(String(chunk));
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderrParts.push(String(chunk));
      });
      child.on("error", (error: unknown) => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        const message = error instanceof Error ? error.message : String(error);
        resolve({
          ok: false,
          stdout: stdoutParts.join(""),
          stderr: stderrParts.join(""),
          error: message,
          timedOut,
        });
      });
      child.on("close", (code: number | null) => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        resolve({
          ok: code === 0 && !timedOut,
          stdout: stdoutParts.join(""),
          stderr: stderrParts.join(""),
          error: null,
          timedOut,
        });
      });
    });
  }

  private buildNonWriteChatCompletion(input: {
    command: Command;
    outcome: CommandOutcome;
  }): { body: string; metadata: Record<string, unknown> } | null {
    const data = isRecord(input.outcome.data) ? input.outcome.data : null;
    const explicitCompletion = data && isRecord(data.chatCompletion)
      ? data.chatCompletion
      : null;
    const explicitBody = asNonEmptyString(explicitCompletion?.body);
    if (explicitBody) {
      const explicitMetadata = isRecord(explicitCompletion?.metadata)
        ? explicitCompletion.metadata
        : null;
      return {
        body: explicitBody,
        metadata: {
          automated: true,
          sourceContext: "CHAT",
          ...(explicitMetadata ?? {}),
        },
      };
    }

    const payload = isRecord(input.command.payload) ? input.command.payload : null;
    if (!payload) return null;
    const commandName = this.resolveChatCommandName(payload) ?? input.command.kind;
    const errorMessage = input.outcome.error?.message?.trim() ?? "";
    if (!input.outcome.ok) {
      return {
        body: errorMessage.length > 0
          ? `I couldn't complete that ${commandName} request: ${errorMessage}`
          : `I couldn't complete that ${commandName} request.`,
        metadata: {
          automated: true,
          sourceContext: "CHAT",
          actionPreview: {
            type: "command",
            status: "failed",
            title: "Command failed",
            summary: commandName,
            ...(errorMessage.length > 0 ? { error: truncateText(errorMessage, 240) } : {}),
          },
        },
      };
    }

    const executed = Array.isArray(data?.executed) ? data.executed : [];
    const executedCount = executed.length;
    const summary =
      executedCount > 0
        ? `Done. Executed ${executedCount} action${executedCount === 1 ? "" : "s"}.`
        : "Done.";
    return {
      body: summary,
      metadata: {
        automated: true,
        sourceContext: "CHAT",
        actionPreview: {
          type: "command",
          status: "success",
          title: "Command completed",
          summary: commandName,
          executedCount,
        },
      },
    };
  }

  private async sendNonWriteChatCompletion(input: {
    command: Command;
    body: string;
    metadata: Record<string, unknown>;
  }): Promise<boolean> {
    if (!this.ctx.callAgentChatBridge) return false;
    const chatTarget = resolveChatTargetFromPayload(input.command.payload);
    if (!chatTarget) return false;
    const route = chatTarget.conversationId
      ? { conversationId: chatTarget.conversationId }
      : { channelId: chatTarget.channelId };
    try {
      await this.ctx.callAgentChatBridge({
        action: "send_message",
        clientMessageId: `runtime_chat_result_${Date.now().toString(36)}_${crypto
          .randomUUID()
          .replaceAll("-", "")
          .slice(0, 10)}`,
        ...route,
        body: clampPublishText(input.body, 1200),
        format: "markdown",
        metadata: input.metadata,
      });
      await this.ctx.memory
        .recordWrite({
          type: "chat_command_result_sent",
          at: nowIso(),
          commandId: input.command.id,
          kind: input.command.kind,
          ok: true,
          targetConversationId: chatTarget.conversationId ?? null,
          targetChannelId: chatTarget.channelId ?? null,
        })
        .catch(() => undefined);
      return true;
    } catch (error: unknown) {
      await this.ctx.memory
        .recordWrite({
          type: "chat_command_result_send_failed",
          at: nowIso(),
          commandId: input.command.id,
          kind: input.command.kind,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      return false;
    }
  }

  private async emitChatOutcome(command: Command, outcome: CommandOutcome): Promise<boolean> {
    const payload = isRecord(command.payload) ? command.payload : null;
    const chatTarget = resolveChatTargetFromPayload(payload ?? null);
    if (!chatTarget) {
      const sourceContext = asNonEmptyString(payload?.sourceContext)?.toLowerCase() ?? "";
      if (sourceContext === "chat" || isRecord(payload?.chatContext)) {
        await this.recordCommandLifecycleCheckpoint({
          command,
          stage: "chat_delivery",
          status: "failed",
          message: "chat_target_missing",
          metadata: {
            mode: "terminal_delivery",
          },
        });
      }
      return false;
    }
    const outcomeData = isRecord(outcome.data) ? outcome.data : null;
    const chatDeliveryHandled = outcomeData?.chatDeliveryHandled === true;

    if (
      (payload?.chatLiteralGenerate === true || payload?.requireDraftOnly === true) &&
      chatDeliveryHandled
    ) {
      if (outcomeData?.chatDeliveryCheckpointRecorded === true) {
        return true;
      }
      await this.recordCommandLifecycleCheckpoint({
        command,
        stage: "chat_delivery",
        status: "ok",
        metadata: {
          mode: payload.chatLiteralGenerate === true ? "chat_literal_generate_preview" : "draft_preview",
          outcomeOk: outcome.ok,
        },
      });
      return true;
    }

    const kind = command.kind.trim().toLowerCase();
    if (kind.startsWith("write.")) {
      let fallbackUsed = false;
      let delivered = await sendChatResultMessageFromOutcome({
        command,
        outcome,
        chatTarget,
        deps: {
          callAgentChatBridge: this.ctx.callAgentChatBridge,
          memory: this.ctx.memory,
        },
      });
      if (!delivered) {
        const fallbackCompletion = this.buildNonWriteChatCompletion({ command, outcome });
        if (fallbackCompletion) {
          fallbackUsed = true;
          delivered = await this.sendNonWriteChatCompletion({
            command,
            body: fallbackCompletion.body,
            metadata: fallbackCompletion.metadata,
          });
        }
      }
      await this.recordCommandLifecycleCheckpoint({
        command,
        stage: "chat_delivery",
        status: delivered ? "ok" : "failed",
        message: delivered ? null : "chat_result_send_failed",
        metadata: {
          mode: "write_outcome",
          usedFallback: fallbackUsed,
        },
      });
      return delivered;
    }

    const completion = this.buildNonWriteChatCompletion({ command, outcome });
    if (!completion) {
      await this.recordCommandLifecycleCheckpoint({
        command,
        stage: "chat_delivery",
        status: "failed",
        message: "chat_completion_unavailable",
        metadata: {
          mode: "non_write_terminal",
        },
      });
      return false;
    }
    const delivered = await this.sendNonWriteChatCompletion({
      command,
      body: completion.body,
      metadata: completion.metadata,
    });
    await this.recordCommandLifecycleCheckpoint({
      command,
      stage: "chat_delivery",
      status: delivered ? "ok" : "failed",
      message: delivered ? null : "chat_result_send_failed",
      metadata: {
        mode: "non_write_terminal",
      },
    });
    return delivered;
  }

  private buildDraftPreviewPayload(drafts: GeneratedDraft[]): DraftPreviewPayload | null {
    const previewParts: string[] = [];
    let firstPostKind: "post" | "thread" = "post";
    let mode: "thread" | "carousel" = "thread";
    let slideCount = 1;

    const resolveMediaUrlFromDraft = (draftPayload: Record<string, unknown>): string | null => {
      const direct = asNonEmptyString(draftPayload.mediaUrl);
      if (direct) return direct;
      const mediaItems = Array.isArray(draftPayload.mediaItems) ? draftPayload.mediaItems : [];
      for (const item of mediaItems) {
        if (!isRecord(item)) continue;
        const itemUrl = asNonEmptyString(item.mediaUrl) ?? asNonEmptyString(item.url);
        if (itemUrl) return itemUrl;
      }
      return null;
    };

    const resolveMediaItemCount = (draftPayload: Record<string, unknown>): number => {
      const mediaItems = Array.isArray(draftPayload.mediaItems) ? draftPayload.mediaItems : [];
      return mediaItems.filter((entry) => isRecord(entry)).length;
    };

    const addPreviewPart = (value: string | null): void => {
      if (!value) return;
      const normalized = stripEmDashCharacters(value).trim();
      if (!normalized.length) return;
      previewParts.push(normalized);
    };

    for (const draft of drafts.slice(0, 5)) {
      const action = draft.action.trim().toLowerCase();
      if (action === "post") {
        const postType = asNonEmptyString(draft.payload.postType)?.toLowerCase();
        const textBody =
          asNonEmptyString(draft.payload.textBody) ??
          asNonEmptyString(draft.payload.body) ??
          asNonEmptyString(draft.payload.text);
        const caption =
          asNonEmptyString(draft.payload.caption) ??
          asNonEmptyString(draft.payload.title);
        const imagePrompt =
          asNonEmptyString(draft.payload.imagePrompt) ??
          asNonEmptyString(draft.payload.mediaPrompt) ??
          asNonEmptyString(draft.payload.prompt);
        const mediaUrl = resolveMediaUrlFromDraft(draft.payload);
        const mediaItemCount = resolveMediaItemCount(draft.payload);
        if (postType === "text" && textBody) {
          addPreviewPart(textBody);
          firstPostKind = "post";
          continue;
        }

        if (textBody || caption || imagePrompt || mediaUrl) {
          const composed = [textBody, caption, imagePrompt ? `Image prompt: ${imagePrompt}` : null]
            .filter((entry): entry is string => Boolean(entry))
            .join("\n");
          addPreviewPart(
            composed.length > 0
              ? composed
              : mediaUrl
                ? "Post draft with attached media is ready for review."
                : "Post draft is ready for review.",
          );
          firstPostKind = "post";
          if (postType === "media" || imagePrompt || mediaUrl || mediaItemCount > 0) {
            mode = "carousel";
            slideCount = Math.max(slideCount, mediaItemCount > 1 ? mediaItemCount : 2);
          }
          continue;
        }
      }
      if (action === "story") {
        const caption = asNonEmptyString(draft.payload.caption);
        const imagePrompt =
          asNonEmptyString(draft.payload.imagePrompt) ??
          asNonEmptyString(draft.payload.mediaPrompt) ??
          asNonEmptyString(draft.payload.prompt);
        const mediaUrl = resolveMediaUrlFromDraft(draft.payload);
        const composed = [caption, imagePrompt ? `Image prompt: ${imagePrompt}` : null]
          .filter((entry): entry is string => Boolean(entry))
          .join("\n");
        addPreviewPart(
          composed.length > 0
            ? composed
            : mediaUrl
              ? "Story draft with media is ready for review."
              : "Story draft is ready for review.",
        );
        firstPostKind = "post";
        if (imagePrompt || mediaUrl) {
          mode = "carousel";
          slideCount = Math.max(slideCount, 2);
        }
        continue;
      }
      if (action === "comment") {
        const body =
          asNonEmptyString(draft.payload.body) ??
          asNonEmptyString(draft.payload.text) ??
          asNonEmptyString(draft.payload.caption);
        addPreviewPart(body ?? "Comment draft is ready for review.");
        firstPostKind = "thread";
        continue;
      }
      if (action === "like") {
        const reason = asNonEmptyString(draft.payload.reason);
        addPreviewPart(reason ? `Like draft: ${reason}` : "Like action draft is ready.");
      }
    }

    if (previewParts.length === 0) {
      const actionSummary = drafts
        .slice(0, 3)
        .map((entry) => entry.action.trim().toLowerCase())
        .filter((entry) => entry.length > 0)
        .join(", ");
      if (!actionSummary.length) return null;
      previewParts.push(`Draft ready for review (${actionSummary}).`);
    }
    const draftPreviewText = previewParts.join("\n\n").slice(0, 2500);
    const summary = clampPublishText(draftPreviewText, 220);
    return {
      body: `Draft ready for review:\n\n${draftPreviewText}`,
      summary,
      draftPreviewText,
      draftPostKind: firstPostKind,
      draftMode: mode,
      draftSlideCount: slideCount,
    };
  }

  private async sendDraftPreviewMessage(input: {
    payload: Record<string, unknown>;
    preview: DraftPreviewPayload;
  }): Promise<boolean> {
    if (!this.ctx.callAgentChatBridge) return false;
    const chatTarget = resolveChatTargetFromPayload(input.payload);
    if (!chatTarget) return false;
    try {
      await this.ctx.callAgentChatBridge({
        action: "send_message",
        clientMessageId: `runtime_draft_result_${Date.now().toString(36)}_${crypto
          .randomUUID()
          .replaceAll("-", "")
          .slice(0, 10)}`,
        ...(chatTarget.conversationId
          ? { conversationId: chatTarget.conversationId }
          : { channelId: chatTarget.channelId }),
        body: input.preview.body,
        format: "markdown",
        metadata: {
          automated: true,
          sourceContext: "CHAT",
          draftPreviewText: input.preview.draftPreviewText,
          draftPostKind: input.preview.draftPostKind,
          draftMode: input.preview.draftMode,
          draftSlideCount: input.preview.draftSlideCount,
          actionPreview: {
            type: "draft",
            status: "success",
            title: "Draft ready",
            summary: input.preview.summary,
          },
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  private async sendDraftFailureMessage(input: {
    payload: Record<string, unknown>;
    message: string;
  }): Promise<boolean> {
    if (!this.ctx.callAgentChatBridge) return false;
    const chatTarget = resolveChatTargetFromPayload(input.payload);
    if (!chatTarget) return false;
    try {
      await this.ctx.callAgentChatBridge({
        action: "send_message",
        clientMessageId: `runtime_draft_error_${Date.now().toString(36)}_${crypto
          .randomUUID()
          .replaceAll("-", "")
          .slice(0, 10)}`,
        ...(chatTarget.conversationId
          ? { conversationId: chatTarget.conversationId }
          : { channelId: chatTarget.channelId }),
        body: input.message,
        format: "markdown",
        metadata: {
          automated: true,
          sourceContext: "CHAT",
          actionPreview: {
            type: "draft",
            status: "failed",
            title: "Draft failed",
            error: input.message,
          },
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  private async updateAvatar(
    input: Record<string, unknown> & { target: string; imageUrl: string },
  ): Promise<unknown> {
    return await this.agent().updateAvatar.mutate(input);
  }

  private async updateBanner(
    input: Record<string, unknown> & { target: string; bannerUrl: string },
  ): Promise<unknown> {
    return await this.agent().updateBanner.mutate(input);
  }

  private successOutcome(command: Command, data: unknown): CommandOutcome {
    return {
      at: nowIso(),
      commandId: command.id,
      kind: command.kind,
      grantId: command.grantId,
      ok: true,
      data,
    };
  }

  private failedOutcome(
    command: Command,
    message: string,
    code?: string,
  ): CommandOutcome {
    return {
      at: nowIso(),
      commandId: command.id,
      kind: command.kind,
      grantId: command.grantId,
      ok: false,
      error: {
        message,
        ...(code ? { code } : {}),
      },
    };
  }

  private async finalizeCommandOutcome(input: {
    command: Command;
    outcome: CommandOutcome;
  }): Promise<void> {
    await this.writeOutcome(input.outcome);
    await this.emitChatOutcome(input.command, input.outcome).catch(async (error: unknown) => {
      await this.recordCommandLifecycleCheckpoint({
        command: input.command,
        stage: "chat_delivery",
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
        metadata: {
          mode: "emit_exception",
        },
      });
    });
    await this.ackDirectiveForOutcome(input.command, input.outcome).catch(() => undefined);
  }

  private async ackDirectiveForOutcome(
    command: Command,
    outcome: CommandOutcome,
  ): Promise<void> {
    const directiveId = command.sourceDirectiveId ?? command.id;
    if (!directiveId?.trim().length) return;
    const executionDigest = buildExecutionDigest(
      command,
      outcome.ok,
      outcome.ok ? null : outcome.error?.message ?? "failed",
    );
    try {
      await this.agent().ackDirective.mutate({
        directiveId,
        status: outcome.ok ? "executed" : "failed",
        kind: command.kind,
        ...(outcome.ok ? {} : { error: outcome.error?.message ?? "Directive failed." }),
        ...(command.actionNonce ? { actionNonce: command.actionNonce } : {}),
        executionDigest,
      });
      await this.recordCommandLifecycleCheckpoint({
        command,
        stage: "ack",
        status: "ok",
        metadata: {
          directiveId,
          outcomeOk: outcome.ok,
        },
      });
    } catch (error: unknown) {
      await this.recordCommandLifecycleCheckpoint({
        command,
        stage: "ack",
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
        metadata: {
          directiveId,
          outcomeOk: outcome.ok,
        },
      });
      throw error;
    }
  }

  private async writeOutcome(outcome: CommandOutcome): Promise<void> {
    await appendJsonLine(this.ctx.ipcPaths.resultsPath, outcome).catch(() => undefined);
  }

  private async markQueueItemNotReadyByInbox(
    inboxFile: string,
    reason: string,
  ): Promise<void> {
    const normalizedInboxFile = inboxFile.trim();
    if (!normalizedInboxFile.length) return;
    const normalizedReason = reason.trim().length > 0 ? reason.trim() : "not_ready";

    this.ctx.queue.queueStateMutation = this.ctx.queue.queueStateMutation
      .then(async () => {
        const raw = await readJsonFile(this.ctx.ipcPaths.queueStatePath);
        const state = normalizeQueueState(raw);
        const updatedItems = state.items.map((item) => {
          if (item.inboxFile !== normalizedInboxFile) return item;
          return {
            ...item,
            lastError: normalizedReason,
          };
        });
        const next: QueueState = {
          ...state,
          updatedAt: nowIso(),
          items: updatedItems,
        };
        await writeJsonFile(this.ctx.ipcPaths.queueStatePath, next);
      })
      .catch(() => undefined);

    await this.ctx.queue.queueStateMutation;
  }

  private resolveEngagementActionForCommand(command: Command): "comment" | "like" | "repost" | null {
    const kind = command.kind.trim().toLowerCase();
    if (kind === "write.commentpost" || kind === "write.comment") return "comment";
    if (kind === "write.votepost" || kind === "write.like") return "like";
    if (kind === "write.repostpost" || kind === "write.repost") return "repost";
    if (kind === "brain.generateandqueue" || kind === "brain.plan") {
      const payload = isRecord(command.payload) ? command.payload : null;
      if (!payload) return null;
      const enforced = this.resolveEnforcedDraftAction(payload);
      return enforced ?? null;
    }
    return null;
  }

  private async primeCommandContextForRequeue(
    command: Command,
    reason: string,
  ): Promise<void> {
    const action = this.resolveEngagementActionForCommand(command);
    if (!action) return;
    if (!this.ctx.callAgentChatBridge) return;
    const loweredReason = reason.toLowerCase();
    const shouldPrime =
      loweredReason.includes("no_target") ||
      loweredReason.includes("waiting_for_context") ||
      loweredReason.includes("missing_target_post_context");
    if (!shouldPrime) return;

    const payload = isRecord(command.payload) ? command.payload : {};
    const hints = this.extractEngagementLookupHints(payload);
    const bridgeRequests: Record<string, unknown>[] = [
      { action: "browse_notifications", unreadOnly: true, limit: 24 },
      { action: "browse_notifications", unreadOnly: false, limit: 24 },
      { action: "browse_unanswered_mentions", limit: 24, sinceHours: 24 * 14 },
      { action: "browse_recent_actions", limit: 24 },
      { action: "browse_top_engagers", limit: 12, windowHours: 24 * 14 },
      { action: "browse_home_feed", limit: 24 },
      { action: "browse_trending", limit: 24 },
      { action: "browse_posts", limit: 24 },
    ];
    if (hints.rawQuery.trim().length > 2) {
      bridgeRequests.push({
        action: "search_global",
        query: truncateText(hints.rawQuery, 220),
        limit: 24,
      });
    }
    if (hints.postId) {
      bridgeRequests.unshift({
        action: "find_post",
        postId: hints.postId,
      });
    }

    const discovered: EngagementTargetCandidate[] = [];
    const seenTargets = new Set<string>();
    for (const request of bridgeRequests) {
      let result: { value: unknown; cacheHit: boolean } | null = null;
      try {
        result = await this.callAgentBridgeLookupCached(request, 5_000);
      } catch {
        result = null;
      }
      if (!result) continue;
      for (const row of this.collectBridgeRecordItems(result.value)) {
        const parsedDirect = this.extractEngagementTargetCandidateFromRecord(
          row,
          "requeue_prime",
        );
        const entityType =
          asNonEmptyString(row.entityType)?.toLowerCase() ??
          asNonEmptyString(row.targetType)?.toLowerCase() ??
          null;
        const entityId =
          asPositiveInt(row.entityId) ??
          asPositiveInt(row.targetId) ??
          null;
        const parsedFallback =
          parsedDirect ??
          (() => {
            const postId =
              asPositiveInt(row.postId) ??
              asPositiveInt(row.targetPostId) ??
              (entityType === "post" ? entityId : null);
            if (!postId) return null;
            const commentId =
              asPositiveInt(row.commentId) ??
              asPositiveInt(row.targetCommentId) ??
              asPositiveInt(row.parentId) ??
              (entityType === "comment" ? entityId : null);
            return {
              postId,
              commentId: action === "comment" ? commentId : null,
              authorId: null,
              source: "requeue_prime",
            } satisfies EngagementTargetCandidate;
          })();
        const parsed = parsedFallback;
        if (!parsed) continue;
        const key = `${parsed.postId}:${parsed.commentId ?? 0}`;
        if (seenTargets.has(key)) continue;
        seenTargets.add(key);
        discovered.push(parsed);
        if (discovered.length >= 24) break;
      }
      if (discovered.length >= 24) break;
    }

    if (!discovered.length) {
      await this.ctx.memory
        .recordWrite({
          type: "engagement_context_prime_empty",
          at: nowIso(),
          commandId: command.id,
          action,
          reason,
          query: hints.rawQuery,
        })
        .catch(() => undefined);
      return;
    }

    for (const candidate of discovered.slice(0, 12)) {
      await this.ctx.memory
        .recordWrite({
          type: "engagement_context_seed",
          at: nowIso(),
          commandId: command.id,
          action,
          postId: candidate.postId,
          commentId: candidate.commentId,
          authorId: candidate.authorId,
          source: candidate.source,
          query: hints.rawQuery,
        })
        .catch(() => undefined);
    }

    const cacheSeed = discovered[0] ?? null;
    if (cacheSeed) {
      const cacheKey = this.buildEngagementTargetCacheKey({
        action,
        payload,
        hints,
      });
      this.engagementTargetCache.set(cacheKey, {
        expiresAtMs: Date.now() + ENGAGEMENT_TARGET_CACHE_TTL_MS,
        candidate: {
          ...cacheSeed,
          commentId: action === "comment" ? cacheSeed.commentId : null,
        },
      });
      this.pruneEngagementTargetCache(Date.now());
    }

    await this.ctx.memory
      .recordWrite({
        type: "engagement_context_prime_completed",
        at: nowIso(),
        commandId: command.id,
        action,
        reason,
        discoveredCount: discovered.length,
        query: hints.rawQuery,
      })
      .catch(() => undefined);
  }

  private async markQueueItemCompletedByInbox(
    inboxFile: string,
    status: "done" | "failed" | "missing",
    error: string | null,
  ): Promise<void> {
    const normalizedInboxFile = inboxFile.trim();
    if (!normalizedInboxFile.length) return;

    this.ctx.queue.queueStateMutation = this.ctx.queue.queueStateMutation
      .then(async () => {
        const raw = await readJsonFile(this.ctx.ipcPaths.queueStatePath);
        const state = normalizeQueueState(raw);
        const updatedItems = state.items.map((item) => {
          if (item.inboxFile !== normalizedInboxFile) return item;
          return {
            ...item,
            status,
            completedAt: nowIso(),
            lastError:
              typeof error === "string" && error.trim().length > 0
                ? error.trim()
                : null,
          };
        });
        const next: QueueState = {
          ...state,
          updatedAt: nowIso(),
          items: updatedItems,
        };
        await writeJsonFile(this.ctx.ipcPaths.queueStatePath, next);
      })
      .catch(() => undefined);

    await this.ctx.queue.queueStateMutation;
  }

  private async moveInboxFileToProcessed(
    filePath: string,
    statusSuffix: "done" | "failed" | "invalid" | "rejected",
  ): Promise<void> {
    const base = path.basename(filePath);
    const targetName = `${new Date().toISOString().replaceAll(":", "-")}__${statusSuffix}__${base}`;
    const targetPath = path.join(this.ctx.ipcPaths.processedDir, targetName);
    await ensureDir(this.ctx.ipcPaths.processedDir);
    await fs.rename(filePath, targetPath).catch(async () => {
      const bytes = await fs.readFile(filePath).catch(() => null);
      if (!bytes) return;
      await fs.writeFile(targetPath, bytes).catch(() => undefined);
      await fs.unlink(filePath).catch(() => undefined);
    });
  }
}
