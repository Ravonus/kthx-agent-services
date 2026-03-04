import { isRecord } from "../../lib/guards.js";
import {
  asNonEmptyString,
  normalizeAgentProvenanceValue,
} from "../helpers.js";
import type {
  Command,
  CommandOutcome,
  ResolvedMediaUpload,
} from "../types.js";

type ProfileWriteMutation = Record<string, unknown> & {
  target: string;
  imageUrl?: string;
  bannerUrl?: string;
};

type ResolveMediaUploadInput = {
  payload: Record<string, unknown>;
  keepOriginal?: boolean;
  promptFallbacks: Array<string | null>;
  command?: Command;
  skipPromptCuration?: boolean;
};

export type ExecuteWriteProfileRuntime = {
  resolveProfileWriteTarget: (value: string | null | undefined) => "agent" | "owner";
  resolveCommandSourceDirectiveId: (input: {
    command: Command;
    payload?: Record<string, unknown> | null;
  }) => string | null;
  resolveMediaUpload: (input: ResolveMediaUploadInput) => Promise<ResolvedMediaUpload>;
  updateAvatar: (input: Record<string, unknown> & { target: string; imageUrl: string }) => Promise<unknown>;
  updateBanner: (input: Record<string, unknown> & { target: string; bannerUrl: string }) => Promise<unknown>;
  successOutcome: (command: Command, data: unknown) => CommandOutcome;
  failedOutcome: (command: Command, message: string, code?: string) => CommandOutcome;
};

function applyMediaFields(target: ProfileWriteMutation, media: ResolvedMediaUpload): void {
  if (media.mediaOriginalUrl) {
    target.originalUrl = media.mediaOriginalUrl;
  }
  if (media.mediaOptimizedUrl) {
    target.optimizedUrl = media.mediaOptimizedUrl;
  }
  if (media.mediaContentHash) {
    target.contentHash = media.mediaContentHash;
  }
  if (media.mediaIpfsCid) {
    target.ipfsCid = media.mediaIpfsCid;
  }
  if (typeof media.mediaSizeBytes === "number") {
    target.sizeBytes = media.mediaSizeBytes;
  }
}

function applySharedSourceFields(
  target: ProfileWriteMutation,
  command: Command,
  payload: Record<string, unknown>,
  sourceDirectiveId: string | null,
): void {
  const provenance = normalizeAgentProvenanceValue(payload.provenance);
  const sourceDirectiveActionNonce =
    asNonEmptyString(payload.sourceDirectiveActionNonce) ??
    command.actionNonce ??
    null;

  if (provenance) {
    target.provenance = provenance;
  }
  if (sourceDirectiveId) {
    target.sourceDirectiveId = sourceDirectiveId;
  }
  if (sourceDirectiveActionNonce) {
    target.sourceDirectiveActionNonce = sourceDirectiveActionNonce;
  }
}

export async function executeWriteUpdateAvatar(
  this: ExecuteWriteProfileRuntime,
  command: Command,
): Promise<CommandOutcome> {
  const payload = isRecord(command.payload) ? command.payload : null;
  if (!payload) {
    return this.failedOutcome(command, "Invalid payload for write.updateAvatar.");
  }

  const target = this.resolveProfileWriteTarget(asNonEmptyString(payload.target));
  const sourceDirectiveId = this.resolveCommandSourceDirectiveId({
    command,
    payload,
  });
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

  const mutationInput: ProfileWriteMutation = {
    target,
    imageUrl: media.mediaUrl,
  };
  applyMediaFields(mutationInput, media);
  applySharedSourceFields(mutationInput, command, payload, sourceDirectiveId);

  const result = await this.updateAvatar(
    mutationInput as Record<string, unknown> & { target: string; imageUrl: string },
  );
  return this.successOutcome(command, result);
}

export async function executeWriteUpdateBanner(
  this: ExecuteWriteProfileRuntime,
  command: Command,
): Promise<CommandOutcome> {
  const payload = isRecord(command.payload) ? command.payload : null;
  if (!payload) {
    return this.failedOutcome(command, "Invalid payload for write.updateBanner.");
  }

  const target = this.resolveProfileWriteTarget(asNonEmptyString(payload.target));
  const sourceDirectiveId = this.resolveCommandSourceDirectiveId({
    command,
    payload,
  });
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

  const mutationInput: ProfileWriteMutation = {
    target,
    bannerUrl: media.mediaUrl,
  };
  applyMediaFields(mutationInput, media);
  applySharedSourceFields(mutationInput, command, payload, sourceDirectiveId);

  const result = await this.updateBanner(
    mutationInput as Record<string, unknown> & { target: string; bannerUrl: string },
  );
  return this.successOutcome(command, result);
}
