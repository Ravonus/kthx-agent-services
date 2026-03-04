import { buildCreditsPermissionState, buildGrantState, parseGrantCandidatesFromPermissionState } from "./grants/grant-state.js";
import { isRecord } from "./lib/guards.js";
import { nowIso } from "./lib/text.js";
import { normalizePermissionStateEvent } from "./ws/permission-event.js";
import { SubscriptionManager } from "./ws/subscription-manager.js";
import { type PlannerTriggerOptions } from "./main-auto-credit-planner.js";
import { type AuthManager } from "./auth/auth-manager.js";
import { type EventsManager } from "./ipc/events-manager.js";
import { type GrantManager } from "./grants/grant-manager.js";
import { type MemoryStore } from "./memory/store.js";
import { type OpenClawManager } from "./openclaw/openclaw-manager.js";
import { type RuntimeContext } from "./runtime-context.js";

export type EnvelopeSubscriptionDeps = {
  config: {
    subscribeGlobalFeed: boolean;
    subscribeActivityFeed: boolean;
    autoSubscribeLenses: boolean;
    lensRefreshMinMs: number;
    heartbeatIntervalMs: number;
    extraPublicTopics: string[];
    extraUserTopics: string[];
  };
  ctx: RuntimeContext;
  memory: Pick<MemoryStore, "ingest" | "refreshTemporalContext" | "recordWrite">;
  eventsManager: Pick<EventsManager, "appendEvent">;
  grantManager: Pick<GrantManager, "setActiveGrant" | "isGrantExpired" | "persistDirectorGrant" | "persistCreditsGrant">;
  openClawManager: Pick<OpenClawManager, "wakeFromEnvelope">;
  authManager: AuthManager;
  trpc: unknown;
  writeDebugSnapshot: () => Promise<void>;
  markWsActivity: (source: string) => void;
  getAgentKeyBox: () => Promise<string | null>;
  runBackendCall: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  getPlannerTriggers: () => {
    triggerAutoCreditPlanner: ((opts: PlannerTriggerOptions) => void) | null;
    triggerAutoPostingPlanner: ((opts: PlannerTriggerOptions) => void) | null;
  };
};

