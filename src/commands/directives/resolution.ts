/** Directive resolution and command-request-origin helpers. */

import fs from "node:fs/promises";
import path from "node:path";

import type {
  Command,
  CommandExecutorContext,
  MediaGenerationDeferralDecision,
  CommandOutcome,
} from "../types.js";
import { asNonEmptyString, toUnknownArray } from "../helpers.js";
import {
  PERSONA_REFERENCE_SETUP_REQUIRED_PATTERN,
  IMAGE_GENERATION_SETUP_REQUIRED_PATTERN,
  MEDIA_GENERATION_OUTPUT_UNAVAILABLE_PATTERN,
} from "../constants.js";
import { isRecord } from "../../lib/guards.js";
import { nowIso } from "../../lib/text.js";
import { readJsonMaybeIncomplete, writeJsonFile } from "../../lib/fs.js";

// ---------------------------------------------------------------------------
// resolveCommandRequestOrigin
// ---------------------------------------------------------------------------

export function resolveCommandRequestOrigin(
  command: Command,
  payload: Record<string, unknown> | null,
): string {
  const runtimeOrigin = asNonEmptyString(command.runtimeOrigin)?.toLowerCase() ?? "";
  if (runtimeOrigin.includes("chat")) return "chat";
  if (runtimeOrigin.includes("directive")) return "directive";
  if (runtimeOrigin.includes("admin")) return "admin";
  if (runtimeOrigin.includes("autonomous")) return "autonomous";

  const sourceContext = asNonEmptyString(payload?.sourceContext)?.toLowerCase() ?? "";
  if (sourceContext === "chat") return "chat";
  if (sourceContext === "directive" || sourceContext === "director") return "directive";
  if (sourceContext === "admin") return "admin";
  if (sourceContext === "autonomous") return "autonomous";

  if (runtimeOrigin.length > 0) return runtimeOrigin;
  if (sourceContext.length > 0) return sourceContext;
  return "unknown";
}

// ---------------------------------------------------------------------------
// resolveCommandSourceDirectiveId
// ---------------------------------------------------------------------------

export function resolveCommandSourceDirectiveId(input: {
  command: Command;
  payload?: Record<string, unknown> | null;
}): string | null {
  const explicitSourceDirectiveId =
    asNonEmptyString(input.payload?.sourceDirectiveId) ??
    asNonEmptyString(input.command.sourceDirectiveId) ??
    asNonEmptyString(input.command.pendingDirectiveId);
  if (explicitSourceDirectiveId) return explicitSourceDirectiveId;

  const runtimeOrigin =
    asNonEmptyString(input.command.runtimeOrigin)?.trim().toLowerCase() ?? "";
  const isDirectiveRuntimeOrigin =
    runtimeOrigin === "director_directive" ||
    runtimeOrigin === "pending_promotion" ||
    runtimeOrigin === "runtime_resealed";
  if (!isDirectiveRuntimeOrigin) return null;
  return asNonEmptyString(input.command.id) ?? null;
}

// ---------------------------------------------------------------------------
// resolveCommandSourceDirectiveActionNonce
// ---------------------------------------------------------------------------

export function resolveCommandSourceDirectiveActionNonce(input: {
  command: Command;
  payload?: Record<string, unknown> | null;
}): string | null {
  return (
    asNonEmptyString(input.payload?.sourceDirectiveActionNonce) ??
    asNonEmptyString(input.command.actionNonce) ??
    null
  );
}

// ---------------------------------------------------------------------------
// classifyMediaGenerationDeferral
// ---------------------------------------------------------------------------

