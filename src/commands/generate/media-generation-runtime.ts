import {
buildCuratedMediaPromptCacheKey as _buildMediaPromptKey,
pruneCuratedPromptCaches as _prunePromptCaches,
} from "../cache/cache.js";
import {
didMediaGenerationProduceActivity as _didMediaActivity,
isDirectiveContextLinkedCommand as _isDirectiveLinked,
} from "../directives/resolution.js";
import { curateMediaPromptWithOpenClaw as _curateMediaPromptWithOC } from "../write/openclaw-curation.js";
import { resolveGeneratedAssetType as _resolveAssetType } from "./custom-asset.js";
import {
extractMediaGeneratorContextId as _extractMediaGenCtxId,
extractMediaGeneratorContextRecord as _extractMediaGenCtxRecord,
} from "./media-curation.js";
import {
materializeMediaReferenceFiles as _materializeMediaRefs,
resolveGeneratedMediaSourceWithRetry as _resolveMediaSourceRetry,
} from "./media-source.js";
import { runShellCommand as _runShellCommand } from "./shell-command.js";

import type {
Command,
CommandExecutorContext,
CommandLifecycleCheckpointStage,
CuratedMediaPromptCacheEntry,
CuratedPostDraftCacheEntry,
MediaGenerationDeferralDecision,
PersonaReferenceResolution,
ResolvedMediaUpload,
} from "../types.js";
import type { MediaGenerationRuntime } from "./media-generation.js";

export type BuildMediaGenerationRuntimeInput = {
  ctx: CommandExecutorContext;
  curatedPostDraftCache: Map<string, CuratedPostDraftCacheEntry>;
  curatedMediaPromptCache: Map<string, CuratedMediaPromptCacheEntry>;
  recordCommandLifecycleCheckpoint: (input: {
    command: Command;
    stage: CommandLifecycleCheckpointStage;
    status?: "ok" | "failed";
    message?: string | null;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
  collectMediaReferenceInputs: MediaGenerationRuntime["collectMediaReferenceInputs"];
  resolvePersonaFrameReferences: (input: {
    payload: Record<string, unknown>;
    command: Command;
    fallbackReferenceInputs: string[];
  }) => Promise<PersonaReferenceResolution>;
  classifyMediaGenerationDeferral: (input: {
    error: unknown;
    hasPrompt?: boolean;
  }) => MediaGenerationDeferralDecision;
  uploadResolvedMediaSource: (
    source: string,
    options?: { keepOriginal?: boolean },
  ) => Promise<ResolvedMediaUpload>;
  runMediaGeneratorViaHttp: MediaGenerationRuntime["runMediaGeneratorViaHttp"];
  generateAndUploadMediaFromPrompt: (
    prompt: string,
    opts?: Parameters<MediaGenerationRuntime["generateAndUploadMediaFromPrompt"]>[1],
  ) => Promise<ResolvedMediaUpload>;
};

export function buildMediaGenerationRuntime(
  input: BuildMediaGenerationRuntimeInput,
): MediaGenerationRuntime {
  return {
    ctx: input.ctx,
    curatedMediaPromptCache: input.curatedMediaPromptCache,
    pruneCuratedPromptCaches: () =>
      _prunePromptCaches(input.curatedPostDraftCache, input.curatedMediaPromptCache),
    buildCuratedMediaPromptCacheKey: (cacheInput) => _buildMediaPromptKey(cacheInput),
    curateMediaPromptWithOpenClaw: (curationInput) =>
      _curateMediaPromptWithOC(
        {
          runOpenClawPrompt: input.ctx.runOpenClawPrompt ?? null,
          memory: input.ctx.memory,
        },
        curationInput,
      ),
    materializeMediaReferenceFiles: (materializeInput) =>
      _materializeMediaRefs(materializeInput),
    runMediaGeneratorViaHttp: (generatorInput) =>
      input.runMediaGeneratorViaHttp(generatorInput),
    runShellCommand: (command, extraEnv) =>
      _runShellCommand(input.ctx.config.imageGenerateTimeoutMs, command, extraEnv),
    didMediaGenerationProduceActivity: (payload) =>
      _didMediaActivity(payload, _extractMediaGenCtxId, _extractMediaGenCtxRecord),
    resolveGeneratedMediaSourceWithRetry: (retryInput) =>
      _resolveMediaSourceRetry(retryInput),
    uploadResolvedMediaSource: (source, options) =>
      input.uploadResolvedMediaSource(source, options),
    isDirectiveContextLinkedCommand: (command) => _isDirectiveLinked(command),
    recordCommandLifecycleCheckpoint: (checkpoint) =>
      input.recordCommandLifecycleCheckpoint({
        ...checkpoint,
        stage: checkpoint.stage as CommandLifecycleCheckpointStage,
      }),
    collectMediaReferenceInputs: (payload, options) =>
      input.collectMediaReferenceInputs(payload, options),
    resolvePersonaFrameReferences: (frameInput) =>
      input.resolvePersonaFrameReferences(frameInput),
    resolveGeneratedAssetType: (value) => _resolveAssetType(value),
    generateAndUploadMediaFromPrompt: (prompt, opts) =>
      input.generateAndUploadMediaFromPrompt(prompt, opts),
    classifyMediaGenerationDeferral: (deferralInput) =>
      input.classifyMediaGenerationDeferral(deferralInput),
  };
}
