import type {
  Command,
  CommandOutcome,
  CuratedCommentBody,
  EngagementDecision,
  EngagementTargetCandidate,
} from "../types.js";

export type ActionTarget = {
  postId: number;
  commentId: number | null;
  targetHash: string;
};

type BeginLifecycleResult = { allowed: boolean; reason: string; requeue: boolean };

type ActionLifecycleInput = {
  command: Command;
  action: "comment" | "like" | "repost";
  idempotencyKey: string;
  target: ActionTarget;
  state: "context_ready" | "action_running" | "acked" | "requeue" | "failed";
  lastError?: string | null;
};

export type ExecuteWriteEngagementRuntime = {
  ctx: {
    memory: {
      recordWrite(entry: unknown): Promise<void>;
    };
  };
  agent: () => {
    commentPost: { mutate(input: Record<string, unknown>): Promise<unknown> };
    votePost: { mutate(input: Record<string, unknown>): Promise<unknown> };
    repostPost: { mutate(input: Record<string, unknown>): Promise<unknown> };
  };
  failedOutcome: (
    command: Command,
    message: string,
    code?: string,
  ) => CommandOutcome;
  successOutcome: (command: Command, data: unknown) => CommandOutcome;
  resolveEngagementTargetForDirective: (input: {
    payload: Record<string, unknown>;
    action: "comment" | "like" | "repost";
    commandId: string;
  }) => Promise<EngagementTargetCandidate | null>;
  isNoTargetDiscoveryFailure: (error: unknown) => boolean;
  buildActionIdempotencyKey: (input: {
    command: Command;
    action: "comment" | "like" | "repost";
    postId: number;
    commentId: number | null;
    commentBody?: string | null;
  }) => string;
  beginActionLifecycle: (input: {
    command: Command;
    action: "comment" | "like" | "repost";
    idempotencyKey: string;
    target: ActionTarget;
    state: "context_ready" | "action_running" | "acked" | "requeue" | "failed";
  }) => BeginLifecycleResult;
  preflightGrantForAction: (input: {
    command: Command;
    payload: Record<string, unknown>;
    action: "comment" | "like" | "repost";
    lifecycle: {
      idempotencyKey: string;
      target: ActionTarget;
    };
  }) => Promise<string | null>;
  resolveCommandSourceDirectiveId: (input: {
    command: Command;
    payload?: Record<string, unknown> | null;
  }) => string | null;
  curateCommentBodyWithOpenClaw: (input: {
    command: Command;
    payload: Record<string, unknown>;
    postId: number;
    parentId: number | null;
    body: string;
    targetHash: string;
    lifecycleIdempotencyKey: string;
  }) => Promise<CuratedCommentBody>;
  evaluateEngagementActionWithOpenClaw: (input: {
    command: Command;
    action: "like" | "repost";
    postId: number;
    payload: Record<string, unknown>;
    targetHash: string;
    lifecycleIdempotencyKey: string;
  }) => Promise<EngagementDecision>;
  updateActionLifecycle: (input: ActionLifecycleInput) => void;
  isOwnerCapabilityDeniedError: (error: unknown) => boolean;
  registerOwnerCapabilityCooldown: (input: {
    action: "comment" | "like" | "repost";
    targetHash: string;
    reason: string;
  }) => void;
};