export function classifyMediaGenerationDeferral(input: {
  error: unknown;
  hasPrompt?: boolean;
}): MediaGenerationDeferralDecision {
  if (!(input.error instanceof Error)) {
    return {
      shouldRequeue: false,
      reason: null,
      reasonCode: null,
      personaSlug: null,
      imageGeneratorSetupRequired: false,
    };
  }
  const rawMessage = input.error.message.trim();
  const loweredMessage = rawMessage.toLowerCase();
  if (loweredMessage.includes("no_media_url_without_generation_activity")) {
    return {
      shouldRequeue: false,
      reason: null,
      reasonCode: null,
      personaSlug: null,
      imageGeneratorSetupRequired: false,
    };
  }
  const personaMatch = PERSONA_REFERENCE_SETUP_REQUIRED_PATTERN.exec(rawMessage);
  if (personaMatch?.[1]) {
    const personaSlug = personaMatch[1].trim().toLowerCase();
    return {
      shouldRequeue: true,
      reason: `persona_reference_setup_required:${personaSlug}`,
      reasonCode: "persona_reference_setup_required",
      personaSlug,
      imageGeneratorSetupRequired: false,
    };
  }
  if (IMAGE_GENERATION_SETUP_REQUIRED_PATTERN.test(rawMessage)) {
    return {
      shouldRequeue: true,
      reason: "image_generation_setup_required",
      reasonCode: "image_generation_setup_required",
      personaSlug: null,
      imageGeneratorSetupRequired: true,
    };
  }
  const hasPrompt = input.hasPrompt !== false;
  if (hasPrompt && MEDIA_GENERATION_OUTPUT_UNAVAILABLE_PATTERN.test(loweredMessage)) {
    const normalizedReason =
      loweredMessage.includes("no_media_url")
        ? "no_media_url"
        : loweredMessage.includes("chat_delivery_media_url_invalid")
          ? "chat_delivery_media_url_invalid"
          : loweredMessage.includes("unsupported_media_payload_mime:")
            ? "unsupported_media_payload_mime"
            : loweredMessage.includes("invalid_data_uri")
              ? "invalid_data_uri"
              : loweredMessage.includes("media_source_empty") ||
                  loweredMessage.includes("empty media data")
                ? "media_source_empty"
                : loweredMessage.includes("only image and video uploads are supported")
                  ? "upload_only_image_video"
                  : "media_output_unavailable";
    const nonRetryableOutputReason =
      normalizedReason === "unsupported_media_payload_mime" ||
      normalizedReason === "upload_only_image_video";
    if (nonRetryableOutputReason) {
      return {
        shouldRequeue: false,
        reason: null,
        reasonCode: null,
        personaSlug: null,
        imageGeneratorSetupRequired: false,
      };
    }
    return {
      shouldRequeue: true,
      reason: `media_generation_waiting_for_output:${normalizedReason}`,
      reasonCode: "media_generation_output_unavailable",
      personaSlug: null,
      imageGeneratorSetupRequired: false,
    };
  }
  return {
    shouldRequeue: false,
    reason: null,
    reasonCode: null,
    personaSlug: null,
    imageGeneratorSetupRequired: false,
  };
}

// ---------------------------------------------------------------------------
// didMediaGenerationProduceActivity
// ---------------------------------------------------------------------------

