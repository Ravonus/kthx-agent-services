import { type GrantState } from "./grants/grant-state.js";
import { trimEnv } from "./lib/env-parse.js";
import { isRecord } from "./lib/guards.js";
import { nowIso } from "./lib/text.js";
import { isEnabledEnvFlag } from "./main-helpers.js";

export type PlannerTriggerOptions = {
  trigger: string;
  permissionState?: unknown;
};

export type AutoCreditPlannerDeps = {
  hasDirectiveManager: () => boolean;
  isQueueRunnerEnabled: () => boolean;
  getPermissionState: () => unknown;
  resolveGrantCandidates: (permissionState: unknown) => GrantState[];
  callAgentChatBridge: (payload: unknown) => Promise<unknown>;
  intakeDirective: (directive: Record<string, unknown>) => Promise<void>;
  recordWrite: (payload: unknown) => Promise<unknown>;
};

export const createAutoCreditPlanner = (
  deps: AutoCreditPlannerDeps,
): ((opts: PlannerTriggerOptions) => void) => {
  type EngagementAction = "like" | "comment" | "repost";
  type AutoCreditPostTarget = {
    postId: number;
    commentId: number | null;
    authorId: string | null;
    source: string;
  };
  const AUTO_CREDIT_ACTION_KEYS: Record<EngagementAction, readonly string[]> = {
    like: ["like", "write.votePost"],
    comment: ["comment", "write.commentPost"],
    repost: ["repost", "write.repostPost"],
  };
  const AUTO_CREDIT_ACTION_CAPS: Record<EngagementAction, number> = {
    like: Math.max(1, Number.parseInt(trimEnv("MG_AUTO_CREDIT_MAX_LIKES_PER_PLAN") ?? "4", 10) || 4),
    comment: Math.max(
      1,
      Number.parseInt(trimEnv("MG_AUTO_CREDIT_MAX_COMMENTS_PER_PLAN") ?? "2", 10) || 2,
    ),
    repost: Math.max(
      1,
      Number.parseInt(trimEnv("MG_AUTO_CREDIT_MAX_REPOSTS_PER_PLAN") ?? "2", 10) || 2,
    ),
  };
  const autoCreditPlannerEnabled = isEnabledEnvFlag(trimEnv("MG_AUTO_CREDIT_PLANNER_ENABLED"));
  const autoCreditPlannerMinIntervalMs = Math.max(
    5_000,
    Number.parseInt(trimEnv("MG_AUTO_CREDIT_PLANNER_MIN_INTERVAL_MS") ?? "20000", 10) || 20_000,
  );
  const autoCreditPlannerRecentTargetTtlMs = Math.max(
    60_000,
    Number.parseInt(trimEnv("MG_AUTO_CREDIT_TARGET_TTL_MS") ?? "21600000", 10) ||
      6 * 60 * 60 * 1000,
  );
  let autoCreditPlanInFlight: Promise<void> | null = null;
  let autoCreditPlanLastAtMs = 0;
  const autoCreditRecentTargets = new Map<string, number>();
  const triggerAutoCreditPlanner = (opts: PlannerTriggerOptions): void => {
    if (!autoCreditPlannerEnabled) return;
    if (!deps.hasDirectiveManager()) return;
    if (!deps.isQueueRunnerEnabled()) return;
    const nowMs = Date.now();
    if (autoCreditPlanInFlight) return;
    if (nowMs - autoCreditPlanLastAtMs < autoCreditPlannerMinIntervalMs) return;

    autoCreditPlanInFlight = (async () => {
      const permissionState = opts.permissionState ?? deps.getPermissionState();
      const grantCandidates = deps.resolveGrantCandidates(permissionState);
      if (!grantCandidates.length) return;

      const budgets: Record<
        EngagementAction,
        { available: number; grantId: string | null; strongestCount: number }
      > = {
        like: { available: 0, grantId: null, strongestCount: 0 },
        comment: { available: 0, grantId: null, strongestCount: 0 },
        repost: { available: 0, grantId: null, strongestCount: 0 },
      };
      const now = Date.now();
      for (const candidate of grantCandidates) {
        if (candidate.expiresAtMs <= now) continue;
        const grantId = candidate.id.trim();
        for (const action of Object.keys(AUTO_CREDIT_ACTION_KEYS) as EngagementAction[]) {
          for (const key of AUTO_CREDIT_ACTION_KEYS[action]) {
            const actionState = candidate.actions.get(key);
            if (!actionState || actionState.remainingCount <= 0) continue;
            const notBeforeAtMs =
              typeof actionState.notBeforeAtMs === "number" &&
              Number.isFinite(actionState.notBeforeAtMs)
                ? actionState.notBeforeAtMs
                : candidate.issuedAtMs + actionState.notBeforeSeconds * 1000;
            if (notBeforeAtMs > now) continue;
            budgets[action].available += actionState.remainingCount;
            if (actionState.remainingCount > budgets[action].strongestCount) {
              budgets[action].strongestCount = actionState.remainingCount;
              budgets[action].grantId = grantId.length > 0 ? grantId : null;
            }
          }
        }
      }

      const requestedActions = (Object.keys(AUTO_CREDIT_ACTION_CAPS) as EngagementAction[])
        .filter((action) => budgets[action].available > 0 && AUTO_CREDIT_ACTION_CAPS[action] > 0);
      if (requestedActions.length === 0) return;

      const parsePositiveInt = (value: unknown): number | null => {
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
          return Math.floor(value);
        }
        if (typeof value === "string" && value.trim().length > 0) {
          const parsed = Number.parseInt(value.trim(), 10);
          if (Number.isFinite(parsed) && parsed > 0) return parsed;
        }
        return null;
      };
      const parsePostTarget = (
        value: unknown,
        source: string,
      ): AutoCreditPostTarget | null => {
        if (!isRecord(value)) return null;
        const postRecord = isRecord(value.post) ? value.post : null;
        const postId =
          parsePositiveInt(value.id) ??
          parsePositiveInt(value.postId) ??
          parsePositiveInt(value.targetPostId) ??
          (postRecord ? parsePositiveInt(postRecord.id) ?? parsePositiveInt(postRecord.postId) : null);
        if (!postId) return null;
        const commentId =
          parsePositiveInt(value.commentId) ??
          parsePositiveInt(value.parentId) ??
          parsePositiveInt(value.targetCommentId) ??
          (postRecord ? parsePositiveInt(postRecord.commentId) : null);
        const author = isRecord(value.author) ? value.author : null;
        const postAuthor = postRecord && isRecord(postRecord.author) ? postRecord.author : null;
        const userRecord = isRecord(value.user) ? value.user : null;
        const authorId =
          (typeof value.authorId === "string" && value.authorId.trim().length > 0
            ? value.authorId.trim()
            : null) ??
          (typeof author?.mainUserId === "string" && author.mainUserId.trim().length > 0
            ? author.mainUserId.trim()
            : null) ??
          (typeof author?.id === "string" && author.id.trim().length > 0
            ? author.id.trim()
            : null) ??
          (typeof postRecord?.authorId === "string" && postRecord.authorId.trim().length > 0
            ? postRecord.authorId.trim()
            : null) ??
          (typeof postAuthor?.mainUserId === "string" && postAuthor.mainUserId.trim().length > 0
            ? postAuthor.mainUserId.trim()
            : null) ??
          (typeof postAuthor?.id === "string" && postAuthor.id.trim().length > 0
            ? postAuthor.id.trim()
            : null) ??
          (typeof userRecord?.mainUserId === "string" && userRecord.mainUserId.trim().length > 0
            ? userRecord.mainUserId.trim()
            : null) ??
          (typeof userRecord?.id === "string" && userRecord.id.trim().length > 0
            ? userRecord.id.trim()
            : null);
        return {
          postId,
          commentId,
          authorId,
          source,
        };
      };
      const parseRecordItems = (value: unknown): Record<string, unknown>[] => {
        if (!isRecord(value)) return [];
        const items = Array.isArray(value.items) ? value.items : [];
        return items.filter((entry): entry is Record<string, unknown> => isRecord(entry));
      };
      const resolveAuthorIdFromPostRecord = (record: Record<string, unknown>): string | null => {
        const author = isRecord(record.author) ? record.author : null;
        return (
          (typeof record.authorId === "string" && record.authorId.trim().length > 0
            ? record.authorId.trim()
            : null) ??
          (typeof author?.mainUserId === "string" && author.mainUserId.trim().length > 0
            ? author.mainUserId.trim()
            : null) ??
          (typeof author?.id === "string" && author.id.trim().length > 0
            ? author.id.trim()
            : null)
        );
      };
      const resolveFindPostAuthorId = (value: unknown, postId: number): string | null => {
        if (!isRecord(value)) return null;
        if (isRecord(value.data)) {
          const nested = resolveFindPostAuthorId(value.data, postId);
          if (nested) return nested;
        }
        if (isRecord(value.post)) {
          const id =
            parsePositiveInt(value.post.id) ??
            parsePositiveInt(value.post.postId);
          if (id === postId) {
            return resolveAuthorIdFromPostRecord(value.post);
          }
        }
        if (Array.isArray(value.items)) {
          for (const entry of value.items) {
            if (!isRecord(entry)) continue;
            const id =
              parsePositiveInt(entry.id) ??
              parsePositiveInt(entry.postId);
            if (id !== postId) continue;
            const resolved = resolveAuthorIdFromPostRecord(entry);
            if (resolved) return resolved;
          }
        }
        const rootId = parsePositiveInt(value.id) ?? parsePositiveInt(value.postId);
        if (rootId === postId) {
          return resolveAuthorIdFromPostRecord(value);
        }
        return null;
      };
      const resolveFindCommentAuthorId = (
        value: unknown,
        postId: number,
        commentId: number,
      ): string | null => {
        if (!isRecord(value)) return null;
        if (isRecord(value.data)) {
          const nested = resolveFindCommentAuthorId(value.data, postId, commentId);
          if (nested) return nested;
        }
        const readAuthorId = (record: Record<string, unknown>): string | null => {
          const author = isRecord(record.author) ? record.author : null;
          return (
            (typeof record.authorId === "string" && record.authorId.trim().length > 0
              ? record.authorId.trim()
              : null) ??
            (typeof author?.mainUserId === "string" && author.mainUserId.trim().length > 0
              ? author.mainUserId.trim()
              : null) ??
            (typeof author?.id === "string" && author.id.trim().length > 0
              ? author.id.trim()
              : null)
          );
        };
        if (isRecord(value.comment)) {
          const rowPostId = parsePositiveInt(value.comment.postId);
          const rowCommentId =
            parsePositiveInt(value.comment.commentId) ??
            parsePositiveInt(value.comment.id);
          if (rowPostId === postId && rowCommentId === commentId) {
            return readAuthorId(value.comment);
          }
        }
        if (Array.isArray(value.comments)) {
          for (const entry of value.comments) {
            if (!isRecord(entry)) continue;
            const rowPostId = parsePositiveInt(entry.postId);
            const rowCommentId =
              parsePositiveInt(entry.commentId) ??
              parsePositiveInt(entry.id);
            if (rowPostId !== postId || rowCommentId !== commentId) continue;
            const resolved = readAuthorId(entry);
            if (resolved) return resolved;
          }
        }
        const rootPostId = parsePositiveInt(value.postId);
        const rootCommentId =
          parsePositiveInt(value.commentId) ??
          parsePositiveInt(value.id);
        if (rootPostId === postId && rootCommentId === commentId) {
          return readAuthorId(value);
        }
        return null;
      };
      const normalizeInterestTag = (value: unknown): string | null => {
        if (typeof value !== "string") return null;
        const normalized = value
          .trim()
          .toLowerCase()
          .replace(/^#+/u, "")
          .replace(/[^a-z0-9_-]+/gu, "-")
          .replace(/-+/gu, "-")
          .replace(/^-+|-+$/gu, "")
          .slice(0, 40);
        return normalized.length >= 2 ? normalized : null;
      };

      let agentMainUserId: string | null = null;
      let interestTags: string[] = [];
      const profileData = await deps.callAgentChatBridge({ action: "agent_profile" }).catch(
        () => null,
      );
      if (isRecord(profileData) && isRecord(profileData.agent)) {
        const agentRecord = profileData.agent;
        agentMainUserId =
          typeof agentRecord.mainUserId === "string" &&
          agentRecord.mainUserId.trim().length > 0
            ? agentRecord.mainUserId.trim()
            : null;
        interestTags = Array.from(
          new Set(
            [
              ...(Array.isArray(agentRecord.preferredTags)
                ? agentRecord.preferredTags
                : []),
              ...(Array.isArray(profileData.preferredTags)
                ? profileData.preferredTags
                : []),
              ...(isRecord(profileData.config) && Array.isArray(profileData.config.preferredTags)
                ? profileData.config.preferredTags
                : []),
            ]
              .map((value) => normalizeInterestTag(value))
              .filter((value): value is string => Boolean(value)),
          ),
        ).slice(0, 8);
      }

      const targets: AutoCreditPostTarget[] = [];
      const seenTargetKeys = new Set<string>();
      const pushTarget = (candidate: AutoCreditPostTarget | null): void => {
        if (!candidate) return;
        const key = `${candidate.postId}:${candidate.commentId ?? 0}`;
        if (seenTargetKeys.has(key)) return;
        seenTargetKeys.add(key);
        targets.push(candidate);
      };

      const mentionsData = await deps.callAgentChatBridge({
        action: "browse_unanswered_mentions",
        limit: 16,
        sinceHours: 24 * 7,
      }).catch(() => null);
      for (const mention of parseRecordItems(mentionsData)) {
        const targetType =
          typeof mention.targetType === "string" ? mention.targetType.trim().toLowerCase() : "";
        if (targetType !== "post") continue;
        const targetId = parsePositiveInt(mention.targetId);
        if (!targetId) continue;
        const targetCommentId =
          parsePositiveInt(mention.targetCommentId) ??
          parsePositiveInt(mention.commentId) ??
          parsePositiveInt(mention.parentId);
        pushTarget({
          postId: targetId,
          commentId: targetCommentId ?? null,
          authorId: null,
          source: "unanswered_mention",
        });
      }

      const [homeData, trendingData, exploreData, interestTrendingData, interestExploreData] = await Promise.all([
        deps.callAgentChatBridge({ action: "browse_home_feed", limit: 24 }).catch(() => null),
        deps.callAgentChatBridge({ action: "browse_trending", limit: 24 }).catch(() => null),
        deps.callAgentChatBridge({ action: "browse_posts", limit: 24 }).catch(() => null),
        interestTags.length > 0
          ? deps.callAgentChatBridge({
              action: "browse_trending",
              limit: 24,
              tags: interestTags.slice(0, 8),
            }).catch(() => null)
          : Promise.resolve(null),
        interestTags.length > 0
          ? deps.callAgentChatBridge({
              action: "browse_posts",
              limit: 24,
              tags: interestTags.slice(0, 8),
            }).catch(() => null)
          : Promise.resolve(null),
      ]);
      for (const item of parseRecordItems(homeData)) {
        pushTarget(parsePostTarget(item, "home_feed"));
      }
      for (const item of parseRecordItems(trendingData)) {
        pushTarget(parsePostTarget(item, "trending"));
      }
      for (const item of parseRecordItems(exploreData)) {
        pushTarget(parsePostTarget(item, "explore"));
      }
      for (const item of parseRecordItems(interestTrendingData)) {
        pushTarget(parsePostTarget(item, "interest_trending"));
      }
      for (const item of parseRecordItems(interestExploreData)) {
        pushTarget(parsePostTarget(item, "interest_explore"));
      }

      const unresolvedTargets = targets.filter((entry) => !entry.authorId).slice(0, 36);
      if (unresolvedTargets.length > 0) {
        const resolvedAuthorByTarget = new Map<string, string>();
        await Promise.all(
          unresolvedTargets.map(async (target) => {
            const response = await deps.callAgentChatBridge({
              action: "find_post",
              postId: target.postId,
            }).catch(() => null);
            const resolvedAuthorId = resolveFindPostAuthorId(response, target.postId);
            if (!resolvedAuthorId) return;
            resolvedAuthorByTarget.set(
              `${target.postId}:${target.commentId ?? 0}`,
              resolvedAuthorId,
            );
          }),
        );
        if (resolvedAuthorByTarget.size > 0) {
          for (const target of targets) {
            if (target.authorId) continue;
            const key = `${target.postId}:${target.commentId ?? 0}`;
            const resolvedAuthorId = resolvedAuthorByTarget.get(key);
            if (!resolvedAuthorId) continue;
            target.authorId = resolvedAuthorId;
            if (!target.source.includes("+hydrated")) {
              target.source = `${target.source}+hydrated`;
            }
          }
        }
      }

      if (targets.length === 0) {
        await deps.recordWrite({
          type: "auto_credit_planner_skipped",
          at: nowIso(),
          trigger: opts.trigger,
          reason: "no_targets",
          budgets: {
            like: budgets.like.available,
            comment: budgets.comment.available,
            repost: budgets.repost.available,
          },
        }).catch(() => {});
        return;
      }

      const pruneRecentTargets = (): void => {
        const cutoff = Date.now() - autoCreditPlannerRecentTargetTtlMs;
        for (const [key, seenAt] of autoCreditRecentTargets) {
          if (seenAt < cutoff) autoCreditRecentTargets.delete(key);
        }
      };
      pruneRecentTargets();

      const ownTargets = agentMainUserId
        ? targets.filter((entry) => entry.authorId === agentMainUserId)
        : [];
      const knownNonOwnTargets = agentMainUserId
        ? targets.filter((entry) => entry.authorId !== null && entry.authorId !== agentMainUserId)
        : targets.slice();
      const unknownAuthorTargets = agentMainUserId
        ? targets.filter((entry) => entry.authorId === null)
        : [];
      const nonOwnTargets = agentMainUserId
        ? knownNonOwnTargets.length > 0
          ? knownNonOwnTargets
          : unknownAuthorTargets
        : targets.slice();
      const ownReplyCommentCandidates = ownTargets.filter(
        (entry): entry is AutoCreditPostTarget & { commentId: number } =>
          typeof entry.commentId === "number" && entry.commentId > 0,
      );
      const ownReplyAuthorByTargetKey = new Map<string, string | null>();
      await Promise.all(
        ownReplyCommentCandidates.map(async (entry) => {
          const response = await deps.callAgentChatBridge({
            action: "find_comment",
            postId: entry.postId,
            commentId: entry.commentId,
          }).catch(() => null);
          const authorId = resolveFindCommentAuthorId(response, entry.postId, entry.commentId);
          ownReplyAuthorByTargetKey.set(
            `${entry.postId}:${entry.commentId}`,
            authorId,
          );
        }),
      );
      const ownReplyTargets = ownReplyCommentCandidates.filter((entry) => {
        const key = `${entry.postId}:${entry.commentId}`;
        const parentAuthorId = ownReplyAuthorByTargetKey.get(key) ?? null;
        if (agentMainUserId && parentAuthorId === agentMainUserId) {
          return false;
        }
        if (!parentAuthorId) {
          return entry.source.startsWith("unanswered_mention");
        }
        return true;
      });
      const commentTargets = (
        nonOwnTargets.length > 0 ? [...nonOwnTargets, ...ownReplyTargets] : ownReplyTargets
      ).sort((left, right) => {
        const score = (entry: AutoCreditPostTarget): number => {
          const isOwnReply =
            agentMainUserId !== null &&
            entry.authorId === agentMainUserId &&
            typeof entry.commentId === "number" &&
            entry.commentId > 0;
          if (isOwnReply) return 0;
          const isMentionSource = entry.source.startsWith("unanswered_mention");
          if (isMentionSource && typeof entry.commentId === "number" && entry.commentId > 0) {
            return 1;
          }
          if (isMentionSource) return 2;
          if (typeof entry.commentId === "number" && entry.commentId > 0) return 3;
          if (entry.source.startsWith("interest_")) return 4;
          if (entry.source === "home_feed") return 5;
          if (entry.source === "trending") return 6;
          if (entry.source === "explore") return 7;
          return 8;
        };
        const rankDelta = score(left) - score(right);
        if (rankDelta !== 0) return rankDelta;
        if ((right.commentId ?? 0) !== (left.commentId ?? 0)) {
          return (right.commentId ?? 0) - (left.commentId ?? 0);
        }
        return right.postId - left.postId;
      });
      const engagementTargets = nonOwnTargets;

      const allowedWriteKindForAction: Record<EngagementAction, string> = {
        comment: "write.commentPost",
        like: "write.votePost",
        repost: "write.repostPost",
      };

      const plannedCounts: Record<EngagementAction, number> = {
        like: 0,
        comment: 0,
        repost: 0,
      };

      for (const action of requestedActions) {
        const cap = Math.min(AUTO_CREDIT_ACTION_CAPS[action], budgets[action].available);
        if (cap <= 0) continue;
        const targetPool = action === "comment" ? commentTargets : engagementTargets;
        for (const target of targetPool) {
          if (plannedCounts[action] >= cap) break;
          const targetKey = `${action}:${target.postId}:${action === "comment" ? (target.commentId ?? 0) : 0}`;
          const lastSeenAt = autoCreditRecentTargets.get(targetKey) ?? 0;
          if (Date.now() - lastSeenAt < autoCreditPlannerRecentTargetTtlMs) continue;

          const directiveId = `auto_credit_${action}_${Date.now().toString(36)}_${crypto
            .randomUUID()
            .replaceAll("-", "")
            .slice(0, 12)}`;
          const directivePayload: Record<string, unknown> = {
            id: directiveId,
            kind: "brain.generateAndQueue",
            createdAt: nowIso(),
            ...(budgets[action].grantId ? { grantId: budgets[action].grantId } : {}),
            forceNow: true,
            payload: {
              goal: action,
              kinds: [action],
              postId: target.postId,
              ...(action === "comment" && target.commentId
                ? {
                    commentId: target.commentId,
                    parentId: target.commentId,
                  }
                : {}),
              forceNow: true,
              provenance: "runtime_auto_credit",
              requireExplicitPublishVerb: false,
              explicitPublishRequested: false,
              directiveScope: {
                allowedCommandKinds: [allowedWriteKindForAction[action]],
                targetPostId: target.postId,
                ...(action === "comment" && target.commentId
                  ? { targetCommentId: target.commentId }
                  : {}),
                target: {
                  postId: target.postId,
                  commentId: action === "comment" ? (target.commentId ?? null) : null,
                },
              },
              autoPlanned: {
                trigger: opts.trigger,
                source: target.source,
              },
            },
          };
          await deps.intakeDirective(directivePayload);
          autoCreditRecentTargets.set(targetKey, Date.now());
          plannedCounts[action] += 1;
        }
      }

      const totalPlanned =
        plannedCounts.like + plannedCounts.comment + plannedCounts.repost;
      await deps.recordWrite({
        type: totalPlanned > 0 ? "auto_credit_planner_enqueued" : "auto_credit_planner_skipped",
        at: nowIso(),
        trigger: opts.trigger,
        reason: totalPlanned > 0 ? "planned" : "no_plan_targets",
        budgets: {
          like: budgets.like.available,
          comment: budgets.comment.available,
          repost: budgets.repost.available,
        },
        planned: plannedCounts,
        targetPoolSize: targets.length,
        nonOwnTargetPoolSize: nonOwnTargets.length,
        unknownAuthorTargetPoolSize: unknownAuthorTargets.length,
        commentTargetPoolSize: commentTargets.length,
        interestTags,
      }).catch(() => {});
    })()
      .catch(async (error: unknown) => {
        await deps.recordWrite({
          type: "auto_credit_planner_failed",
          at: nowIso(),
          trigger: opts.trigger,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => {});
      })
      .finally(() => {
        autoCreditPlanLastAtMs = Date.now();
        autoCreditPlanInFlight = null;
      });
  };


  return triggerAutoCreditPlanner;
};
