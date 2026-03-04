import { type GrantState } from "./grants/grant-state.js";
import { trimEnv } from "./lib/env-parse.js";
import { nowIso } from "./lib/text.js";
import { isEnabledEnvFlag } from "./main-helpers.js";
import { type PlannerTriggerOptions } from "./main-auto-credit-planner.js";

export type AutoPostingPlannerDeps = {
  hasDirectiveManager: () => boolean;
  isQueueRunnerEnabled: () => boolean;
  getPermissionState: () => unknown;
  resolveGrantCandidates: (permissionState: unknown) => GrantState[];
  intakeDirective: (directive: Record<string, unknown>) => Promise<void>;
  recordWrite: (payload: unknown) => Promise<unknown>;
};

export const createAutoPostingPlanner = (
  deps: AutoPostingPlannerDeps,
): ((opts: PlannerTriggerOptions) => void) => {
  type AutoPostingAction = "post_media" | "post_text" | "story";
  const AUTO_POSTING_ACTION_KEYS: Record<AutoPostingAction, readonly string[]> = {
    post_media: ["post:post:media", "post:thread:media", "write.createPost"],
    post_text: ["post:post:text", "post:thread:text", "write.createPost"],
    story: ["story", "write.createStory"],
  };
  const autoPostingPlannerEnabled = isEnabledEnvFlag(
    trimEnv("MG_AUTO_POSTING_PLANNER_ENABLED") ?? "1",
  );
  const autoPostingPlannerMinIntervalMs = Math.max(
    5_000,
    Number.parseInt(trimEnv("MG_AUTO_POSTING_PLANNER_MIN_INTERVAL_MS") ?? "20000", 10) || 20_000,
  );
  const autoPostingPlanCooldownMs = Math.max(
    autoPostingPlannerMinIntervalMs,
    Number.parseInt(
      trimEnv("MG_AUTO_POSTING_PLAN_COOLDOWN_MS") ??
        `${Math.max(autoPostingPlannerMinIntervalMs, 60_000)}` ,
      10,
    ) || Math.max(autoPostingPlannerMinIntervalMs, 60_000),
  );
  const autoPostingFollowupDelayMs = Math.max(
    autoPostingPlannerMinIntervalMs + 250,
    Number.parseInt(
      trimEnv("MG_AUTO_POSTING_FOLLOWUP_DELAY_MS") ??
        `${autoPostingPlannerMinIntervalMs + 250}`,
      10,
    ) || autoPostingPlannerMinIntervalMs + 250,
  );
  let autoPostingPlanInFlight: Promise<void> | null = null;
  let autoPostingPlanLastAtMs = 0;
  const autoPostingRecentPlans = new Map<string, number>();
  let autoPostingFollowupTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleAutoPostingPlannerFollowup = (trigger: string): void => {
    if (!autoPostingPlannerEnabled) return;
    if (autoPostingFollowupTimer) return;
    autoPostingFollowupTimer = setTimeout(() => {
      autoPostingFollowupTimer = null;
      triggerAutoPostingPlanner({ trigger });
    }, autoPostingFollowupDelayMs);
  };
  const triggerAutoPostingPlanner = (opts: PlannerTriggerOptions): void => {
    if (!autoPostingPlannerEnabled) return;
    if (!deps.hasDirectiveManager()) return;
    if (!deps.isQueueRunnerEnabled()) return;
    const nowMs = Date.now();
    if (autoPostingPlanInFlight) return;
    if (nowMs - autoPostingPlanLastAtMs < autoPostingPlannerMinIntervalMs) return;

    autoPostingPlanInFlight = (async () => {
      const permissionState = opts.permissionState ?? deps.getPermissionState();
      const grantCandidates = deps.resolveGrantCandidates(permissionState);
      if (!grantCandidates.length) return;

      const now = Date.now();
      const availableForAction = (
        grant: GrantState,
        keys: readonly string[],
      ): {
        available: number;
        notBeforeBlocked: number;
        earliestNotBeforeAtMs: number | null;
      } => {
        let available = 0;
        let notBeforeBlocked = 0;
        let earliestNotBeforeAtMs: number | null = null;
        for (const key of keys) {
          const actionState = grant.actions.get(key);
          if (!actionState || actionState.remainingCount <= 0) continue;
          const notBeforeAtMs =
            typeof actionState.notBeforeAtMs === "number" &&
            Number.isFinite(actionState.notBeforeAtMs)
              ? actionState.notBeforeAtMs
              : grant.issuedAtMs + actionState.notBeforeSeconds * 1000;
          if (notBeforeAtMs > now) {
            notBeforeBlocked += actionState.remainingCount;
            if (earliestNotBeforeAtMs === null || notBeforeAtMs < earliestNotBeforeAtMs) {
              earliestNotBeforeAtMs = notBeforeAtMs;
            }
            continue;
          }
          available += actionState.remainingCount;
        }
        return {
          available,
          notBeforeBlocked,
          earliestNotBeforeAtMs,
        };
      };

      let selected:
        | {
            action: AutoPostingAction;
            grantId: string | null;
            available: number;
          }
        | null = null;
      const actionPriority: AutoPostingAction[] = ["post_media", "post_text", "story"];
      const availableByAction: Record<AutoPostingAction, number> = {
        post_media: 0,
        post_text: 0,
        story: 0,
      };
      const notBeforeBlockedByAction: Record<AutoPostingAction, number> = {
        post_media: 0,
        post_text: 0,
        story: 0,
      };
      let cooldownBlocked = 0;
      let earliestNotBeforeAtMs: number | null = null;
      for (const candidate of grantCandidates) {
        if (candidate.expiresAtMs <= now) continue;
        const grantId = candidate.id.trim().length > 0 ? candidate.id.trim() : null;
        for (const action of actionPriority) {
          const availability = availableForAction(candidate, AUTO_POSTING_ACTION_KEYS[action]);
          const available = availability.available;
          availableByAction[action] += available;
          notBeforeBlockedByAction[action] += availability.notBeforeBlocked;
          if (
            availability.earliestNotBeforeAtMs !== null &&
            (earliestNotBeforeAtMs === null || availability.earliestNotBeforeAtMs < earliestNotBeforeAtMs)
          ) {
            earliestNotBeforeAtMs = availability.earliestNotBeforeAtMs;
          }
          if (available <= 0) continue;
          const dedupeKey = `${action}:${grantId ?? "none"}`;
          const lastPlannedAt = autoPostingRecentPlans.get(dedupeKey) ?? 0;
          if (now - lastPlannedAt < autoPostingPlanCooldownMs) {
            cooldownBlocked += 1;
            continue;
          }
          selected = {
            action,
            grantId,
            available,
          };
          break;
        }
        if (selected) break;
      }

      if (!selected) {
        const totalAvailable =
          availableByAction.post_media + availableByAction.post_text + availableByAction.story;
        const totalNotBeforeBlocked =
          notBeforeBlockedByAction.post_media +
          notBeforeBlockedByAction.post_text +
          notBeforeBlockedByAction.story;
        const reason =
          totalAvailable > 0
            ? cooldownBlocked > 0
              ? "cooldown"
              : "no_plan_targets"
            : totalNotBeforeBlocked > 0
              ? "not_before"
              : "no_posting_window";
        await deps.recordWrite({
          type: "auto_posting_planner_skipped",
          at: nowIso(),
          trigger: opts.trigger,
          reason,
          availableByAction,
          notBeforeBlockedByAction,
          cooldownBlocked,
          grantCandidateCount: grantCandidates.length,
          ...(earliestNotBeforeAtMs !== null
            ? { nextReadyAt: new Date(earliestNotBeforeAtMs).toISOString() }
            : {}),
        }).catch(() => {});
        return;
      }

      const directiveId = `auto_post_${selected.action}_${Date.now().toString(36)}_${crypto
        .randomUUID()
        .replaceAll("-", "")
        .slice(0, 12)}`;
      const directivePayloadBase: Record<string, unknown> = {
        id: directiveId,
        kind: "brain.generateAndQueue",
        createdAt: nowIso(),
        ...(selected.grantId ? { grantId: selected.grantId } : {}),
        forceNow: true,
      };
      const payloadByAction: Record<AutoPostingAction, Record<string, unknown>> = {
        post_media: {
          goal: "post",
          kind: "media",
          kinds: ["media"],
          mediaPersonaLock: true,
          generatedAssetType: "image",
          forceNow: true,
          provenance: "runtime_auto_posting",
          requireExplicitPublishVerb: false,
          explicitPublishRequested: false,
          directiveScope: {
            allowedCommandKinds: ["write.createPost"],
          },
          autoPlanned: {
            trigger: opts.trigger,
            source: "posting_window_media",
          },
        },
        post_text: {
          goal: "post",
          kind: "thread",
          kinds: ["thread"],
          forceNow: true,
          provenance: "runtime_auto_posting",
          requireExplicitPublishVerb: false,
          explicitPublishRequested: false,
          directiveScope: {
            allowedCommandKinds: ["write.createPost"],
          },
          autoPlanned: {
            trigger: opts.trigger,
            source: "posting_window_text",
          },
        },
        story: {
          goal: "story",
          kind: "story",
          kinds: ["story"],
          forceNow: true,
          provenance: "runtime_auto_posting",
          requireExplicitPublishVerb: false,
          explicitPublishRequested: false,
          directiveScope: {
            allowedCommandKinds: ["write.createStory"],
          },
          autoPlanned: {
            trigger: opts.trigger,
            source: "posting_window_story",
          },
        },
      };
      await deps.intakeDirective({
        ...directivePayloadBase,
        payload: payloadByAction[selected.action],
      });
      const dedupeKey = `${selected.action}:${selected.grantId ?? "none"}`;
      autoPostingRecentPlans.set(dedupeKey, Date.now());
      const cutoff = Date.now() - autoPostingPlanCooldownMs;
      for (const [key, seenAt] of autoPostingRecentPlans) {
        if (seenAt < cutoff) autoPostingRecentPlans.delete(key);
      }
      await deps.recordWrite({
        type: "auto_posting_planner_enqueued",
        at: nowIso(),
        trigger: opts.trigger,
        action: selected.action,
        grantId: selected.grantId,
        available: selected.available,
        availableByAction,
        directiveId,
      }).catch(() => {});
      if (selected.available > 1) {
        scheduleAutoPostingPlannerFollowup("auto_posting_followup");
      }
    })()
      .catch(async (error: unknown) => {
        await deps.recordWrite({
          type: "auto_posting_planner_failed",
          at: nowIso(),
          trigger: opts.trigger,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => {});
      })
      .finally(() => {
        autoPostingPlanLastAtMs = Date.now();
        autoPostingPlanInFlight = null;
      });
  };


  return triggerAutoPostingPlanner;
};
