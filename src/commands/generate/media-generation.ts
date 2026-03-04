import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { parseJsonFromMixedText } from "../../lib/parsing.js";
import { ensureDir } from "../../lib/fs.js";
import { isRecord } from "../../lib/guards.js";
import { nowIso } from "../../lib/text.js";
import { RequeueCommandError } from "../types.js";
import { REQUIRED_PERSONA_REFERENCE_FRAME_COUNT } from "../constants.js";
import type {
  Command,
  CommandExecutorContext,
  CuratedMediaPromptCacheEntry,
  GeneratedAssetType,
  MediaGenerationDeferralDecision,
  MediaGenerationProgress,
  PersonaReferenceResolution,
  ResolvedMediaUpload,
} from "../types.js";
import {
  asNonEmptyString,
  constrainGifPromptTo256,
  isMissingFileError,
  outputExtensionForGeneratedAssetType,
  stripEmptyFilesFlag,
  truncateText,
} from "../helpers.js";

type GenerateMediaPromptOptions = {
  generatedAssetType?: GeneratedAssetType;
  mode?: string;
  referenceInputs?: string[];
  maxReferenceInputs?: number;
  keepOriginal?: boolean;
  commandId?: string | null;
  skipPromptCuration?: boolean;
  onProgress?: ((progress: MediaGenerationProgress) => Promise<void> | void) | undefined;
};

type ResolveMediaUploadInput = {
  payload: Record<string, unknown>;
  keepOriginal?: boolean;
  promptFallbacks: Array<string | null>;
  command?: Command;
  skipPromptCuration?: boolean;
};

type RunMediaGeneratorInput = {
  prompt: string;
  generatedAssetType: GeneratedAssetType;
  requestDir: string;
  referenceFiles: string[];
  timeoutMs: number;
  stream: boolean;
  onProgress?: ((progress: MediaGenerationProgress) => Promise<void> | void) | undefined;
};

type ShellCommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  error: string | null;
  timedOut: boolean;
};

