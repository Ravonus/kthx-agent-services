import fs from "node:fs/promises";
import path from "node:path";

import { trimEnv } from "./lib/env-parse.js";
import { isRecord } from "./lib/guards.js";
import { nowIso } from "./lib/text.js";
import {
  AGENT_KTHX_GUIDE_PATH,
  isCommandLikelyAvailable,
  probeHttpEndpoint,
  REQUIRED_PERSONA_FRAME_ROLES,
  resolveMediaGeneratorBaseUrlForStartup,
  VISUAL_SETUP_STATUS_FILE,
  type VisualSetupCheckState,
} from "./main-helpers.js";

export type VisualSetupNotifierDeps = {
  stateDir: string;
  imageGenerateCmd: string | null;
  kthxImageCommandTemplate: string;
  callAgentChatBridge: (payload: unknown) => Promise<unknown>;
  chatApiBaseUrl: string;
  agentGuideLocalPath: string;
  recordWrite: (payload: unknown) => Promise<unknown>;
};

export const notifyOwnerImageGeneratorSetupIfNeeded = async (
  deps: VisualSetupNotifierDeps,
): Promise<VisualSetupCheckState> => {
    const checkedAt = nowIso();
    const notifyEnabled = (trimEnv("MG_AGENT_NOTIFY_IMAGE_SETUP") ?? "1") !== "0";
    const authStateDir = path.join(deps.stateDir, "ipc", "auth");
    const noticePath = path.join(authStateDir, "image-generator-setup-notice.json");
    const visualSetupStatusPath = path.join(authStateDir, VISUAL_SETUP_STATUS_FILE);
    const persistVisualSetupStatus = async (
      state: VisualSetupCheckState,
    ): Promise<void> => {
      await fs.mkdir(authStateDir, { recursive: true }).catch(() => {});
      await fs
        .writeFile(
          visualSetupStatusPath,
          `${JSON.stringify(state, null, 2)}\n`,
          "utf8",
        )
        .catch(() => {});
    };

    const imageGenerateCmd = deps.imageGenerateCmd ?? deps.kthxImageCommandTemplate;
    const serviceBaseUrl = resolveMediaGeneratorBaseUrlForStartup();
    const [serviceReachable, commandAvailable] = await Promise.all([
      probeHttpEndpoint(serviceBaseUrl, 1600),
      isCommandLikelyAvailable(imageGenerateCmd),
    ]);

    const profileData = await deps.callAgentChatBridge({ action: "agent_profile" }).catch(
      () => null,
    );
    const agentRecord = isRecord(profileData) && isRecord(profileData.agent)
      ? profileData.agent
      : null;
    const owner = isRecord(profileData) && isRecord(profileData.owner)
      ? profileData.owner
      : null;
    const ownerMainUserId =
      owner && typeof owner.mainUserId === "string"
        ? owner.mainUserId.trim()
        : "";
    const ownerHandle =
      owner && typeof owner.handle === "string"
        ? owner.handle.trim().replace(/^@+/u, "").toLowerCase()
        : null;

    if (!agentRecord) {
      const state: VisualSetupCheckState = {
        checkedAt,
        ready: false,
        ownerMainUserId: ownerMainUserId.length > 0 ? ownerMainUserId : null,
        ownerHandle,
        hasImage: false,
        hasBanner: false,
        missingPersonaRoles: [...REQUIRED_PERSONA_FRAME_ROLES],
        setupGaps: ["agent profile unavailable"],
        serviceReachable,
        commandAvailable,
        notificationState: "profile_unavailable",
      };
      await persistVisualSetupStatus(state);
      return state;
    }

    const hasImage =
      typeof agentRecord.image === "string" &&
      agentRecord.image.trim().length > 0;
    const hasBanner =
      typeof agentRecord.banner === "string" &&
      agentRecord.banner.trim().length > 0;
    const requiredRoleSet = new Set<string>(REQUIRED_PERSONA_FRAME_ROLES);
    const missingPersonaRoles = (() => {
      const personaSetup = isRecord(agentRecord.personaSetup)
        ? agentRecord.personaSetup
        : null;
      const rawMissingRoles = personaSetup && Array.isArray(personaSetup.missingRoles)
        ? personaSetup.missingRoles
        : [];
      return rawMissingRoles
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim().toLowerCase())
        .filter((value) => requiredRoleSet.has(value));
    })();
    const setupGaps: string[] = [];
    if (!hasImage) setupGaps.push("avatar image missing");
    if (!hasBanner) setupGaps.push("banner image missing");
    if (missingPersonaRoles.length > 0) {
      setupGaps.push(`persona frames missing (${missingPersonaRoles.join(", ")})`);
    }
    if (!serviceReachable && !commandAvailable) {
      setupGaps.push("image generator unavailable / browser login not completed");
    }

    const pendingStateBase: Omit<VisualSetupCheckState, "notificationState"> = {
      checkedAt,
      ready: setupGaps.length === 0,
      ownerMainUserId: ownerMainUserId.length > 0 ? ownerMainUserId : null,
      ownerHandle,
      hasImage,
      hasBanner,
      missingPersonaRoles,
      setupGaps,
      serviceReachable,
      commandAvailable,
    };

    if (pendingStateBase.ready) {
      await fs.rm(noticePath, { force: true }).catch(() => {});
      await deps.recordWrite({
          type: "image_generator_setup_complete",
          at: checkedAt,
          ownerMainUserId: pendingStateBase.ownerMainUserId,
          ownerHandle,
          serviceReachable,
          commandAvailable,
        })
        .catch(() => {});
      const state: VisualSetupCheckState = {
        ...pendingStateBase,
        notificationState: "not_required",
      };
      await persistVisualSetupStatus(state);
      return state;
    }

    if (!notifyEnabled) {
      const state: VisualSetupCheckState = {
        ...pendingStateBase,
        notificationState: "disabled",
      };
      await persistVisualSetupStatus(state);
      return state;
    }

    if (!ownerMainUserId.length) {
      const state: VisualSetupCheckState = {
        ...pendingStateBase,
        notificationState: "owner_missing",
      };
      await persistVisualSetupStatus(state);
      return state;
    }

    const reminderIntervalMs = (() => {
      const raw = trimEnv("MG_AGENT_SETUP_REMINDER_INTERVAL_MS");
      if (!raw) return 15 * 60_000;
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed)) return 15 * 60_000;
      return Math.max(60_000, Math.min(24 * 60 * 60 * 1000, parsed));
    })();
    const existingNotice = await fs
      .readFile(noticePath, "utf8")
      .then((raw) => JSON.parse(raw) as unknown)
      .catch(() => null);
    const previousSignature =
      isRecord(existingNotice) && typeof existingNotice.missingSignature === "string"
        ? existingNotice.missingSignature
        : "";
    const lastNotifiedAtRaw =
      isRecord(existingNotice) && typeof existingNotice.lastNotifiedAt === "string"
        ? existingNotice.lastNotifiedAt
        : isRecord(existingNotice) && typeof existingNotice.sentAt === "string"
          ? existingNotice.sentAt
          : "";
    const lastNotifiedAtMs = (() => {
      if (!lastNotifiedAtRaw.trim().length) return null;
      const parsed = Date.parse(lastNotifiedAtRaw);
      return Number.isFinite(parsed) ? parsed : null;
    })();
    const missingSignature = [
      hasImage ? "image:ok" : "image:missing",
      hasBanner ? "banner:ok" : "banner:missing",
      `persona_missing:${missingPersonaRoles.join(",") || "none"}`,
      serviceReachable ? "service:http_ok" : "service:http_missing",
      commandAvailable ? "service:cmd_ok" : "service:cmd_missing",
    ].join("|");
    const shouldNotifyByTime =
      lastNotifiedAtMs === null || Date.now() - lastNotifiedAtMs >= reminderIntervalMs;
    const shouldNotifyByChange = missingSignature !== previousSignature;
    if (!shouldNotifyByTime && !shouldNotifyByChange) {
      const state: VisualSetupCheckState = {
        ...pendingStateBase,
        notificationState: "cooldown",
      };
      await persistVisualSetupStatus(state);
      return state;
    }

    const openDmData = await deps.callAgentChatBridge({
      action: "open_dm",
      otherMainUserId: ownerMainUserId,
    }).catch(() => null);
    const conversationId = (() => {
      if (!isRecord(openDmData)) return null;
      const directId =
        typeof openDmData.id === "string" ? openDmData.id.trim() : "";
      if (directId.length > 0) return directId;
      const directConversationId =
        typeof openDmData.conversationId === "string"
          ? openDmData.conversationId.trim()
          : "";
      if (directConversationId.length > 0) return directConversationId;
      const nestedConversation =
        isRecord(openDmData.conversation) ? openDmData.conversation : null;
      if (
        nestedConversation &&
        typeof nestedConversation.id === "string" &&
        nestedConversation.id.trim().length > 0
      ) {
        return nestedConversation.id.trim();
      }
      return null;
    })();
    if (!conversationId) {
      const state: VisualSetupCheckState = {
        ...pendingStateBase,
        notificationState: "conversation_unavailable",
      };
      await persistVisualSetupStatus(state);
      return state;
    }

    const guideUrl = `${deps.chatApiBaseUrl}${AGENT_KTHX_GUIDE_PATH}`;
    const setupMessage = [
      `Heads up${ownerHandle ? ` @${ownerHandle}` : ""}: required visual setup is still incomplete.`,
      `Missing right now: ${setupGaps.join("; ")}.`,
      `Guide source (AGENT-KTHX markdown): ${guideUrl}.`,
      `Store/update it at: \`${deps.agentGuideLocalPath}\`.`,
      `Quick fetch command: \`curl -fsSL ${guideUrl} -o ${deps.agentGuideLocalPath}\`.`,
      !serviceReachable && !commandAvailable
        ? "Image generator is not ready yet. Install/start it from the guide, then complete the first browser OpenAI login."
        : "Image generator looks reachable. Next step: generate avatar, banner, and persona reference frames (selfie, midshot, fullbody).",
      "This reminder will continue until avatar, banner, and persona setup are complete.",
    ].join(" ");

    const delivered = await deps.callAgentChatBridge({
      action: "send_message",
      conversationId,
      body: setupMessage,
      format: "markdown",
      metadata: {
        automated: true,
        sourceContext: "SYSTEM",
        setupEvent: "image_persona_setup_required",
        requiredPersonaFrameRoles: REQUIRED_PERSONA_FRAME_ROLES,
        missingPersonaFrameRoles: missingPersonaRoles,
        hasImage,
        hasBanner,
        serviceReachable,
        commandAvailable,
      },
    })
      .then(() => true)
      .catch(() => false);
    if (!delivered) {
      const state: VisualSetupCheckState = {
        ...pendingStateBase,
        notificationState: "delivery_failed",
      };
      await persistVisualSetupStatus(state);
      return state;
    }

    await fs.mkdir(path.dirname(noticePath), { recursive: true }).catch(() => {});
    await fs
      .writeFile(
        noticePath,
        `${JSON.stringify(
          {
            lastNotifiedAt: checkedAt,
            missingSignature,
            setupGaps,
            ownerMainUserId,
            ownerHandle,
            conversationId,
            serviceBaseUrl,
            imageGenerateCmdPreview: imageGenerateCmd?.slice(0, 220) ?? null,
            hasImage,
            hasBanner,
            missingPersonaRoles,
            requiredPersonaFrameRoles: REQUIRED_PERSONA_FRAME_ROLES,
            serviceReachable,
            commandAvailable,
            notificationState: "sent",
          },
          null,
          2,
        )}\n`,
        "utf8",
      )
      .catch(() => {});

    await deps.recordWrite({
        type: "image_generator_setup_owner_notified",
        at: checkedAt,
        ownerMainUserId,
        ownerHandle,
        conversationId,
        serviceBaseUrl,
        hasImage,
        hasBanner,
        missingPersonaRoles,
        serviceReachable,
        commandAvailable,
      })
      .catch(() => {});

    const state: VisualSetupCheckState = {
      ...pendingStateBase,
      notificationState: "sent",
    };
    await persistVisualSetupStatus(state);
    return state;
  };
