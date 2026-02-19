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
import { computeCommandSignature } from "../lib/crypto.js";
import { appendJsonLine, ensureDir, readJsonMaybeIncomplete, readJsonFile, writeJsonFile } from "../lib/fs.js";
import { isRecord } from "../lib/guards.js";
import { parseCommand, parseJsonFromMixedText } from "../lib/parsing.js";
import { nowIso } from "../lib/text.js";
import { normalizeQueueState } from "../queue/queue-state.js";
import type { QueueState } from "../types/ipc.js";
import type { Command } from "../types/ipc.js";

const MEDIA_FILE_RE = /\.(png|jpe?g|webp|gif|svg|mp4|mov|webm)$/iu;

const isHttpUrl = (value: string): boolean => /^https?:\/\//iu.test(value.trim());
const isDataUri = (value: string): boolean => /^data:/iu.test(value.trim());

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
  return "application/octet-stream";
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
  votePost: AgentMutator;
  repostPost: AgentMutator;
  generate: AgentMutator;
  uploadDataUri: AgentMutator;
  uploadRemote: AgentMutator;
};

type TrpcLike = {
  agent: Record<string, AgentMutator>;
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
  };
  trpc: TrpcLike | null;
  commandSeal: CommandSealState;
  controlKey: string | null;
  queue: QueueTrackingStateLike;
  callAgentChatBridge: ((payload: unknown) => Promise<unknown>) | null;
  callAgentUploadChunk: ((payload: unknown) => Promise<unknown>) | null;
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
type DraftPreviewPayload = {
  body: string;
  summary: string;
  draftPreviewText: string;
  draftPostKind: "post" | "thread";
  draftMode: "thread" | "carousel";
  draftSlideCount: number;
};

export class CommandExecutor {
  private readonly ctx: CommandExecutorContext;
  private readonly inFlight = new Set<string>();

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

    const sealError = verifyRuntimeCommandSeal(this.ctx.commandSeal, command);
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

    const base: Record<string, unknown> = {
      kind: postKind,
      postType,
      ...(asNonEmptyString(payload.caption) ? { caption: asNonEmptyString(payload.caption) } : {}),
      ...(provenance ? { provenance } : {}),
      ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
      ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
      ...(command.grantId ? { grantId: command.grantId } : {}),
    };

    if (postType === "text") {
      const textBody = asNonEmptyString(payload.textBody);
      if (!textBody) {
        return this.failedOutcome(command, "textBody is required for text posts.");
      }
      const result = await this.agent().createPost.mutate({
        ...base,
        textBody,
      });
      return this.successOutcome(command, result);
    }