export function didMediaGenerationProduceActivity(
  payload: unknown,
  extractMediaGeneratorContextId: (payload: unknown) => string | null,
  extractMediaGeneratorContextRecord: (payload: unknown) => Record<string, unknown> | null,
): boolean {
  const contextId = extractMediaGeneratorContextId(payload);
  if (contextId) return true;
  const context = extractMediaGeneratorContextRecord(payload);
  const hasArrayEntries = (value: unknown): boolean => toUnknownArray(value).length > 0;
  const hasUrlSignals = (value: Record<string, unknown>): boolean =>
    Boolean(
      asNonEmptyString(value.outputPath) ??
        asNonEmptyString(value.savedOutputPath) ??
        asNonEmptyString(value.latestOutputPath) ??
        asNonEmptyString(value.lastOutputPath) ??
        asNonEmptyString(value.url) ??
        asNonEmptyString(value.mediaUrl) ??
        asNonEmptyString(value.outputUrl) ??
        asNonEmptyString(value.downloadUrl),
    );
  if (context) {
    if (asNonEmptyString(context.status)) return true;
    if (
      hasArrayEntries(context.streamEvents) ||
      hasArrayEntries(context.savedFiles) ||
      hasArrayEntries(context.observedOutputFiles)
    ) {
      return true;
    }
    if (hasUrlSignals(context)) return true;
  }
  if (isRecord(payload)) {
    if (asNonEmptyString(payload.status)) return true;
    if (
      hasArrayEntries(payload.streamEvents) ||
      hasArrayEntries(payload.savedFiles) ||
      hasArrayEntries(payload.observedOutputFiles)
    ) {
      return true;
    }
    if (hasUrlSignals(payload)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// resolvePendingDirectiveTerminalStatus
// ---------------------------------------------------------------------------

export function resolvePendingDirectiveTerminalStatus(
  outcome: CommandOutcome | null,
): "completed" | "permission_denied" | "no_executable_draft" | "max_retry_exceeded" {
  if (!outcome || outcome.ok) return "completed";
  const errorCode = asNonEmptyString(outcome.error?.code)?.toLowerCase() ?? "";
  const errorMessage = asNonEmptyString(outcome.error?.message)?.toLowerCase() ?? "";
  if (
    errorCode.includes("permission_denied") ||
    errorCode.includes("not_granted") ||
    errorMessage.includes("permission denied") ||
    errorMessage.includes("not_granted")
  ) {
    return "permission_denied";
  }
  if (
    errorCode.includes("no_executable_draft") ||
    errorMessage.includes("no executable draft") ||
    errorMessage.includes("unable to generate drafts")
  ) {
    return "no_executable_draft";
  }
  if (
    errorCode.includes("max_retry") ||
    errorMessage.includes("max retry")
  ) {
    return "max_retry_exceeded";
  }
  return "no_executable_draft";
}

// ---------------------------------------------------------------------------
// resolvePendingDirectiveFilePath
// ---------------------------------------------------------------------------

export async function resolvePendingDirectiveFilePath(
  pendingDirectiveId: string,
  ctx: CommandExecutorContext,
): Promise<string | null> {
  const pendingDir = asNonEmptyString(ctx.ipcPaths.pendingDir);
  if (!pendingDir) return null;
  const exactPath = path.join(pendingDir, `${pendingDirectiveId}.json`);
  const exactExists = await fs
    .access(exactPath)
    .then(() => true)
    .catch(() => false);
  if (exactExists) return exactPath;

  const entries = await fs.readdir(pendingDir).catch(() => []);
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const candidatePath = path.join(pendingDir, entry);
    if (path.basename(entry, ".json") === pendingDirectiveId) {
      return candidatePath;
    }
    const parsed = await readJsonMaybeIncomplete(candidatePath);
    if (parsed.status !== "ok" || !isRecord(parsed.value)) continue;
    const candidateId = asNonEmptyString(parsed.value.id);
    if (candidateId === pendingDirectiveId) {
      return candidatePath;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// updatePendingDirectiveStatusForOutcome
// ---------------------------------------------------------------------------

export async function updatePendingDirectiveStatusForOutcome(
  command: Command,
  outcome: CommandOutcome | null,
  ctx: CommandExecutorContext,
): Promise<void> {
  const pendingDirectiveId = asNonEmptyString(command.pendingDirectiveId);
  if (!pendingDirectiveId) return;
  const pendingPath = await resolvePendingDirectiveFilePath(pendingDirectiveId, ctx);
  if (!pendingPath) return;
  const pendingRaw = await readJsonMaybeIncomplete(pendingPath);
  if (pendingRaw.status !== "ok" || !isRecord(pendingRaw.value)) return;

  const pendingDoc: Record<string, unknown> = {
    ...pendingRaw.value,
  };
  const payload = isRecord(command.payload) ? command.payload : null;
  const sourceDirectiveId = resolveCommandSourceDirectiveId({
    command,
    payload,
  });
  const status = resolvePendingDirectiveTerminalStatus(outcome);
  const updatedAt = nowIso();
  pendingDoc.status = status;
  pendingDoc.updatedAt = updatedAt;
  pendingDoc.lastRuntimeOutcome = {
    at: updatedAt,
    commandId: command.id,
    sourceDirectiveId,
    pendingDirectiveId,
    ok: !outcome || outcome.ok,
    error: outcome && !outcome.ok ? outcome.error?.message ?? null : null,
    code: outcome && !outcome.ok ? outcome.error?.code ?? null : null,
  };
  if (status === "permission_denied") {
    pendingDoc.permissionDenied = true;
  } else if ("permissionDenied" in pendingDoc) {
    delete pendingDoc.permissionDenied;
  }
  if (status === "completed") {
    pendingDoc.completedAt = updatedAt;
  } else if ("completedAt" in pendingDoc) {
    delete pendingDoc.completedAt;
  }
  await writeJsonFile(pendingPath, pendingDoc).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// isDirectiveContextLinkedCommand
// ---------------------------------------------------------------------------

export function isDirectiveContextLinkedCommand(command: Command): boolean {
  if (
    resolveCommandSourceDirectiveId({
      command,
      payload: isRecord(command.payload) ? command.payload : null,
    })
  ) {
    return true;
  }
  if (asNonEmptyString(command.pendingDirectiveId)) return true;
  const runtimeOrigin =
    asNonEmptyString(command.runtimeOrigin)?.toLowerCase() ?? "";
  return (
    runtimeOrigin === "director_directive" ||
    runtimeOrigin === "pending_promotion" ||
    runtimeOrigin === "runtime_resealed"
  );
}

// ---------------------------------------------------------------------------
// resolveEngagementActionForCommand
// ---------------------------------------------------------------------------

export function resolveEngagementActionForCommand(
  command: Command,
  resolveEnforcedDraftAction?: (payload: Record<string, unknown>) => "comment" | "like" | "repost" | null,
): "comment" | "like" | "repost" | null {
  const kind = command.kind.trim().toLowerCase();
  if (kind === "write.commentpost" || kind === "write.comment") return "comment";
  if (kind === "write.votepost" || kind === "write.like") return "like";
  if (kind === "write.repostpost" || kind === "write.repost") return "repost";
  if (kind === "brain.generateandqueue" || kind === "brain.plan") {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) return null;
    // TODO: wire via callback
    const enforced = resolveEnforcedDraftAction?.(payload) ?? null;
    return enforced ?? null;
  }
  return null;
}
