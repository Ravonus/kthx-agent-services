/**
 * RuntimeContext: central shared state for the agent runtime.
 *
 * Replaces the ~70 mutable `let` variables from the original main() closure
 * (agent-runtime.mjs lines 3808-4036). Each variable group is typed and
 * collected into sub-objects so manager classes can declare narrow
 * dependencies instead of importing the whole context.
 */

import crypto from "node:crypto";
import type { RuntimeConfig } from "./types/config.js";
import type { KthxConfig } from "./types/config.js";
import type { IpcPaths } from "./types/ipc.js";
import type { MemoryStore } from "./memory/store.js";
import type { DebugSnapshot } from "./debug/ws-state.js";
import { createDebugSnapshot, createWsTrackingState } from "./debug/ws-state.js";
import type { WsTrackingState } from "./debug/ws-state.js";
import type { GrantState } from "./types/grant.js";
import type { createWSClient, createTRPCClient } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";

// ---------------------------------------------------------------------------
// Manager interfaces (forward declarations to avoid circular deps)
// ---------------------------------------------------------------------------

export interface AuthManagerLike {
  handleUnauthorized(reason?: string): Promise<void>;
  refreshIfNeeded(): Promise<void>;
  getAuthStateValue(): string;
  dispose(): void;
}

export interface MintManagerLike {
  attemptMint(reason?: string): Promise<void>;
  cancelActiveMint(): void;
  dispose(): void;
}

export interface GrantManagerLike {
  setActiveGrant(grant: GrantState | null): void;
  getActiveGrant(): GrantState | null;
  consumeAction(actionKey: string): boolean;
  isGrantExpired(): boolean;
  dispose(): void;
}

export interface SubscriptionManagerLike {
  subscribeUserTopics(): Promise<void>;
  subscribePublicTopics(): Promise<void>;
  requestResync(reason: string): void;
  userSubscriptionsReady(): boolean;
  dispose(): void;
}

export interface DirectiveManagerLike {
  intake(payload: unknown): Promise<void>;
  promoteFromPending(): Promise<void>;
  handleDirective: ((payload: unknown) => Promise<void>) | null;
  dispose(): void;
}

export interface QueueManagerLike {
  enqueue(item: unknown): Promise<void>;
  runnerTick(): Promise<void>;
  setRunnerEnabled(enabled: boolean): void;
  isRunnerEnabled(): boolean;
  dispose(): void;
}

export interface OpenClawManagerLike {
  resolveAgentName(): Promise<string | null>;
  prompt(
    input: string,
    opts?: {
      purpose?: string;
      onTextDelta?: ((delta: string) => void) | null;
    },
  ): Promise<OpenClawPromptResultLike | null>;
  scheduleWake(reasons: string[]): void;
  wakeFromEnvelope(envelope: unknown): Promise<void>;
  createAgent(opts: {
    agentName: string;
    source?: string;
  }): Promise<{ ok: boolean; error?: string; agentName?: string; stdout?: string }>;
  dispose(): void;
}

export interface OpenClawPromptResultLike {
  parsed: unknown;
  raw: string;
  agentName: string | null;
  payloadText: string | null;
  envelope: Record<string, unknown> | null;
}

export interface ChatManagerLike {
  pollInbox(): Promise<void>;
  dispose(): void;
}

export interface ConsoleManagerLike {
  start(): void;
  dispose(): void;
}

