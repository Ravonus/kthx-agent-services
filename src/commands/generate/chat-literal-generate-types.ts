import type {
  Command,
  CommandOutcome,
  CommandLifecycleCheckpointStage,
  GeneratedAssetType,
  GeneratedCustomAssetSaveResult,
  GeneratedCustomAssetSaveIntent,
  PersonaReferenceResolution,
  MediaGenerationDeferralDecision,
} from "../types.js";

type MemoryWriter = { recordWrite(entry: unknown): Promise<void> };
type ChatBridgeFn = (input: unknown) => Promise<unknown>;
type RecordCheckpointFn = (input: {
  command: Command;
  stage: CommandLifecycleCheckpointStage;
  status?: "ok" | "failed";
  message?: string | null;
  metadata?: Record<string, unknown>;
}) => Promise<void>;

export type ChatLiteralGenerateDeps = {
  callAgentChatBridge: ChatBridgeFn | null;
  memory: MemoryWriter;
  resolveCommandSourceDirectiveId: (input: {
    command: Command;
    payload: Record<string, unknown>;
  }) => string | null;
  resolveCommandSourceDirectiveActionNonce: (input: {
    command: Command;
    payload: Record<string, unknown>;
  }) => string | null;
  resolveGeneratedAssetType: (value: unknown) => string;
  collectMediaReferenceInputs: (
    payload: Record<string, unknown>,
  ) => string[];
  resolvePersonaFrameReferences: (input: {
    payload: Record<string, unknown>;
    command: Command;
    fallbackReferenceInputs: string[];
  }) => Promise<PersonaReferenceResolution>;
  resolveGeneratedCustomAssetSaveIntent: (
    payload: Record<string, unknown>,
    prompt: string,
  ) => GeneratedCustomAssetSaveIntent | null;
  resolveChatProcessingClientMessageId: (command: Command) => string | null;
  generateAndUploadMediaFromPrompt: (
    prompt: string,
    opts: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  resolveGeneratedAttachmentMimeType: (input: {
    generatedAssetType: GeneratedAssetType;
    mediaUrl: string;
    mediaType?: "image" | "video";
  }) => string;
  recordCommandLifecycleCheckpoint: RecordCheckpointFn;
  saveGeneratedCustomAsset: (input: {
    command: Command;
    payload: Record<string, unknown>;
    intent: GeneratedCustomAssetSaveIntent;
    sourcePrompt: string;
    mediaUrl: string;
    mimeType: string;
    chatTarget: { conversationId?: string; channelId?: string };
  }) => Promise<GeneratedCustomAssetSaveResult | null>;
  updateAvatar: (
    input: Record<string, unknown> & { target: string; imageUrl: string },
  ) => Promise<unknown>;
  updateBanner: (
    input: Record<string, unknown> & { target: string; bannerUrl: string },
  ) => Promise<unknown>;
  classifyMediaGenerationDeferral: (input: {
    error: unknown;
    hasPrompt: boolean;
  }) => MediaGenerationDeferralDecision;
  isStreamPartArtifactReference: (
    value: string | null | undefined,
  ) => boolean;
  failedOutcome: (
    command: Command,
    message: string,
    code?: string,
  ) => CommandOutcome;
  successOutcome: (command: Command, data: unknown) => CommandOutcome;
};