export const setupEnvelopeAndSubscription = (deps: EnvelopeSubscriptionDeps): void => {
  type SocketBatchState = {
    pendingCount: number;
    notificationCount: number;
    feedCount: number;
    firstQueuedAt: string | null;
    lastQueuedAt: string | null;
    lastEventType: string | null;
    lastTopic: string | null;
    notificationItems: NotificationBatchItem[];
  };
  const socketBatchState: SocketBatchState = {
    pendingCount: 0,
    notificationCount: 0,
    feedCount: 0,
    firstQueuedAt: null,
    lastQueuedAt: null,
    lastEventType: null,
    lastTopic: null,
    notificationItems: [],
  };
  type NotificationBatchItem = {
    at: string;
    topic: string;
    eventType: string | null;
    notificationType: string | null;
    entityType: string | null;
    entityId: number | null;
    postId: number | null;
    commentId: number | null;
    actorHandle: string | null;
    actorMainUserId: string | null;
    readAt: string | null;
  };
  const toFinitePositiveInt = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number.parseInt(value.trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return null;
  };
  const toNonEmptyString = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  const readNested = (
    root: unknown,
    pathSpec: string,
  ): unknown => {
    let cursor: unknown = root;
    for (const key of pathSpec.split(".")) {
      if (!isRecord(cursor)) return null;
      cursor = cursor[key];
    }
    return cursor;
  };
  const readFirstInt = (root: unknown, paths: readonly string[]): number | null => {
    for (const pathSpec of paths) {
      const parsed = toFinitePositiveInt(readNested(root, pathSpec));
      if (parsed) return parsed;
    }
    return null;
  };
  const readFirstString = (
    root: unknown,
    paths: readonly string[],
  ): string | null => {
    for (const pathSpec of paths) {
      const value = toNonEmptyString(readNested(root, pathSpec));
      if (value) return value;
    }
    return null;
  };
  const parseNotificationBatchItem = (input: {
    envelope: { receivedAt: string; topic: string };
    payload: unknown;
    eventType: string;
  }): NotificationBatchItem | null => {
    if (!isRecord(input.payload)) return null;
    const payload = input.payload;
    const entityType =
      readFirstString(payload, [
        "entityType",
        "targetType",
        "notification.entityType",
        "payload.entityType",
      ])?.toLowerCase() ?? null;
    const entityId = readFirstInt(payload, [
      "entityId",
      "targetId",
      "notification.entityId",
      "payload.entityId",
      "payload.targetId",
    ]);
    const postId =
      readFirstInt(payload, [
        "postId",
        "targetPostId",
        "notification.postId",
        "payload.postId",
        "payload.targetPostId",
        "post.id",
        "target.postId",
        "target.post.id",
        "comment.postId",
      ]) ??
      (entityType === "post" ? entityId : null);
    const commentId =
      readFirstInt(payload, [
        "commentId",
        "targetCommentId",
        "parentId",
        "notification.commentId",
        "payload.commentId",
        "payload.targetCommentId",
        "payload.parentId",
        "comment.id",
        "target.commentId",
        "target.comment.id",
      ]) ??
      (entityType === "comment" ? entityId : null);
    const actorHandle =
      readFirstString(payload, [
        "actor.handle",
        "actor.username",
        "author.handle",
        "author.username",
        "from.handle",
        "from.username",
      ]) ?? null;
    const actorMainUserId =
      readFirstString(payload, [
        "actor.mainUserId",
        "author.mainUserId",
        "from.mainUserId",
        "actorMainUserId",
      ]) ?? null;
    const notificationType =
      readFirstString(payload, [
        "notificationType",
        "type",
        "notification.type",
      ]) ?? null;
    const readAt =
      readFirstString(payload, ["readAt", "notification.readAt"]) ?? null;
    return {
      at: input.envelope.receivedAt,
      topic: input.envelope.topic,
      eventType: input.eventType || null,
      notificationType,
      entityType,
      entityId,
      postId,
      commentId,
      actorHandle,
      actorMainUserId,
      readAt,
    };
  };
  let socketBatchFlushInFlight: Promise<void> | null = null;
  const mergeSocketBatch = (
    target: SocketBatchState,
    delta: SocketBatchState,
  ): void => {
    target.pendingCount += delta.pendingCount;
    target.notificationCount += delta.notificationCount;
    target.feedCount += delta.feedCount;
    if (!target.firstQueuedAt) {
      target.firstQueuedAt = delta.firstQueuedAt;
    }
    target.lastQueuedAt = delta.lastQueuedAt ?? target.lastQueuedAt;
    target.lastEventType = delta.lastEventType ?? target.lastEventType;
    target.lastTopic = delta.lastTopic ?? target.lastTopic;
    if (Array.isArray(delta.notificationItems) && delta.notificationItems.length > 0) {
      target.notificationItems.push(...delta.notificationItems);
      if (target.notificationItems.length > 160) {
        target.notificationItems = target.notificationItems.slice(
          target.notificationItems.length - 160,
        );
      }
    }
  };
  const markSocketBatchPending = (
    kind: "notifications" | "feed",
    envelope: {
      receivedAt: string;
      topic: string;
    },
    eventType: string,
    payload?: unknown,
  ): void => {
    socketBatchState.pendingCount += 1;
    if (kind === "notifications") {
      socketBatchState.notificationCount += 1;
      const item = parseNotificationBatchItem({
        envelope,
        payload,
        eventType,
      });
      if (item) {
        socketBatchState.notificationItems.push(item);
        if (socketBatchState.notificationItems.length > 160) {
          socketBatchState.notificationItems = socketBatchState.notificationItems.slice(
            socketBatchState.notificationItems.length - 160,
          );
        }
      }
    } else {
      socketBatchState.feedCount += 1;
    }
    socketBatchState.firstQueuedAt ??= envelope.receivedAt;
    socketBatchState.lastQueuedAt = envelope.receivedAt;
    socketBatchState.lastEventType = eventType || null;
    socketBatchState.lastTopic = envelope.topic;
  };
  const flushSocketBatchForDirective = async (
    trigger: string,
  ): Promise<void> => {
    if (socketBatchFlushInFlight) {
      await socketBatchFlushInFlight;
    }
    if (socketBatchState.pendingCount <= 0) {
      return;
    }

    const snapshot: SocketBatchState = {
      pendingCount: socketBatchState.pendingCount,
      notificationCount: socketBatchState.notificationCount,
      feedCount: socketBatchState.feedCount,
      firstQueuedAt: socketBatchState.firstQueuedAt,
      lastQueuedAt: socketBatchState.lastQueuedAt,
      lastEventType: socketBatchState.lastEventType,
      lastTopic: socketBatchState.lastTopic,
      notificationItems: [...socketBatchState.notificationItems],
    };
    socketBatchState.pendingCount = 0;
    socketBatchState.notificationCount = 0;
    socketBatchState.feedCount = 0;
    socketBatchState.firstQueuedAt = null;
    socketBatchState.lastQueuedAt = null;
    socketBatchState.lastEventType = null;
    socketBatchState.lastTopic = null;
    socketBatchState.notificationItems = [];

    socketBatchFlushInFlight = (async () => {
      try {
        for (const item of snapshot.notificationItems.slice(0, 96)) {
          await deps.memory
            .ingest({
              receivedAt: item.at,
              source: "local",
              topic: "notifications:batch",
              payload: {
                type: "notification_created",
                notificationType: item.notificationType,
                postId: item.postId,
                commentId: item.commentId,
                entityType: item.entityType,
                entityId: item.entityId,
                actor: {
                  handle: item.actorHandle,
                  mainUserId: item.actorMainUserId,
                },
                readAt: item.readAt,
                originTopic: item.topic,
                originEventType: item.eventType,
                source: "socket_batch",
              },
            })
            .catch(() => {});
        }
        await deps.memory
          .refreshTemporalContext({
            force: true,
            allowAgentCompression: false,
          })
          .catch(() => {});
        await deps.memory.recordWrite({
          type: "notifications_buffer_flushed",
          at: nowIso(),
          trigger,
          pendingCount: snapshot.pendingCount,
          notificationEvents: snapshot.notificationCount,
          notificationItems: snapshot.notificationItems.length,
          feedEvents: snapshot.feedCount,
          firstQueuedAt: snapshot.firstQueuedAt,
          lastQueuedAt: snapshot.lastQueuedAt,
          lastEventType: snapshot.lastEventType,
          lastTopic: snapshot.lastTopic,
        });
      } catch (error: unknown) {
        mergeSocketBatch(socketBatchState, snapshot);
        await deps.memory
          .recordWrite({
            type: "notifications_buffer_flush_failed",
            at: nowIso(),
            trigger,
            error: error instanceof Error ? error.message : String(error),
          })
          .catch(() => {});
      } finally {
        socketBatchFlushInFlight = null;
      }
    })();
    await socketBatchFlushInFlight;
  };  const triggerAutoCreditPlanner = (opts: PlannerTriggerOptions): void => {
    deps.getPlannerTriggers().triggerAutoCreditPlanner?.(opts);
  };
  const triggerAutoPostingPlanner = (opts: PlannerTriggerOptions): void => {
    deps.getPlannerTriggers().triggerAutoPostingPlanner?.(opts);
  };


  const handleEnvelope = async (envelope: {
    receivedAt: string;
    source: "user" | "public";
    topic: string;
    payload: unknown;
  }): Promise<void> => {
    deps.ctx.misc.lastEnvelopeAt = envelope.receivedAt;
    deps.ctx.debugSnapshot.lastEnvelopeAt = envelope.receivedAt;

    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    const eventType =
      typeof payload.type === "string" ? (payload.type as string) : "";

    // Persist to events
    await deps.eventsManager.appendEvent({
      ...envelope,
      eventType,
    }).catch(() => {});

    const topic = envelope.topic.trim().toLowerCase();
    const isNotificationEnvelope =
      eventType === "notification_created" ||
      topic === "notifications" ||
      topic.endsWith(":notifications");
    const isFeedEnvelope =
      eventType === "post_created" || topic.startsWith("feed:");
    const isDirectorEnvelope =
      eventType === "director_directive" ||
      eventType === "directive" ||
      eventType === "director_grant" ||
      eventType === "director_credit" ||
      eventType === "director_credits_added" ||
      topic === "director";
    const shouldIngestSocketEnvelope =
      isNotificationEnvelope || isFeedEnvelope || isDirectorEnvelope;
    if (shouldIngestSocketEnvelope) {
      // Persist socket envelopes into memory streams so chat replies can drill
      // into recent notifications/feed activity without extra polling.
      await deps.memory
        .ingest({
          receivedAt: envelope.receivedAt,
          source: envelope.source,
          topic: envelope.topic,
          payload: envelope.payload,
        })
        .catch(() => {});
    }

    if (isNotificationEnvelope) {
      markSocketBatchPending("notifications", envelope, eventType, payload);
    }
    if (isFeedEnvelope) {
      markSocketBatchPending("feed", envelope, eventType, payload);
    }

    // Auth state updates
    if (eventType === "auth_state" && isRecord(payload.state)) {
      deps.ctx.debugSnapshot.auth = payload.state as Record<string, unknown>;
      await deps.writeDebugSnapshot();
    }

    // Permission state updates
    const permissionStateEvent = normalizePermissionStateEvent(eventType, payload);
    if (permissionStateEvent) {
      deps.ctx.debugSnapshot.permission = permissionStateEvent.permissionState;
      await deps.writeDebugSnapshot();
      const permissionGrantCandidates = parseGrantCandidatesFromPermissionState(
        permissionStateEvent.permissionState,
      );
      if (permissionGrantCandidates.length > 0) {
        let latestExpiring = permissionGrantCandidates[0]!;
        for (const candidate of permissionGrantCandidates.slice(1)) {
          if (candidate.expiresAtMs > latestExpiring.expiresAtMs) {
            latestExpiring = candidate;
          }
        }
        deps.grantManager.setActiveGrant(latestExpiring);
      } else if (deps.grantManager.isGrantExpired()) {
        deps.grantManager.setActiveGrant(null);
      }
      triggerAutoCreditPlanner?.({
        trigger: permissionStateEvent.trigger,
        permissionState: permissionStateEvent.permissionState,
      });
      triggerAutoPostingPlanner?.({
        trigger: permissionStateEvent.trigger,
        permissionState: permissionStateEvent.permissionState,
      });
    }

    // Lens subscriptions are event-driven: when lens-affecting notifications
    // arrive, refresh feed:lens:* topic bindings immediately.
    if (eventType === "notification_created") {
      const notificationType =
        typeof payload.notificationType === "string"
          ? payload.notificationType.trim().toLowerCase()
          : "";
      const shouldRefreshLensTopics =
        notificationType === "lens_invite" ||
        notificationType === "lens_request_approved" ||
        notificationType === "lens_rule";
      if (shouldRefreshLensTopics) {
        const reason = `notification:${notificationType}`;
        deps.ctx.subscriptionManager?.requestResync(reason);
        await deps.memory.recordWrite({
          type: "socket_subscription_resync_requested",
          at: nowIso(),
          reason,
          source: envelope.source,
          topic: envelope.topic,
          eventType,
        }).catch(() => {});
      }
    }

    // Director directives
    if (
      eventType === "director_directive" ||
      eventType === "directive" ||
      envelope.topic === "director"
    ) {
      const directivePayload: Record<string, unknown> = isRecord(payload.directive)
        ? { ...(payload.directive as Record<string, unknown>) }
        : { ...payload };
      const topicMatch = /^user:([^:]+):director$/iu.exec(envelope.topic.trim());
      const topicAgentId = topicMatch?.[1]?.trim() ?? "";
      const payloadAgentId =
        typeof directivePayload.agentId === "string" &&
        directivePayload.agentId.trim().length > 0
          ? directivePayload.agentId.trim()
          : "";
      if (topicAgentId.length > 0 && payloadAgentId.length > 0 && topicAgentId !== payloadAgentId) {
        const directiveIdRaw = directivePayload.id;
        const directiveId =
          typeof directiveIdRaw === "string" && directiveIdRaw.trim().length > 0
            ? directiveIdRaw.trim()
            : null;
        await deps.memory
          .recordWrite({
            type: "directive_topic_agent_mismatch",
            at: nowIso(),
            directiveId,
            topicAgentId,
            payloadAgentId,
            topic: envelope.topic,
            eventType,
          })
          .catch(() => {});
        return;
      }
      if (!payloadAgentId.length && topicAgentId.length > 0) {
        directivePayload.agentId = topicAgentId;
      }
      try {
        await flushSocketBatchForDirective("directive_intake");
        await deps.ctx.directiveManager?.intake(directivePayload);
      } catch (error: unknown) {
        const directiveIdRaw = directivePayload.id;
        const directiveId =
          typeof directiveIdRaw === "string" && directiveIdRaw.trim().length > 0
            ? directiveIdRaw.trim()
            : null;
        const kindRaw = directivePayload.kind;
        const kind =
          typeof kindRaw === "string" && kindRaw.trim().length > 0
            ? kindRaw.trim()
            : null;
        const message = error instanceof Error ? error.message : String(error);
        await deps.memory.recordWrite({
          type: "directive_intake_failed",
          at: nowIso(),
          directiveId,
          kind,
          source: envelope.source,
          topic: envelope.topic,
          eventType,
          error: message,
        }).catch(() => {});
        console.warn(
          "[agent-runtime] directive intake failed",
          JSON.stringify({
            directiveId,
            kind,
            source: envelope.source,
            topic: envelope.topic,
            eventType,
            error: message,
          }),
        );
      }
    }

    // Grant events
    if (eventType === "director_grant" && isRecord(payload.grant)) {
      const directorGrantPayload = payload.grant as Record<string, unknown>;
      await deps.grantManager.persistDirectorGrant(
        directorGrantPayload,
        envelope.receivedAt,
      );
      deps.grantManager.setActiveGrant(
        buildGrantState(directorGrantPayload, envelope.receivedAt),
      );
      triggerAutoCreditPlanner?.({ trigger: "director_grant" });
      triggerAutoPostingPlanner?.({ trigger: "director_grant" });
    }
    if (
      (eventType === "director_credit" && isRecord(payload.credit)) ||
      eventType === "director_credits_added"
    ) {
      const creditPayload =
        eventType === "director_credit"
          ? payload.credit
          : payload;
      if (isRecord(creditPayload)) {
        await deps.grantManager.persistCreditsGrant(
          creditPayload as Record<string, unknown>,
          envelope.receivedAt,
        );
        deps.grantManager.setActiveGrant(
          buildCreditsPermissionState(
            creditPayload as Record<string, unknown>,
            envelope.receivedAt,
          ),
        );
        triggerAutoCreditPlanner?.({ trigger: eventType });
        triggerAutoPostingPlanner?.({ trigger: eventType });
      }
    }

    // OpenClaw wake
    await deps.openClawManager.wakeFromEnvelope(envelope).catch(() => {});
  };

  // -- SubscriptionManager
  const subscriptionManager = new SubscriptionManager({
    config: {
      subscribeGlobalFeed: deps.config.subscribeGlobalFeed,
      subscribeActivityFeed: deps.config.subscribeActivityFeed,
      autoSubscribeLenses: deps.config.autoSubscribeLenses,
      lensRefreshMinMs: deps.config.lensRefreshMinMs,
      heartbeatIntervalMs: deps.config.heartbeatIntervalMs,
      extraPublicTopics: deps.config.extraPublicTopics,
      extraUserTopics: deps.config.extraUserTopics,
    },
    ws: deps.ctx.ws,
    misc: deps.ctx.misc,
    auth: deps.ctx.auth,
    memory: { recordWrite: (p: unknown) => deps.memory.recordWrite(p) },
    debugSnapshot: deps.ctx.debugSnapshot,
    trpc: deps.trpc as any,
    writeDebugSnapshot: () => deps.writeDebugSnapshot(),
    markWsActivity: (source: string) =>
      deps.markWsActivity(source),
    handleEnvelope,
    authManager: deps.authManager,
    getAgentKeyBox: deps.getAgentKeyBox,
    runBackendCall: <T>(label: string, fn: () => Promise<T>) =>
      deps.runBackendCall(label, fn),
    resetLocalStateOnReconnect: async (reason: string) => {
      const directiveReset = deps.ctx.directiveManager
        ? await deps.ctx.directiveManager.resetPendingOnReconnect(reason)
        : {
            scanned: 0,
            cancelled: 0,
            skippedTerminal: 0,
            skippedInvalid: 0,
          };
      const queueReset = deps.ctx.queueManager
        ? await deps.ctx.queueManager.resetQueueOnReconnect(reason)
        : {
            scanned: 0,
            cancelled: 0,
            cancelledQueued: 0,
            cancelledScheduled: 0,
            cancelledRunning: 0,
            skippedTerminal: 0,
            removedInboxFiles: 0,
          };
      const summary = {
        reason,
        directive: directiveReset,
        queue: queueReset,
      };
      await deps.memory
        .recordWrite({
          type: "runtime_reconnect_local_state_reset",
          at: nowIso(),
          ...summary,
        })
        .catch(() => {});
      return summary;
    },
  });
  subscriptionManager.startHealLoop();
  deps.ctx.subscriptionManager = subscriptionManager;

};