export type MediaGenerationRuntime = {
  ctx: CommandExecutorContext;
  curatedMediaPromptCache: Map<string, CuratedMediaPromptCacheEntry>;
  pruneCuratedPromptCaches: () => void;
  buildCuratedMediaPromptCacheKey: (input: {
    commandId: string;
    sourcePrompt: string;
    generatedAssetType: GeneratedAssetType;
    mode: string;
  }) => string;
  curateMediaPromptWithOpenClaw: (input: {
    sourcePrompt: string;
    generatedAssetType: GeneratedAssetType;
    mode: string;
  }) => Promise<string>;
  materializeMediaReferenceFiles: (input: {
    requestDir: string;
    referenceInputs: string[];
    maxReferenceInputs?: number;
  }) => Promise<string[]>;
  runMediaGeneratorViaHttp: (input: RunMediaGeneratorInput) => Promise<{ payload: unknown; timedOut: boolean } | null>;
  runShellCommand: (command: string, extraEnv: Record<string, string>) => Promise<ShellCommandResult>;
  didMediaGenerationProduceActivity: (payload: unknown) => boolean;
  resolveGeneratedMediaSourceWithRetry: (input: {
    requestDir: string;
    outputPath: string;
    stdout: string;
    maxWaitMs: number;
    requireFinalStreamFrame?: boolean;
  }) => Promise<string | null>;
  uploadResolvedMediaSource: (source: string, options?: { keepOriginal?: boolean }) => Promise<ResolvedMediaUpload>;
  isDirectiveContextLinkedCommand: (command: Command) => boolean;
  recordCommandLifecycleCheckpoint: (input: {
    command: Command;
    stage: "queued" | "executing" | "generated" | "uploaded" | "published" | "completed";
    status?: "ok" | "failed";
    message?: string | null;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
  collectMediaReferenceInputs: (
    payload: Record<string, unknown>,
    options?: {
      includeRecentGeneratedAsset?: boolean;
    },
  ) => string[];
  resolvePersonaFrameReferences: (input: {
    payload: Record<string, unknown>;
    command: Command;
    fallbackReferenceInputs: string[];
  }) => Promise<PersonaReferenceResolution>;
  resolveGeneratedAssetType: (value: unknown) => GeneratedAssetType;
  generateAndUploadMediaFromPrompt: (
    prompt: string,
    opts?: GenerateMediaPromptOptions,
  ) => Promise<ResolvedMediaUpload>;
  classifyMediaGenerationDeferral: (input: {
    error: unknown;
    hasPrompt?: boolean;
  }) => MediaGenerationDeferralDecision;
};

export async function resolveMediaUpload(
  this: MediaGenerationRuntime,
  input: ResolveMediaUploadInput,
): Promise<ResolvedMediaUpload> {
  const keepOriginal = input.keepOriginal === true;

  const isRecoverableMediaSourceFailure = (error: unknown): boolean => {
    if (!(error instanceof Error)) return false;
    const message = error.message.trim().toLowerCase();
    return (
      message.includes("only image and video uploads are supported") ||
      message.includes("unsupported_media_payload_mime:") ||
      message.includes("invalid data uri") ||
      message.includes("invalid_data_uri") ||
      message.includes("empty media data") ||
      message.includes("media_source_empty") ||
      message.includes("no_media_url")
    );
  };

  const tryUploadSource = async (
    source: string,
    sourceKey: string,
  ): Promise<ResolvedMediaUpload | null> => {
    try {
      return await this.uploadResolvedMediaSource(source, { keepOriginal });
    } catch (error: unknown) {
      if (!isRecoverableMediaSourceFailure(error)) {
        throw error;
      }
      if (input.command) {
        await this.ctx.memory
          .recordWrite({
            type: "media_source_skipped",
            at: nowIso(),
            commandId: input.command.id,
            source: sourceKey,
            error: error instanceof Error ? error.message : String(error),
          })
          .catch(() => undefined);
      }
      return null;
    }
  };

  const payload = input.payload;
  const skipPromptCuration =
    input.skipPromptCuration === true ||
    (input.command ? this.isDirectiveContextLinkedCommand(input.command) : false);

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
    const resolved = await tryUploadSource(existingMediaUrl, "payload.mediaUrl");
    if (resolved) return markUploaded(resolved, "payload.mediaUrl");
  }

  const mediaItems = Array.isArray(payload.mediaItems) ? payload.mediaItems : [];
  for (let index = 0; index < mediaItems.length; index += 1) {
    const mediaItem = mediaItems[index];
    if (!isRecord(mediaItem)) continue;
    const mediaUrl = asNonEmptyString(mediaItem.mediaUrl);
    if (mediaUrl) {
      const resolved = await tryUploadSource(
        mediaUrl,
        `payload.mediaItems[${index}].mediaUrl`,
      );
      if (resolved) return markUploaded(resolved, "payload.mediaItems");
    }
  }

  const prompt =
    input.promptFallbacks.find(
      (entry) => typeof entry === "string" && entry.trim().length > 0,
    ) ?? null;
  if (!prompt) {
    throw new Error("missing_media_input");
  }

  const fallbackReferenceInputs = this.collectMediaReferenceInputs(payload);
  try {
    let referenceInputs = fallbackReferenceInputs;
    if (input.command) {
      const personaReferences = await this.resolvePersonaFrameReferences({
        payload,
        command: input.command,
        fallbackReferenceInputs,
      });
      if (
        personaReferences.personaSlug !== null &&
        personaReferences.frameReferences.length < REQUIRED_PERSONA_REFERENCE_FRAME_COUNT
      ) {
        throw new Error(
          `persona_reference_setup_required:${personaReferences.personaSlug}`,
        );
      }
      referenceInputs =
        personaReferences.personaSlug !== null
          ? personaReferences.frameReferences
          : fallbackReferenceInputs;
    }

    const requestedGeneratedAssetType = this.resolveGeneratedAssetType(
      payload.generatedAssetType,
    );
    const generatedAssetType =
      requestedGeneratedAssetType === "gif" ? "gif" : "image";
    const generated = await this.generateAndUploadMediaFromPrompt(prompt, {
      generatedAssetType,
      mode: "write_media_generate",
      referenceInputs,
      keepOriginal,
      commandId: input.command?.id ?? null,
      skipPromptCuration,
    });
    return markUploaded(generated, "generated_prompt");
  } catch (error: unknown) {
    if (input.command) {
      const deferred = this.classifyMediaGenerationDeferral({
        error,
        hasPrompt: true,
      });
      if (deferred.shouldRequeue && deferred.reason) {
        const message = error instanceof Error ? error.message : String(error);
        await this.recordCommandLifecycleCheckpoint({
          command: input.command,
          stage: "generated",
          status: "failed",
          message,
          metadata: {
            requeued: true,
            reason: deferred.reason,
            reasonCode: deferred.reasonCode,
            personaSlug: deferred.personaSlug,
            source: "resolve_media_upload",
          },
        });
        await this.ctx.memory
          .recordWrite({
            type: "media_generation_deferred_for_setup",
            at: nowIso(),
            commandId: input.command.id,
            reason: deferred.reason,
            reasonCode: deferred.reasonCode,
            personaSlug: deferred.personaSlug,
            error: message,
          })
          .catch(() => undefined);
        throw new RequeueCommandError(deferred.reason);
      }
    }
    throw error;
  }
}

export async function generateAndUploadMediaFromPrompt(
  this: MediaGenerationRuntime,
  prompt: string,
  opts?: GenerateMediaPromptOptions,
): Promise<ResolvedMediaUpload> {
  const sourcePrompt = prompt.trim();
  if (!sourcePrompt.length) {
    throw new Error("missing_prompt");
  }

  const generatedAssetType = opts?.generatedAssetType ?? "image";
  const mode = opts?.mode ?? "media_generation";
  const streamEnabled = generatedAssetType === "image" && /^chat_/iu.test(mode);
  const commandId = asNonEmptyString(opts?.commandId) ?? null;
  const skipPromptCuration = opts?.skipPromptCuration === true;

  this.pruneCuratedPromptCaches();

  let curatedPromptBase: string;
  if (skipPromptCuration) {
    curatedPromptBase = sourcePrompt;
  } else {
    const cacheKey = commandId
      ? this.buildCuratedMediaPromptCacheKey({
          commandId,
          sourcePrompt,
          generatedAssetType,
          mode,
        })
      : null;
    const cached = cacheKey ? this.curatedMediaPromptCache.get(cacheKey) : null;
    if (cached) {
      curatedPromptBase = cached.prompt;
    } else {
      curatedPromptBase = await this.curateMediaPromptWithOpenClaw({
        sourcePrompt,
        generatedAssetType,
        mode,
      });
      if (cacheKey) {
        this.curatedMediaPromptCache.set(cacheKey, {
          prompt: curatedPromptBase,
          cachedAtMs: Date.now(),
        });
      }
    }
  }

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

  await this.ctx.memory
    .recordWrite({
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
    })
    .catch(() => undefined);

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
    await this.ctx.memory
      .recordWrite({
        type: "image_generation_failed",
        at: nowIso(),
        provider: "command",
        reason: String(reason).slice(0, 600),
      })
      .catch(() => undefined);
    throw new Error(String(reason));
  }

  const parsedGeneratorOutput = parseJsonFromMixedText(execResult.stdout);
  const hadGenerationActivity = this.didMediaGenerationProduceActivity(
    parsedGeneratorOutput,
  );
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
    if (!hadGenerationActivity) {
      throw new Error("no_media_url_without_generation_activity");
    }
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
