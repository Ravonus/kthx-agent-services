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
import { verifyRuntimeCommandSeal } from "../directives/command-seal.js";
import type { CommandSealState } from "../directives/command-seal.js";
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
const ACTION_IDEMPOTENCY_IN_FLIGHT_WINDOW_MS = 45_000;
const ACTION_REQUEUE_BACKOFF_MS = 15_000;
const OWNER_CAPABILITY_COOLDOWN_MS = 60_000;
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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

const toUnknownArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

const extractBridgeMessageId = (value: unknown): string | null => {
  const fromRecord = (record: Record<string, unknown>): string | null => {
    const direct = asNonEmptyString(record.id);
    if (direct) return direct;
    const message = isRecord(record.message) ? record.message : null;
    const messageId = message ? asNonEmptyString(message.id) : null;
    if (messageId) return messageId;
    const nestedData = isRecord(record.data) ? record.data : null;
    if (!nestedData) return null;
    return fromRecord(nestedData);
  };
  if (!isRecord(value)) return null;
  return fromRecord(value);
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

export class CommandExecutor {
  private readonly ctx: CommandExecutorContext;
  private readonly inFlight = new Set<string>();
  private readonly ownerCapabilityDeniedByTarget = new Map<string, OwnerCapabilityCooldown>();

  constructor(ctx: CommandExecutorContext) {
    this.ctx = ctx;
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
    if (read.status === "not_ready") return false;
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

    const command = parseCommand(read.value);
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
        await this.writeOutcome(outcome);
        await this.ackDirectiveForOutcome(command, outcome).catch(() => undefined);
        await this.moveInboxFileToProcessed(filePath, "rejected");
        await this.markQueueItemCompletedByInbox(inboxFile, "failed", "invalid command signature");
        return true;
      }
    }

    let sealError = verifyRuntimeCommandSeal(this.ctx.commandSeal, command);
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
      await this.writeOutcome(outcome);
      await this.ackDirectiveForOutcome(command, outcome).catch(() => undefined);
      await this.moveInboxFileToProcessed(filePath, "rejected");
      await this.markQueueItemCompletedByInbox(
        inboxFile,
        "failed",
        `runtime command seal rejected (${sealError})`,
      );
      return true;
    }

    const result = await this.executeCommand(command).catch((error: unknown) => {
      if (error instanceof RequeueCommandError) {
        void this.ctx.memory
          .recordWrite({
            type: "inbox_command_requeued",
            at: nowIso(),
            inboxFile,
            commandId: command.id,
            kind: command.kind,
            reason: error.message,
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

    await this.writeOutcome(outcome);
    await this.ackDirectiveForOutcome(command, outcome).catch(() => undefined);
    await this.emitChatOutcome(command, outcome).catch(() => undefined);

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
      const action = asNonEmptyString(record.action)?.toLowerCase();
      if (action !== input.action) return null;
      if (typeof record.shouldExecute !== "boolean") return null;
      const target = isRecord(record.target) ? record.target : null;
      if (!target) return null;
      const postId = asPositiveInt(target.postId);
      if (postId !== input.expectedPostId) return null;
      const commentId =
        target.commentId === null ? null : asPositiveInt(target.commentId);
      if (commentId !== (input.expectedCommentId ?? null)) return null;
      const targetHash = asNonEmptyString(target.targetHash);
      if (!targetHash || targetHash !== input.expectedTargetHash) return null;
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
    const buildBase = (caption: string | null): Record<string, unknown> => ({
      kind: postKind,
      postType,
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
    const requiresCuration = Boolean(sourceDirectiveId);
    const directiveSeedHints = this.collectDirectiveSeedHints(payload);

    if (postType === "text") {
      const textBodyInitial = asNonEmptyString(payload.textBody);
      if (!textBodyInitial) {
        return this.failedOutcome(command, "textBody is required for text posts.");
      }
      const captionInitial = asNonEmptyString(payload.caption);
      const curatedTextDraft = await this.curatePostDraftWithOpenClaw({
        commandId: command.id,
        postType: "text",
        caption: captionInitial,
        textBody: textBodyInitial,
        mediaPrompt: null,
        context: postDraftContext,
        seedHints: directiveSeedHints,
      });
      if (requiresCuration && !curatedTextDraft) {
        throw new RequeueCommandError(
          "post_curation_waiting_for_openclaw:text_curation_unavailable",
        );
      }
      const captionForWrite = curatedTextDraft?.caption ?? captionInitial;
      const textBodyForWrite = curatedTextDraft?.textBody ?? textBodyInitial;
      if (!textBodyForWrite) {
        return this.failedOutcome(command, "textBody is required for text posts.");
      }
      const candidate = [captionForWrite, textBodyForWrite]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .join("\n");
      const result = await this.agent().createPost.mutate({
        ...buildBase(captionForWrite),
        textBody: textBodyForWrite,
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
        })
        .catch(() => undefined);
      return this.successOutcome(command, result);
    }

    const captionInitial = asNonEmptyString(payload.caption);
    const mediaPromptInitial =
      asNonEmptyString(payload.mediaPrompt) ??
      asNonEmptyString(payload.imagePrompt) ??
      asNonEmptyString(payload.prompt);
    const curatedMediaDraft = await this.curatePostDraftWithOpenClaw({
      commandId: command.id,
      postType: "media",
      caption: captionInitial,
      textBody: null,
      mediaPrompt: mediaPromptInitial,
      context: postDraftContext,
      seedHints: directiveSeedHints,
    });
    if (requiresCuration && !curatedMediaDraft) {
      throw new RequeueCommandError(
        "post_curation_waiting_for_openclaw:media_curation_unavailable",
      );
    }
    const captionForWrite = curatedMediaDraft?.caption ?? captionInitial;
    const mediaPromptForWrite = curatedMediaDraft?.mediaPrompt ?? mediaPromptInitial;
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
    });
    const mediaCandidate = [
      captionForWrite,
      mediaPromptForWrite,
    ]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join("\n");
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

  private buildPostDraftCurationPrompt(input: {
    postType: "text" | "media";
    caption: string | null;
    textBody: string | null;
    mediaPrompt: string | null;
    context: PostDraftContext;
    seedHints: string[];
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
        "- Must not reuse long phrases from targetPostText/targetMedia/directiveHint.",
        "- Must not reuse long phrases from directive seed text.",
        `draftCaption: ${input.caption ?? ""}`,
        `draftTextBody: ${input.textBody ?? ""}`,
        ...(input.seedHints.length > 0
          ? [
              "Directive seeds (avoid echo):",
              ...input.seedHints.slice(0, 8).map((entry) => `- ${entry}`),
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
      "- Must be materially different from targetPostText/targetMedia/directiveHint.",
      "- Must be materially different from directive seed text.",
      `draftCaption: ${input.caption ?? ""}`,
      `draftMediaPrompt: ${input.mediaPrompt ?? ""}`,
      ...(input.seedHints.length > 0
        ? [
            "Directive seeds (avoid echo):",
            ...input.seedHints.slice(0, 8).map((entry) => `- ${entry}`),
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
        caption,
        textBody: truncateText(textBody, 240),
        mediaPrompt: null,
      };
    }
    if (postType === "media" && (mediaPrompt || caption)) {
      return {
        caption: caption ? truncateText(caption, 2200) : null,
        textBody: null,
        mediaPrompt: mediaPrompt ? truncateText(mediaPrompt, 320) : null,
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
    push(payload.title);
    const scope = isRecord(payload.directiveScope) ? payload.directiveScope : null;
    if (scope) {
      push(scope.reason);
      push(scope.note);
      push(scope.topic);
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
    const postId = asPositiveInt(payload.postId);
    const body =
      asNonEmptyString(payload.body) ??
      asNonEmptyString(payload.requestText) ??
      asNonEmptyString(payload.prompt) ??
      "Write a concise, relevant reply to the target post.";
    if (!postId) {
      return this.failedOutcome(command, "postId is required for comments.");
    }
    const parentId = asPositiveInt(payload.parentId);
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
        postId,
        parentId,
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
      const finalBody = curatedBody.body;
      const result = await this.agent().commentPost.mutate({
        postId,
        body: finalBody,
        ...(parentId ? { parentId } : {}),
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
          postId,
          parentId,
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
    return stripped.replace(/\s+/gu, " ").trim();
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
    const postId = asPositiveInt(payload.postId);
    if (!postId) return this.failedOutcome(command, "postId is required for write.votePost.");
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
            payload.explicitPublishRequested === true ||
            payload.forceNow === true ||
            payload.userExplicitRequest === true;
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
    const postId = asPositiveInt(payload.postId);
    if (!postId) return this.failedOutcome(command, "postId is required for write.repostPost.");
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
            payload.explicitPublishRequested === true ||
            payload.forceNow === true ||
            payload.userExplicitRequest === true;
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

  private async executeGenerateAndQueue(command: Command): Promise<CommandOutcome> {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) {
      return this.failedOutcome(command, "Invalid payload for generate-and-queue command.");
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

    const inlineDrafts = this.extractInlineDrafts(payload);
    const generateInput =
      inlineDrafts.length > 0
        ? null
        : await this.buildGenerateInputWithRuntimeContext(payload, command);
    const generatedResult =
      inlineDrafts.length > 0
        ? null
        : await this.agent().generate.mutate(generateInput ?? this.buildGenerateInput(payload, command));
    const drafts =
      inlineDrafts.length > 0
        ? inlineDrafts
        : this.extractGeneratedDrafts(generatedResult);
    if (drafts.length === 0) {
      if (payload.requireDraftOnly === true) {
        await this.sendDraftFailureMessage({
          payload,
          message: "I couldn't generate a draft right now. Please try again.",
        }).catch(() => undefined);
      }
      return this.failedOutcome(command, "generate returned no executable drafts.", "no_drafts");
    }

    const requireDraftOnly = payload.requireDraftOnly === true;
    if (requireDraftOnly) {
      const draftPreview = this.buildDraftPreviewPayload(drafts);
      if (!draftPreview) {
        await this.sendDraftFailureMessage({
          payload,
          message: "I generated output, but couldn't shape a readable draft preview.",
        }).catch(() => undefined);
        return this.failedOutcome(
          command,
          "generate returned drafts without previewable text.",
          "draft_preview_missing",
        );
      }
      await this.sendDraftPreviewMessage({
        payload,
        preview: draftPreview,
      }).catch(() => undefined);
      return this.successOutcome(command, {
        generated: generatedResult,
        draftOnly: true,
        draftCount: drafts.length,
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
    if (requireExplicitPublishVerb && !explicitPublishRequested) {
      const blockedDraftCount = drafts.filter((draft) => {
        const action = draft.action.trim().toLowerCase();
        return (
          action === "post" ||
          action === "comment" ||
          action === "story" ||
          action === "like" ||
          action === "repost"
        );
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
          "Publish action blocked: explicit post/publish/share/comment/story/repost request required.",
          "publish_verb_required",
        );
      }
    }

    const executedOutcomes: CommandOutcome[] = [];
    for (const draft of drafts) {
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
      return this.failedOutcome(
        command,
        firstFailure.error?.message ?? "generated draft execution failed.",
        firstFailure.error?.code,
      );
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
    let previewProgressFingerprint = "";
    let previewProgressUpdatedAtMs = 0;
    let latestMediaProgress: MediaGenerationProgress | null = null;
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
    }): Promise<void> => {
      const callAgentChatBridge = this.ctx.callAgentChatBridge;
      if (!callAgentChatBridge) return;
      const sendFreshPreviewMessage = async (attachments?: Array<{
        url: string;
        mimeType: string;
        sizeBytes: number;
        metadata?: Record<string, unknown>;
      }>): Promise<void> => {
        const created = await callAgentChatBridge({
          action: "send_message",
          clientMessageId:
            input.kind === "processing"
              ? previewClientMessageId
              : `${previewClientMessageId}_${input.kind}_${Date.now()}`,
          ...chatRoute,
          body: input.body,
          format: "markdown",
          ...(attachments ? { attachments } : {}),
          metadata: input.metadata,
        });
        previewMessageId ??= extractBridgeMessageId(created);
      };
      if (previewMessageId) {
        try {
          await callAgentChatBridge({
            action: "edit_message",
            messageId: previewMessageId,
            body: input.body,
            ...(input.attachments ? { attachments: input.attachments } : {}),
            metadata: input.metadata,
          });
          return;
        } catch (error: unknown) {
          await this.ctx.memory
            .recordWrite({
              type: "chat_literal_generate_preview_edit_failed",
              at: nowIso(),
              commandId: command.id,
              kind: input.kind,
              message:
                error instanceof Error ? error.message : String(error),
            })
            .catch(() => undefined);
          // Keep a single preview message thread. Do not spawn a duplicate box.
          if (input.kind === "processing") {
            return;
          }
          try {
            await sendFreshPreviewMessage(input.attachments);
            return;
          } catch (fallbackError: unknown) {
            await this.ctx.memory
              .recordWrite({
                type: "chat_literal_generate_preview_terminal_send_failed",
                at: nowIso(),
                commandId: command.id,
                kind: input.kind,
                message:
                  fallbackError instanceof Error
                    ? fallbackError.message
                    : String(fallbackError),
              })
              .catch(() => undefined);
            if (input.attachments && input.attachments.length > 0) {
              try {
                await sendFreshPreviewMessage(undefined);
                return;
              } catch (fallbackWithoutAttachmentError: unknown) {
                await this.ctx.memory
                  .recordWrite({
                    type: "chat_literal_generate_preview_terminal_send_without_attachment_failed",
                    at: nowIso(),
                    commandId: command.id,
                    kind: input.kind,
                    message:
                      fallbackWithoutAttachmentError instanceof Error
                        ? fallbackWithoutAttachmentError.message
                        : String(fallbackWithoutAttachmentError),
                  })
                  .catch(() => undefined);
              }
            }
            return;
          }
        }
      }
      await sendFreshPreviewMessage(input.attachments);
    };
    const emitStreamProgress = async (progress: MediaGenerationProgress): Promise<void> => {
      latestMediaProgress = progress;
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
      await this.ctx.callAgentChatBridge?.({
        action: "edit_message",
        messageId: previewMessageId,
        body: processingBody,
        metadata: {
          automated: true,
          sourceContext: "CHAT",
          actionPreview: buildProcessingActionPreview(progress),
        },
      }).catch(() => undefined);
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
        const streamedFrames = latestMediaProgress?.streamFrames ?? [];
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
        await sendOrEditPreviewMessage({
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
        const streamedFrames = latestMediaProgress?.streamFrames ?? [];
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
        await sendOrEditPreviewMessage({
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
        });
      }

      const streamedFrames = latestMediaProgress?.streamFrames ?? [];
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
      await sendOrEditPreviewMessage({
        kind: "success",
        body: `Generated ${generatedLabel} for "${summary}".`,
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
      await this.ctx.memory.recordWrite({
        type: "chat_literal_generate_sent",
        at: nowIso(),
        commandId: command.id,
        generatedAssetType,
        mediaUrl: media.mediaUrl,
        prompt: summary,
        targetConversationId: chatTarget.conversationId ?? null,
        targetChannelId: chatTarget.channelId ?? null,
      });
      return this.successOutcome(command, {
        generatedAssetType,
        mediaUrl: media.mediaUrl,
        prompt: summary,
        mode: "chat_literal_generate",
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const isPromptCurationFailure = /prompt_curation_/iu.test(message);
      await sendOrEditPreviewMessage({
        kind: "failed",
        body: avatarRequest
          ? "I could not update that avatar right now. Please retry in a moment."
          : bannerRequest
            ? "I could not update that banner right now. Please retry in a moment."
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
                  : isPromptCurationFailure
                    ? "Prompt curation failed"
                    : `${generatedLabel.charAt(0).toUpperCase()}${generatedLabel.slice(1)} generation failed`,
            error: truncateText(message, 240),
          },
        },
      }).catch(() => undefined);
      await this.ctx.memory.recordWrite({
        type: "chat_literal_generate_failed",
        at: nowIso(),
        commandId: command.id,
        generatedAssetType,
        avatarRequest,
        bannerRequest,
        error: message,
      });
      return this.failedOutcome(
        command,
        avatarRequest
          ? `Avatar update failed: ${message}`
          : bannerRequest
            ? `Banner update failed: ${message}`
          : `Literal generate failed: ${message}`,
        avatarRequest
          ? "avatar_update_failed"
          : bannerRequest
            ? "banner_update_failed"
            : "literal_generate_failed",
      );
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
    const primaryKind = requestedKinds[0] ?? mappedKind;
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
      ...(requestedKinds.length > 0 ? { kinds: requestedKinds } : {}),
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

    if (mappedKind === "write.votePost") {
      basePayload.vote = 1;
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
  }): Promise<ResolvedMediaUpload> {
    const payload = input.payload;
    const keepOriginal = input.keepOriginal === true;
    const existingMediaUrl = asNonEmptyString(payload.mediaUrl);
    if (existingMediaUrl) {
      return this.uploadResolvedMediaSource(existingMediaUrl, { keepOriginal });
    }

    const mediaItems = Array.isArray(payload.mediaItems) ? payload.mediaItems : [];
    for (const mediaItem of mediaItems) {
      if (!isRecord(mediaItem)) continue;
      const mediaUrl = asNonEmptyString(mediaItem.mediaUrl);
      if (mediaUrl) {
        return this.uploadResolvedMediaSource(mediaUrl, { keepOriginal });
      }
    }

    const prompt =
      input.promptFallbacks.find((entry) => typeof entry === "string" && entry.trim().length > 0) ??
      null;
    if (!prompt) {
      throw new Error("no_media_url");
    }
    return this.generateAndUploadMediaFromPrompt(prompt, {
      generatedAssetType: this.resolveGeneratedAssetType(payload.generatedAssetType),
      mode: "write_media_generate",
      referenceInputs: this.collectMediaReferenceInputs(payload),
      keepOriginal,
    });
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
    return withoutGenerationVerb.trim();
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
        sourceFileName && /\.part(\d+)(?:\D|$)/iu.test(sourceFileName)
          ? Number.parseInt(
              /\.part(\d+)(?:\D|$)/iu.exec(sourceFileName)?.[1] ?? "",
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
        sourceFileName !== null && /\.part\d+(?:\D|$)/iu.test(sourceFileName);
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
    onProgress?: ((progress: MediaGenerationProgress) => Promise<void> | void) | undefined;
  }): Promise<{ payload: unknown; timedOut: boolean } | null> {
    const baseUrl = this.resolveMediaGeneratorBaseUrl();
    if (!baseUrl) return null;
    const useFileGenerator = input.generatedAssetType !== "image";
    const requiresFinalStreamFrame = !useFileGenerator;
    const requestBody: Record<string, unknown> = {
      prompt: input.prompt,
      command: useFileGenerator ? "generateFile" : "generateImage",
      mode: useFileGenerator ? "file" : "image",
      stream: true,
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
        if (!/\.part\d+(?:\D|$)/iu.test(direct)) return true;
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
        const hasFinalStreamArtifact = progress.streamFrames.some(
          (frame) =>
            frame.isFinalStreamFrame &&
            typeof frame.outputPath === "string" &&
            frame.outputPath.trim().length > 0,
        );
        const hasFinalArtifactFile =
          hasFinalArtifactInList(savedFiles) || hasFinalArtifactInList(observedOutputFiles);
        const generationReady = requiresFinalStreamFrame
          ? hasFinalStreamFrame ||
            hasFinalStreamArtifact ||
            hasFinalArtifactFile ||
            (this.isTerminalMediaGeneratorStatus(status) &&
              (hasFinalStreamFrame ||
                hasFinalStreamArtifact ||
                hasFinalArtifactFile ||
                !hasArtifacts))
          : hasArtifacts || this.isTerminalMediaGeneratorStatus(status);
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
      onProgress: opts?.onProgress,
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
  }): Promise<string | null> {
    const deadlineMs = Date.now() + Math.max(0, Math.floor(input.maxWaitMs));
    let lastCandidate: string | null = null;
    do {
      const candidate = await this.resolveGeneratedMediaSource({
        requestDir: input.requestDir,
        outputPath: input.outputPath,
        stdout: input.stdout,
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
  }): Promise<string | null> {
    const outputExists = await fs
      .access(input.outputPath)
      .then(() => true)
      .catch(() => false);
    if (outputExists) return input.outputPath;

    const parsed = parseJsonFromMixedText(input.stdout);
    const fromParsed = this.extractMediaSourceFromParsedOutput(parsed, input.requestDir);
    if (fromParsed) return fromParsed;

    const discovered = await this.findFirstMediaFile(input.requestDir, 3);
    if (discovered) return discovered;
    return null;
  }

  private extractMediaSourceFromParsedOutput(parsed: unknown, requestDir: string): string | null {
    const resolveCandidate = (value: unknown): string | null => {
      const candidate = asNonEmptyString(value);
      if (!candidate) return null;
      if (isHttpUrl(candidate) || isDataUri(candidate)) return candidate;
      const absolute = path.isAbsolute(candidate)
        ? candidate
        : path.resolve(requestDir, candidate);
      return absolute;
    };

    const resolveFromStreamEvents = (value: unknown): string | null => {
      const events = toUnknownArray(value);
      if (events.length === 0) return null;
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
          sourceFileName !== null && /\.part\d+(?:\D|$)/iu.test(sourceFileName);
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
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const entry = events[i];
        if (!isRecord(entry)) continue;
        const resolved = resolveFromEntry(entry);
        if (resolved.isFinalStreamFrame && resolved.resolved) {
          return resolved.resolved;
        }
        if (resolved.isFinalStreamFrame && resolved.finalFramePreview) {
          return resolved.finalFramePreview;
        }
      }
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const entry = events[i];
        if (!isRecord(entry)) continue;
        const resolved = resolveFromEntry(entry);
        if (resolved.resolved) {
          return resolved.resolved;
        }
      }
      return null;
    };

    if (!isRecord(parsed)) return null;
    const streamResolved = resolveFromStreamEvents(parsed.streamEvents);
    if (streamResolved) return streamResolved;
    const urlKeys = [
      "lastOutputPath",
      "lastOutputFile",
      "outputPath",
      "savedOutputPath",
      "savedPath",
      "url",
      "mediaUrl",
      "outputUrl",
      "fileUrl",
      "imageUrl",
    ];
    const scanStringArray = (value: unknown): string | null => {
      const items = toUnknownArray(value);
      if (items.length === 0) return null;
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const entry = items[i];
        const resolved = resolveCandidate(entry);
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
      const resolved = scanStringArray(parsed[key]);
      if (resolved) return resolved;
    }
    for (const key of urlKeys) {
      const resolved = resolveCandidate(parsed[key]);
      if (resolved) return resolved;
    }

    const context = isRecord(parsed.context) ? parsed.context : null;
    if (context) {
      const contextStreamResolved = resolveFromStreamEvents(context.streamEvents);
      if (contextStreamResolved) return contextStreamResolved;
      for (const key of arrayKeys) {
        const resolved = scanStringArray(context[key]);
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
        if (runStreamResolved) return runStreamResolved;
        for (const key of arrayKeys) {
          const resolved = scanStringArray(run[key]);
          if (resolved) return resolved;
        }
        for (const key of urlKeys) {
          const resolved = resolveCandidate(run[key]);
          if (resolved) return resolved;
        }
        const runContext = isRecord(run.context) ? run.context : null;
        if (runContext) {
          const runContextStreamResolved = resolveFromStreamEvents(runContext.streamEvents);
          if (runContextStreamResolved) return runContextStreamResolved;
          for (const key of arrayKeys) {
            const resolved = scanStringArray(runContext[key]);
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
      const fileEntries = entries
        .filter((entry) => entry.isFile() && MEDIA_FILE_RE.test(entry.name))
        .map((entry) => path.join(currentPath, entry.name))
        .sort();
      if (fileEntries.length > 0) return fileEntries[0] ?? null;
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

  private async emitChatOutcome(command: Command, outcome: CommandOutcome): Promise<void> {
    if (!this.ctx.callAgentChatBridge) return;
    const kind = command.kind.trim().toLowerCase();
    if (!kind.startsWith("write.")) return;
    await sendChatResultMessageFromOutcome({
      command,
      outcome,
      deps: {
        callAgentChatBridge: this.ctx.callAgentChatBridge,
        memory: this.ctx.memory,
      },
    });
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
      const normalized = value.trim();
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
  }): Promise<void> {
    if (!this.ctx.callAgentChatBridge) return;
    const chatTarget = resolveChatTargetFromPayload(input.payload);
    if (!chatTarget) return;
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
  }

  private async sendDraftFailureMessage(input: {
    payload: Record<string, unknown>;
    message: string;
  }): Promise<void> {
    if (!this.ctx.callAgentChatBridge) return;
    const chatTarget = resolveChatTargetFromPayload(input.payload);
    if (!chatTarget) return;
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
    await this.agent().ackDirective.mutate({
      directiveId,
      status: outcome.ok ? "executed" : "failed",
      kind: command.kind,
      ...(outcome.ok ? {} : { error: outcome.error?.message ?? "Directive failed." }),
      ...(command.actionNonce ? { actionNonce: command.actionNonce } : {}),
      executionDigest,
    });
  }

  private async writeOutcome(outcome: CommandOutcome): Promise<void> {
    await appendJsonLine(this.ctx.ipcPaths.resultsPath, outcome).catch(() => undefined);
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