export interface EventsManagerLike {
  appendEvent(event: unknown): Promise<void>;
  getLineCount(): number;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Auth tracking state
// ---------------------------------------------------------------------------

export interface AuthTrackingState {
  authRefreshInFlight: boolean;
  lastAuthRefreshAtMs: number;
  unauthorizedStreak: number;
  lastUnauthorizedAtMs: number;
}

// ---------------------------------------------------------------------------
// Mint tracking state
// ---------------------------------------------------------------------------

export interface MintTrackingState {
  nextMintAttemptAtMs: number;
  mintFailureStreak: number;
  lastMintFailureAtIso: string | null;
  lastMintFailureMessage: string | null;
  mintManualRetryRequired: boolean;
  mintManualRetryReason: string | null;
  lastMintManualWaitLogAtMs: number;
  runtimeMintTokenTtlSeconds: number;
  runtimeMintMaxUses: number | null;
  mintInFlightPromise: Promise<void> | null;
  activeMintChallengeId: string | null;
  activeMintPromptToken: string | null;
  activeMintReason: string | null;
  mintAttemptSerial: number;
  lastMintJoinLogAtMs: number;
}

// ---------------------------------------------------------------------------
// Directive tracking state
// ---------------------------------------------------------------------------

export interface DirectiveTrackingState {
  pendingDirectives: unknown[];
  pendingPromotionPromise: Promise<void> | null;
  lastPendingPromotionAtMs: number;
  autoEnqueueMutation: Promise<void>;
  seenDirectiveNoncesById: Map<string, Set<string>>;
  completedDirectiveAcksById: Map<string, Map<string, unknown>>;
  directiveNonceById: Map<string, string>;
  directiveQueue: Promise<void>;
}

// ---------------------------------------------------------------------------
// Queue tracking state
// ---------------------------------------------------------------------------

export interface QueueTrackingState {
  queueRunnerEnabled: boolean;
  queueRunnerTickInFlight: boolean;
  queueStateMutation: Promise<void>;
}

// ---------------------------------------------------------------------------
// Chat tracking state
// ---------------------------------------------------------------------------

export interface ChatTrackingState {
  chatInboxPollInFlight: boolean;
  chatInboxCursorInitialized: boolean;
  chatInboxReadOffset: number;
  chatInboxPartialLine: string;
  chatRuntimeStateDirty: boolean;
  chatRuntimeStateWriteAtMs: number;
  chatReplyThrottleUntilMs: number;
  chatSeenMessageIds: Set<string>;
  chatSeenMessageIdQueue: string[];
  chatMentionTokensCache: string[];
  chatMentionTokensCachedAtMs: number;
}

// ---------------------------------------------------------------------------
// OpenClaw tracking state
// ---------------------------------------------------------------------------

export interface OpenClawTrackingState {
  openClawWakeUrl: string | null;
  openClawWakeKey: string | null;
  openClawWakeReasonSet: Set<string> | null;
  resolvedOpenClawAgentName: string | null;
  openClawAgentResolvedAtMs: number;
  openClawDraftCache: Map<string, unknown>;
}

// ---------------------------------------------------------------------------
// Misc runtime state
// ---------------------------------------------------------------------------

export interface MiscRuntimeState {
  controlKey: string | null;
  lastWsOpenTransitionAtMs: number;
  subscriptionResyncRequested: boolean;
  subscriptionResyncReason: string | null;
  lastSubscriptionResyncAtMs: number;
  lastSubscriptionRefreshAtMs: number;
  autoRetryPendingRunning: boolean;
  lastAutoRetryPendingAtMs: number;
  autoRetryPendingInvoker: string | null;
  lastTerminalAttentionAtMs: number;
  lastTerminalAttentionSignature: string;
  recentGrantRequestAtMsBySignature: Map<string, number>;
  terminalPromptQueue: Promise<void>;
  terminalPromptDepth: number;
  terminalPromptContext: unknown;
  eventsPersistQueue: Promise<void>;
  eventsLineCount: number;
  lastEnvelopeAt: string | null;
}

// ---------------------------------------------------------------------------
// Command seal state
// ---------------------------------------------------------------------------

export interface CommandSealState {
  runtimeCommandSessionId: string;
  runtimeCommandSealKey: string;
  runtimeIssuedCommandIds: Set<string>;
  runtimeConsumedCommandIds: Set<string>;
}

// ---------------------------------------------------------------------------
// RuntimeContext
// ---------------------------------------------------------------------------

export class RuntimeContext {
  // Core
  readonly config: RuntimeConfig;
  kthxConfig: KthxConfig;
  readonly memory: MemoryStore;
  readonly ipcPaths: IpcPaths;

  // WS / tRPC
  wsClient: ReturnType<typeof createWSClient> | null = null;
  trpc: ReturnType<typeof createTRPCClient<AnyRouter>> | null = null;

  // Debug
  readonly debugSnapshot: DebugSnapshot;

  // Tracking sub-objects
  readonly ws: WsTrackingState;
  readonly auth: AuthTrackingState;
  readonly mint: MintTrackingState;
  readonly directive: DirectiveTrackingState;
  readonly queue: QueueTrackingState;
  readonly chat: ChatTrackingState;
  readonly openclaw: OpenClawTrackingState;
  readonly misc: MiscRuntimeState;
  readonly commandSeal: CommandSealState;

  // Hash collector (returns RuntimeHashManifest | null)
  collectRuntimeHashes: (() => Promise<unknown>) | null = null;