    const media = await this.resolveMediaUpload({
      payload,
      promptFallbacks: [
        asNonEmptyString(payload.mediaPrompt),
        asNonEmptyString(payload.imagePrompt),
      ],
    });
    const result = await this.agent().createPost.mutate({
      ...base,
      mediaUrl: media.mediaUrl,
      ...(media.mediaOriginalUrl ? { mediaOriginalUrl: media.mediaOriginalUrl } : {}),
      ...(media.mediaOptimizedUrl ? { mediaOptimizedUrl: media.mediaOptimizedUrl } : {}),
      ...(media.mediaContentHash ? { mediaContentHash: media.mediaContentHash } : {}),
      ...(media.mediaIpfsCid ? { mediaIpfsCid: media.mediaIpfsCid } : {}),
      ...(typeof media.mediaSizeBytes === "number" ? { mediaSizeBytes: media.mediaSizeBytes } : {}),
      ...(media.mediaType ? { mediaType: media.mediaType } : {}),
    });
    return this.successOutcome(command, result);
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
      promptFallbacks: [
        asNonEmptyString(payload.mediaPrompt),
        asNonEmptyString(payload.imagePrompt),
        asNonEmptyString(payload.prompt),
      ],
    });
    const result = await this.agent().updateAvatar.mutate({
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

  private async executeWriteComment(command: Command): Promise<CommandOutcome> {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) {
      return this.failedOutcome(command, "Invalid payload for write.commentPost.");
    }
    const postId = asPositiveInt(payload.postId);
    const body = asNonEmptyString(payload.body);
    if (!postId || !body) {
      return this.failedOutcome(command, "postId and body are required for comments.");
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
    const parentId = asPositiveInt(payload.parentId);
    const result = await this.agent().commentPost.mutate({
      postId,
      body,
      ...(parentId ? { parentId } : {}),
      ...(provenance ? { provenance } : {}),
      ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
      ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
    });
    return this.successOutcome(command, result);
  }

  private async executeWriteVote(command: Command): Promise<CommandOutcome> {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) return this.failedOutcome(command, "Invalid payload for write.votePost.");
    const postId = asPositiveInt(payload.postId);
    if (!postId) return this.failedOutcome(command, "postId is required for write.votePost.");
    const voteRaw =
      typeof payload.vote === "number" && Number.isFinite(payload.vote)
        ? Math.trunc(payload.vote)
        : 1;
    const vote = voteRaw > 0 ? 1 : voteRaw < 0 ? -1 : 0;
    const result = await this.agent().votePost.mutate({ postId, vote });
    return this.successOutcome(command, result);
  }

  private async executeWriteRepost(command: Command): Promise<CommandOutcome> {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) return this.failedOutcome(command, "Invalid payload for write.repostPost.");
    const postId = asPositiveInt(payload.postId);
    if (!postId) return this.failedOutcome(command, "postId is required for write.repostPost.");
    const repost = payload.repost === 0 ? 0 : 1;
    const result = await this.agent().repostPost.mutate({ postId, repost });
    return this.successOutcome(command, result);
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
    const generatedResult =
      inlineDrafts.length > 0
        ? null
        : await this.agent().generate.mutate(this.buildGenerateInput(payload, command));
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
          action === "like"
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
          "Publish action blocked: explicit post/publish/share/comment/story request required.",
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

    const avatarRequest =
      payload.avatarRequest === true ||
      asNonEmptyString(payload.requestedAction)?.toLowerCase() === "avatar";
    const avatarTargetRaw = asNonEmptyString(payload.avatarTarget)?.toLowerCase();
    const avatarTarget = avatarTargetRaw === "owner" ? "owner" : "agent";
    const defaultAvatarPrompt =
      avatarTarget === "owner"
        ? "Create a profile avatar for my account on this social app."
        : "Create a profile avatar for your account on this social app.";
    const prompt =
      asNonEmptyString(payload.mediaPrompt) ??
      asNonEmptyString(payload.imagePrompt) ??
      asNonEmptyString(payload.prompt) ??
      asNonEmptyString(payload.topic) ??
      asNonEmptyString(payload.requestText) ??
      (avatarRequest ? defaultAvatarPrompt : null);
    if (!prompt) {
      return this.failedOutcome(
        command,
        "No prompt provided for literal generate request.",
        "missing_prompt",
      );
    }
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
    const generatedLabel = generatedAssetType === "gif" ? "GIF" : "image";
    try {
      const media = await this.generateAndUploadMediaFromPrompt(prompt);
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
      const summary = truncateText(prompt, 220);
      if (avatarRequest) {
        const avatarResult = await this.agent().updateAvatar.mutate({
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
        const completionText =
          avatarTarget === "owner"
            ? "Done. Here is your new avatar."
            : "Done. Here is my new avatar.";
        await this.ctx.callAgentChatBridge({
          action: "send_message",
          clientMessageId: `runtime_avatar_result_${Date.now().toString(36)}_${crypto
            .randomUUID()
            .replaceAll("-", "")
            .slice(0, 10)}`,
          ...(chatTarget.conversationId
            ? { conversationId: chatTarget.conversationId }
            : { channelId: chatTarget.channelId }),
          body: completionText,
          format: "markdown",
          attachments: [
            {
              url: media.mediaUrl,
              mimeType,
              sizeBytes,
              metadata: {
                source: "runtime.avatar",
                generatedAssetType: "image",
              },
            },
          ],
          metadata: {
            automated: true,
            sourceContext: "CHAT",
            actionPreview: {
              type: "avatar",
              status: "success",
              title: "Avatar updated",
              summary,
              href: media.mediaUrl,
              hrefLabel: "Open avatar image",
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

      await this.ctx.callAgentChatBridge({
        action: "send_message",
        clientMessageId: `runtime_generate_result_${Date.now().toString(36)}_${crypto
          .randomUUID()
          .replaceAll("-", "")
          .slice(0, 10)}`,
        ...(chatTarget.conversationId
          ? { conversationId: chatTarget.conversationId }
          : { channelId: chatTarget.channelId }),
        body: `Generated ${generatedLabel} for "${summary}".`,
        format: "markdown",
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
            href: media.mediaUrl,
            hrefLabel: `Open ${generatedLabel}`,
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
      await this.ctx.callAgentChatBridge({
        action: "send_message",
        clientMessageId: `runtime_generate_error_${Date.now().toString(36)}_${crypto
          .randomUUID()
          .replaceAll("-", "")
          .slice(0, 10)}`,
        ...(chatTarget.conversationId
          ? { conversationId: chatTarget.conversationId }
          : { channelId: chatTarget.channelId }),
        body: avatarRequest
          ? "I could not update that avatar right now. Please retry in a moment."
          : `I could not generate that ${generatedLabel} right now. Please retry in a moment.`,
        format: "markdown",
        metadata: {
          automated: true,
          sourceContext: "CHAT",
          actionPreview: {
            type: avatarRequest ? "avatar" : generatedAssetType,
            status: "failed",
            title: avatarRequest
              ? "Avatar update failed"
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
        error: message,
      });
      return this.failedOutcome(
        command,
        avatarRequest
          ? `Avatar update failed: ${message}`
          : `Literal generate failed: ${message}`,
        avatarRequest ? "avatar_update_failed" : "literal_generate_failed",
      );
    }
  }

  private async executeCommandFromMappedDraft(command: Command): Promise<CommandOutcome> {
    const kind = command.kind.trim().toLowerCase();
    if (kind === "write.createpost") return this.executeWriteCreatePost(command);
    if (kind === "write.createstory") return this.executeWriteCreateStory(command);
    if (kind === "write.updateavatar") return this.executeWriteUpdateAvatar(command);
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
    const postId = asPositiveInt(payload.postId);
    const commentId = asPositiveInt(payload.commentId);
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
      kind: mappedKind,
      ...(count ? { count } : {}),
      ...(topic ? { topic } : {}),
      ...(mood ? { mood } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(postId ? { postId } : {}),
      ...(commentId ? { commentId } : {}),
      ...(provenance ? { provenance } : {}),
      ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
      ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
    };
  }

  private mapGoalToGenerateKind(goal: string): string {
    if (goal === "avatar") return "media";
    if (goal === "story") return "story";
    if (goal === "thread") return "thread";
    if (goal === "comment" || goal === "reply") return "comment";
    if (goal === "like" || goal === "engagement") return "like";
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
          : action === "avatar"
            ? "write.updateAvatar"
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

  private async resolveMediaUpload(input: {
    payload: Record<string, unknown>;
    promptFallbacks: Array<string | null>;
  }): Promise<ResolvedMediaUpload> {
    const payload = input.payload;
    const existingMediaUrl = asNonEmptyString(payload.mediaUrl);
    if (existingMediaUrl) {
      return this.uploadResolvedMediaSource(existingMediaUrl);
    }

    const mediaItems = Array.isArray(payload.mediaItems) ? payload.mediaItems : [];
    for (const mediaItem of mediaItems) {
      if (!isRecord(mediaItem)) continue;
      const mediaUrl = asNonEmptyString(mediaItem.mediaUrl);
      if (mediaUrl) {
        return this.uploadResolvedMediaSource(mediaUrl);
      }
    }

    const prompt =
      input.promptFallbacks.find((entry) => typeof entry === "string" && entry.trim().length > 0) ??
      null;
    if (!prompt) {
      throw new Error("no_media_url");
    }
    return this.generateAndUploadMediaFromPrompt(prompt);
  }

  private async uploadResolvedMediaSource(source: string): Promise<ResolvedMediaUpload> {
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
          });
          if (uploadedByChunk) return uploadedByChunk;
        }
      }
      const uploaded = await this.agent().uploadDataUri.mutate({ dataUri: trimmed });
      return this.mapUploadResult(uploaded);
    }
    if (isHttpUrl(trimmed)) {
      const uploaded = await this.agent().uploadRemote.mutate({ url: trimmed });
      return this.mapUploadResult(uploaded);
    }
    const localPath = path.resolve(trimmed);
    const bytes = await fs.readFile(localPath);
    if (!bytes.byteLength) {
      throw new Error("media_source_empty");
    }
    const mime = extToMime(localPath);
    const uploadedByChunk = await this.uploadBytesViaChunkRoute({
      bytes,
      mimeType: mime,
      filename: path.basename(localPath) || `upload-${Date.now()}.${mimeToExt(mime)}`,
    });
    if (uploadedByChunk) return uploadedByChunk;
    const dataUri = `data:${mime};base64,${bytes.toString("base64")}`;
    const uploaded = await this.agent().uploadDataUri.mutate({ dataUri });
    return this.mapUploadResult(uploaded);
  }

  private async uploadBytesViaChunkRoute(input: {
    bytes: Buffer;
    mimeType: string;
    filename: string;
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
    const result: ResolvedMediaUpload = { mediaUrl };
    const originalUrl = asNonEmptyString(data?.originalUrl);
    const optimizedUrl = asNonEmptyString(data?.optimizedUrl);
    const contentHash = asNonEmptyString(data?.contentHash);
    const ipfsCid = asNonEmptyString(data?.ipfsCid);
    if (originalUrl) result.mediaOriginalUrl = originalUrl;
    if (optimizedUrl) result.mediaOptimizedUrl = optimizedUrl;
    if (contentHash) result.mediaContentHash = contentHash;
    if (ipfsCid) result.mediaIpfsCid = ipfsCid;
    if (typeof data?.sizeBytes === "number" && Number.isFinite(data.sizeBytes)) {
      result.mediaSizeBytes = Math.max(1, Math.floor(data.sizeBytes));
    }
    if (mediaType) result.mediaType = mediaType;
    return result;
  }

  private async generateAndUploadMediaFromPrompt(prompt: string): Promise<ResolvedMediaUpload> {
    const template = this.ctx.config.imageGenerateCmd;
    if (!template?.trim().length) {
      throw new Error("image_generator_unconfigured");
    }
    const requestDir = path.join(
      this.ctx.ipcPaths.generatedDir,
      `generate-${Date.now()}-${crypto.randomUUID()}`,
    );
    await ensureDir(requestDir);

    const promptFilePath = path.join(requestDir, "prompt.txt");
    const outputPath = path.join(requestDir, "output.png");
    await fs.writeFile(promptFilePath, `${prompt}\n`, "utf8").catch(() => undefined);

    const refs =
      process.platform === "win32"
        ? {
            prompt: "%MG_IMAGE_PROMPT%",
            dir: "%MG_IMAGE_PROMPT_DIR%",
            output: "%MG_IMAGE_OUTPUT%",
            promptFile: "%MG_IMAGE_PROMPT_FILE%",
            files: "%MG_IMAGE_FILES%",
          }
        : {
            prompt: "$MG_IMAGE_PROMPT",
            dir: "$MG_IMAGE_PROMPT_DIR",
            output: "$MG_IMAGE_OUTPUT",
            promptFile: "$MG_IMAGE_PROMPT_FILE",
            files: "$MG_IMAGE_FILES",
          };
    let command = template
      .replaceAll("{prompt}", refs.prompt)
      .replaceAll("{dir}", refs.dir)
      .replaceAll("{output}", refs.output)
      .replaceAll("{prompt_file}", refs.promptFile)
      .replaceAll("{files}", refs.files)
      .trim();
    if (!command.includes(refs.prompt)) {
      command = `${command} "${refs.prompt}"`.trim();
    }

    await this.ctx.memory.recordWrite({
      type: "image_generation_invoked",
      at: nowIso(),
      provider: "command",
      promptChars: prompt.length,
      commandPreview: command.slice(0, 240),
    }).catch(() => undefined);

    const execResult = await this.runShellCommand(command, {
      MG_IMAGE_PROMPT: prompt,
      MG_IMAGE_PROMPT_DIR: requestDir,
      MG_IMAGE_OUTPUT: outputPath,
      MG_IMAGE_PROMPT_FILE: promptFilePath,
      MG_IMAGE_FILES: "",
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

    const resolvedSource = await this.resolveGeneratedMediaSource({
      requestDir,
      outputPath,
      stdout: execResult.stdout,
    });
    if (!resolvedSource) {
      throw new Error("no_media_url");
    }
    return this.uploadResolvedMediaSource(resolvedSource);
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

    if (!isRecord(parsed)) return null;
    const urlKeys = ["url", "mediaUrl", "outputUrl", "fileUrl", "imageUrl", "savedPath"];
    for (const key of urlKeys) {
      const resolved = resolveCandidate(parsed[key]);
      if (resolved) return resolved;
    }

    const scanStringArray = (value: unknown): string | null => {
      if (!Array.isArray(value)) return null;
      for (const entry of value) {
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

    const context = isRecord(parsed.context) ? parsed.context : null;
    if (context) {
      for (const key of arrayKeys) {
        const resolved = scanStringArray(context[key]);
        if (resolved) return resolved;
      }
      for (const key of urlKeys) {
        const resolved = resolveCandidate(context[key]);
        if (resolved) return resolved;
      }
    }

    if (Array.isArray(parsed.runs)) {
      for (const run of parsed.runs) {
        if (!isRecord(run)) continue;
        for (const key of arrayKeys) {
          const resolved = scanStringArray(run[key]);
          if (resolved) return resolved;
        }
        for (const key of urlKeys) {
          const resolved = resolveCandidate(run[key]);
          if (resolved) return resolved;
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