  // Manager references (set after construction during bootstrap)
  authManager: AuthManagerLike | null = null;
  mintManager: MintManagerLike | null = null;
  grantManager: GrantManagerLike | null = null;
  subscriptionManager: SubscriptionManagerLike | null = null;
  directiveManager: DirectiveManagerLike | null = null;
  queueManager: QueueManagerLike | null = null;
  openClawManager: OpenClawManagerLike | null = null;
  chatManager: ChatManagerLike | null = null;
  consoleManager: ConsoleManagerLike | null = null;
  eventsManager: EventsManagerLike | null = null;

  constructor(deps: {
    config: RuntimeConfig;
    kthxConfig: KthxConfig;
    memory: MemoryStore;
    ipcPaths: IpcPaths;
  }) {
    this.config = deps.config;
    this.kthxConfig = deps.kthxConfig;
    this.memory = deps.memory;
    this.ipcPaths = deps.ipcPaths;

    this.debugSnapshot = createDebugSnapshot();
    this.ws = createWsTrackingState();

    this.auth = {
      authRefreshInFlight: false,
      lastAuthRefreshAtMs: 0,
      unauthorizedStreak: 0,
      lastUnauthorizedAtMs: 0,
    };

    this.mint = {
      nextMintAttemptAtMs: 0,
      mintFailureStreak: 0,
      lastMintFailureAtIso: null,
      lastMintFailureMessage: null,
      mintManualRetryRequired: false,
      mintManualRetryReason: null,
      lastMintManualWaitLogAtMs: 0,
      runtimeMintTokenTtlSeconds: deps.config.botSessionTokenTtlSeconds,
      runtimeMintMaxUses: deps.config.botSessionMaxUses,
      mintInFlightPromise: null,
      activeMintChallengeId: null,
      activeMintPromptToken: null,
      activeMintReason: null,
      mintAttemptSerial: 0,
      lastMintJoinLogAtMs: 0,
    };

    this.directive = {
      pendingDirectives: [],
      pendingPromotionPromise: null,
      lastPendingPromotionAtMs: 0,
      autoEnqueueMutation: Promise.resolve(),
      seenDirectiveNoncesById: new Map(),
      completedDirectiveAcksById: new Map(),
      directiveNonceById: new Map(),
      directiveQueue: Promise.resolve(),
    };

    this.queue = {
      queueRunnerEnabled: false,
      queueRunnerTickInFlight: false,
      queueStateMutation: Promise.resolve(),
    };

    this.chat = {
      chatInboxPollInFlight: false,
      chatInboxCursorInitialized: false,
      chatInboxReadOffset: 0,
      chatInboxPartialLine: "",
      chatRuntimeStateDirty: false,
      chatRuntimeStateWriteAtMs: 0,
      chatReplyThrottleUntilMs: 0,
      chatSeenMessageIds: new Set(),
      chatSeenMessageIdQueue: [],
      chatMentionTokensCache: [],
      chatMentionTokensCachedAtMs: 0,
    };

    this.openclaw = {
      openClawWakeUrl: null,
      openClawWakeKey: null,
      openClawWakeReasonSet: null,
      resolvedOpenClawAgentName: null,
      openClawAgentResolvedAtMs: 0,
      openClawDraftCache: new Map(),
    };

    this.misc = {
      controlKey: null,
      lastWsOpenTransitionAtMs: 0,
      subscriptionResyncRequested: false,
      subscriptionResyncReason: null,
      lastSubscriptionResyncAtMs: 0,
      lastSubscriptionRefreshAtMs: 0,
      autoRetryPendingRunning: false,
      lastAutoRetryPendingAtMs: 0,
      autoRetryPendingInvoker: null,
      lastTerminalAttentionAtMs: 0,
      lastTerminalAttentionSignature: "",
      recentGrantRequestAtMsBySignature: new Map(),
      terminalPromptQueue: Promise.resolve(),
      terminalPromptDepth: 0,
      terminalPromptContext: null,
      eventsPersistQueue: Promise.resolve(),
      eventsLineCount: 0,
      lastEnvelopeAt: null,
    };

    this.commandSeal = {
      runtimeCommandSessionId: crypto.randomUUID(),
      runtimeCommandSealKey: crypto.randomBytes(32).toString("hex"),
      runtimeIssuedCommandIds: new Set(),
      runtimeConsumedCommandIds: new Set(),
    };
  }

  // ---------------------------------------------------------------------------
  // Convenience: WsStateContext adapter (used by debug/ws-state.ts)
  // ---------------------------------------------------------------------------

  get wsStateContext() {
    return {
      ws: this.ws,
      config: { wsActivityStaleMs: this.config.wsActivityStaleMs },
      ipcPaths: this.ipcPaths,
      debugSnapshot: this.debugSnapshot,
    };
  }
}
