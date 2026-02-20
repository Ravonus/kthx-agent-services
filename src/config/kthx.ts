/**
 * Kthx agent configuration: build defaults, normalize, and load/init.
 *
 * Ported from agent-runtime.mjs lines 400-798.
 */

import fs from "node:fs/promises";
import path from "node:path";

import type {
  KthxConfig,
  KthxPathsConfig,
  KthxRetentionConfig,
  RetentionCategoryConfig,
} from "~/types/config.js";
import { isRecord } from "~/lib/guards.js";
import { ensureDir } from "~/lib/fs-helpers.js";
import {
  normalizePersonaToken,
  normalizePersonaDefinitions,
  DEFAULT_MEDIA_PERSONA_DEFINITIONS,
} from "~/lib/persona.js";
import type { PersonaDefinition } from "~/lib/persona.js";

// ---------------------------------------------------------------------------
// Constants (same defaults as agent-runtime.mjs lines 286-333)
// ---------------------------------------------------------------------------

const DEFAULT_KTHX_HOME_DIR = path.resolve(process.cwd(), "kthx-agents");

const DEFAULT_IMAGE_COMMAND_TEMPLATE =
  'generateImage --sync --dir "{dir}" --files "{files}" "{prompt}"';

const DEFAULT_OPENCLAW_PROMPT_TEMPLATE =
  'openclaw agent --agent "{agent}" --json --thinking medium -m "{prompt}"';

// ---------------------------------------------------------------------------
// buildDefaultKthxConfig
// ---------------------------------------------------------------------------

export const buildDefaultKthxConfig = (homeDir: string): KthxConfig => ({
  version: 1,
  paths: {
    homeDir,
    stateDir: path.join(homeDir, "state"),
    generatedDir: path.join(homeDir, "state", "ipc", "generated"),
  },
  openclaw: {
    enabled: true,
    binPath: "",
    agentName: "",
    autoCreateResponseAgent: true,
    responseAgentName: "util-agent",
    responseAgentModel: "anthropic/claude-haiku-4-5",
    listAgentsCommand: "openclaw agents",
    promptCommand: DEFAULT_OPENCLAW_PROMPT_TEMPLATE,
    scheduleCommand: DEFAULT_OPENCLAW_PROMPT_TEMPLATE,
    wakeUrl: "",
    wakeToken: "",
    wakeReasons: [
      "director_directive",
      "mention_directive",
      "director_grant",
      "socket_challenge_required",
      "terminal_prompt_required",
      "socket_subscription_error",
      "terminal_run_required",
      "directive_completed",
    ],
    allowCreateAgent: true,
    createAgentCommand:
      "openclaw agents add {new_agent} --non-interactive --workspace {workspace_root}/{new_agent} --model {response_agent_model} --json",
    timeoutMs: 120_000,
  },
  queue: {
    llmScheduleMinItems: 2,
    minSpacingSeconds: 120,
    maxSpacingSeconds: 1800,
    runnerTickMs: 1000,
    autoRun: true,
  },
  memory: {
    checkpointMinutes: 30,
    agentCompressionCooldownMinutes: 30,
    notificationBufferMax: 4000,
    retention: {
      enabled: false,
      intervalMinutes: 60,
      commands: { days: 7 },
      moods: { days: 30 },
      posts: { days: 90 },
      interactions: { days: 14 },
      notifications: { days: 3 },
      system: { days: 7 },
    },
  },
  image: {
    commandTemplate: DEFAULT_IMAGE_COMMAND_TEMPLATE,
    defaultPersona: "default",
    mediaIndexMaxEntries: 800,
    referenceLookback: 3,
    personas: DEFAULT_MEDIA_PERSONA_DEFINITIONS,
  },
  updates: {
    enabled: true,
    autoUpdateOnStart: true,
    restartAfterUpdate: true,
    haltOnFailure: false,
    repoDir: "",
    remote: "origin",
    branch: "main",
    allowDirtyWorkingTree: false,
    runInstall: true,
    runBuild: true,
    packageManagerExecutable: "pnpm",
    packageManagerUseNpmExecFallback: true,
    timeoutMs: 300_000,
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const safeFiniteInt = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  return fallback;
};

const safeString = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;

const normalizeRetentionDays = (
  source: unknown,
  defaultDays: number,
): RetentionCategoryConfig => {
  if (!isRecord(source)) return { days: defaultDays };
  const days =
    typeof source.days === "number" && Number.isFinite(source.days)
      ? Math.floor(source.days)
      : defaultDays;
  return { days: Math.max(1, Math.min(3650, days)) };
};

// ---------------------------------------------------------------------------
// normalizeKthxConfig
// ---------------------------------------------------------------------------

export const normalizeKthxConfig = (
  rawValue: unknown,
  homeDir: string,
): KthxConfig => {
  const defaults = buildDefaultKthxConfig(homeDir);
  const source = isRecord(rawValue) ? rawValue : {};
  const sourcePaths = isRecord(source.paths) ? source.paths : {};
  const sourceOpenClaw = isRecord(source.openclaw) ? source.openclaw : {};
  const sourceQueue = isRecord(source.queue) ? source.queue : {};
  const sourceMemory = isRecord(source.memory) ? source.memory : {};
  const sourceImage = isRecord(source.image) ? source.image : {};
  const sourceUpdates = isRecord(source.updates) ? source.updates : {};

  // -- numeric fields -------------------------------------------------------
  const openClawTimeoutRaw = safeFiniteInt(
    sourceOpenClaw.timeoutMs,
    defaults.openclaw.timeoutMs,
  );
  const queueLlmScheduleMinItemsRaw = safeFiniteInt(
    sourceQueue.llmScheduleMinItems,
    defaults.queue.llmScheduleMinItems,
  );
  const queueMinSpacingRaw = safeFiniteInt(
    sourceQueue.minSpacingSeconds,
    defaults.queue.minSpacingSeconds,
  );
  const queueMaxSpacingRaw = safeFiniteInt(
    sourceQueue.maxSpacingSeconds,
    defaults.queue.maxSpacingSeconds,
  );
  const queueRunnerTickRaw = safeFiniteInt(
    sourceQueue.runnerTickMs,
    defaults.queue.runnerTickMs,
  );
  const queueAutoRun =
    typeof sourceQueue.autoRun === "boolean"
      ? sourceQueue.autoRun
      : defaults.queue.autoRun;

  const memoryCheckpointMinutesRaw = safeFiniteInt(
    sourceMemory.checkpointMinutes,
    defaults.memory.checkpointMinutes,
  );
  const memoryNotificationBufferMaxRaw = safeFiniteInt(
    sourceMemory.notificationBufferMax,
    defaults.memory.notificationBufferMax,
  );
  const memoryAgentCompressionCooldownMinutesRaw = safeFiniteInt(
    sourceMemory.agentCompressionCooldownMinutes,
    defaults.memory.agentCompressionCooldownMinutes,
  );

  // -- retention ------------------------------------------------------------
  const sourceRetention = isRecord(sourceMemory.retention)
    ? sourceMemory.retention
    : {};
  const retentionEnabled =
    typeof sourceRetention.enabled === "boolean"
      ? sourceRetention.enabled
      : defaults.memory.retention.enabled;
  const retentionIntervalMinutesRaw = safeFiniteInt(
    sourceRetention.intervalMinutes,
    defaults.memory.retention.intervalMinutes,
  );

  // -- paths ----------------------------------------------------------------
  const resolvedHomeDir: string =
    typeof sourcePaths.homeDir === "string" &&
    (sourcePaths.homeDir as string).trim().length > 0
      ? path.resolve((sourcePaths.homeDir as string).trim())
      : defaults.paths.homeDir;
  const resolvedStateDir: string =
    typeof sourcePaths.stateDir === "string" &&
    (sourcePaths.stateDir as string).trim().length > 0
      ? path.resolve((sourcePaths.stateDir as string).trim())
      : path.join(resolvedHomeDir, "state");
  const resolvedGeneratedDir: string =
    typeof sourcePaths.generatedDir === "string" &&
    (sourcePaths.generatedDir as string).trim().length > 0
      ? path.resolve((sourcePaths.generatedDir as string).trim())
      : path.join(resolvedStateDir, "ipc", "generated");

  // -- openclaw strings -----------------------------------------------------
  const sourcePromptCommand = safeString(sourceOpenClaw.promptCommand, "");
  const sourceScheduleCommand = safeString(
    sourceOpenClaw.scheduleCommand,
    "",
  );
  const promptCommand =
    sourcePromptCommand.length > 0
      ? sourcePromptCommand
      : defaults.openclaw.promptCommand;
  const scheduleCommand =
    sourceScheduleCommand.length > 0
      ? sourceScheduleCommand
      : defaults.openclaw.scheduleCommand;

  // -- image config ---------------------------------------------------------
  const sourceImageCommandTemplate = safeString(
    sourceImage.commandTemplate,
    "",
  );
  const imageCommandTemplate =
    sourceImageCommandTemplate.length > 0
      ? sourceImageCommandTemplate
      : defaults.image.commandTemplate;

  const defaultPersonaRaw = normalizePersonaToken(sourceImage.defaultPersona);
  const defaultPersona =
    defaultPersonaRaw.length > 0
      ? defaultPersonaRaw
      : normalizePersonaToken(defaults.image.defaultPersona) || "default";

  const mediaIndexMaxEntriesRaw = safeFiniteInt(
    sourceImage.mediaIndexMaxEntries,
    defaults.image.mediaIndexMaxEntries,
  );
  const referenceLookbackRaw = safeFiniteInt(
    sourceImage.referenceLookback,
    defaults.image.referenceLookback,
  );
  const updatesTimeoutRaw = safeFiniteInt(
    sourceUpdates.timeoutMs,
    defaults.updates.timeoutMs,
  );

  const personas: PersonaDefinition[] = normalizePersonaDefinitions(
    sourceImage.personas,
    defaults.image.personas,
  );
  if (!personas.some((item) => item.name === defaultPersona)) {
    personas.unshift({
      name: defaultPersona,
      aliases: [],
      labels: [defaultPersona],
      styleHint: "",
    });
  }

  // -- assemble -------------------------------------------------------------
  const paths: KthxPathsConfig = {
    homeDir: resolvedHomeDir,
    stateDir: resolvedStateDir,
    generatedDir: resolvedGeneratedDir,
  };

  const retention: KthxRetentionConfig = {
    enabled: retentionEnabled,
    intervalMinutes: Math.max(10, Math.min(1440, retentionIntervalMinutesRaw)),
    commands: normalizeRetentionDays(
      sourceRetention.commands,
      defaults.memory.retention.commands.days,
    ),
    moods: normalizeRetentionDays(
      sourceRetention.moods,
      defaults.memory.retention.moods.days,
    ),
    posts: normalizeRetentionDays(
      sourceRetention.posts,
      defaults.memory.retention.posts.days,
    ),
    interactions: normalizeRetentionDays(
      sourceRetention.interactions,
      defaults.memory.retention.interactions.days,
    ),
    notifications: normalizeRetentionDays(
      sourceRetention.notifications,
      defaults.memory.retention.notifications.days,
    ),
    system: normalizeRetentionDays(
      sourceRetention.system,
      defaults.memory.retention.system.days,
    ),
  };

  return {
    version: 1,
    paths,
    openclaw: {
      enabled: sourceOpenClaw.enabled !== false,
      binPath: safeString(sourceOpenClaw.binPath, ""),
      agentName: safeString(sourceOpenClaw.agentName, ""),
      autoCreateResponseAgent:
        typeof sourceOpenClaw.autoCreateResponseAgent === "boolean"
          ? sourceOpenClaw.autoCreateResponseAgent
          : defaults.openclaw.autoCreateResponseAgent,
      responseAgentName: safeString(
        sourceOpenClaw.responseAgentName,
        defaults.openclaw.responseAgentName,
      ),
      responseAgentModel: safeString(
        sourceOpenClaw.responseAgentModel,
        defaults.openclaw.responseAgentModel,
      ),
      listAgentsCommand: safeString(
        sourceOpenClaw.listAgentsCommand,
        defaults.openclaw.listAgentsCommand,
      ),
      promptCommand,
      scheduleCommand,
      wakeUrl: safeString(sourceOpenClaw.wakeUrl, ""),
      wakeToken: safeString(sourceOpenClaw.wakeToken, ""),
      wakeReasons: Array.isArray(sourceOpenClaw.wakeReasons)
        ? (sourceOpenClaw.wakeReasons as unknown[])
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter((value) => value.length > 0)
        : defaults.openclaw.wakeReasons,
      allowCreateAgent:
        typeof sourceOpenClaw.allowCreateAgent === "boolean"
          ? sourceOpenClaw.allowCreateAgent
          : defaults.openclaw.allowCreateAgent,
      createAgentCommand: safeString(
        sourceOpenClaw.createAgentCommand,
        defaults.openclaw.createAgentCommand,
      ),
      timeoutMs: Math.max(15_000, Math.min(300_000, openClawTimeoutRaw)),
    },
    queue: {
      llmScheduleMinItems: Math.max(
        2,
        Math.min(20, queueLlmScheduleMinItemsRaw),
      ),
      minSpacingSeconds: Math.max(10, Math.min(86_400, queueMinSpacingRaw)),
      maxSpacingSeconds: Math.max(10, Math.min(604_800, queueMaxSpacingRaw)),
      runnerTickMs: Math.max(250, Math.min(10_000, queueRunnerTickRaw)),
      autoRun: queueAutoRun === true,
    },
    memory: {
      checkpointMinutes: Math.max(
        1,
        Math.min(720, memoryCheckpointMinutesRaw),
      ),
      agentCompressionCooldownMinutes: Math.max(
        1,
        Math.min(720, memoryAgentCompressionCooldownMinutesRaw),
      ),
      notificationBufferMax: Math.max(
        100,
        Math.min(50_000, memoryNotificationBufferMaxRaw),
      ),
      retention,
    },
    image: {
      commandTemplate: imageCommandTemplate,
      defaultPersona,
      mediaIndexMaxEntries: Math.max(
        100,
        Math.min(5000, mediaIndexMaxEntriesRaw),
      ),
      referenceLookback: Math.max(1, Math.min(8, referenceLookbackRaw)),
      personas,
    },
    updates: {
      enabled:
        typeof sourceUpdates.enabled === "boolean"
          ? sourceUpdates.enabled
          : defaults.updates.enabled,
      autoUpdateOnStart:
        typeof sourceUpdates.autoUpdateOnStart === "boolean"
          ? sourceUpdates.autoUpdateOnStart
          : defaults.updates.autoUpdateOnStart,
      restartAfterUpdate:
        typeof sourceUpdates.restartAfterUpdate === "boolean"
          ? sourceUpdates.restartAfterUpdate
          : defaults.updates.restartAfterUpdate,
      haltOnFailure:
        typeof sourceUpdates.haltOnFailure === "boolean"
          ? sourceUpdates.haltOnFailure
          : defaults.updates.haltOnFailure,
      repoDir:
        typeof sourceUpdates.repoDir === "string"
          ? sourceUpdates.repoDir.trim()
          : defaults.updates.repoDir,
      remote: safeString(sourceUpdates.remote, defaults.updates.remote),
      branch: safeString(sourceUpdates.branch, defaults.updates.branch),
      allowDirtyWorkingTree:
        typeof sourceUpdates.allowDirtyWorkingTree === "boolean"
          ? sourceUpdates.allowDirtyWorkingTree
          : defaults.updates.allowDirtyWorkingTree,
      runInstall:
        typeof sourceUpdates.runInstall === "boolean"
          ? sourceUpdates.runInstall
          : defaults.updates.runInstall,
      runBuild:
        typeof sourceUpdates.runBuild === "boolean"
          ? sourceUpdates.runBuild
          : defaults.updates.runBuild,
      packageManagerExecutable: safeString(
        sourceUpdates.packageManagerExecutable,
        defaults.updates.packageManagerExecutable,
      ),
      packageManagerUseNpmExecFallback:
        typeof sourceUpdates.packageManagerUseNpmExecFallback === "boolean"
          ? sourceUpdates.packageManagerUseNpmExecFallback
          : defaults.updates.packageManagerUseNpmExecFallback,
      timeoutMs: Math.max(10_000, Math.min(900_000, updatesTimeoutRaw)),
    },
  };
};

// ---------------------------------------------------------------------------
// loadOrInitKthxConfig
// ---------------------------------------------------------------------------

export type LoadOrInitKthxResult = {
  path: string;
  config: KthxConfig;
  created: boolean;
  resetFromInvalid?: boolean;
};

export const loadOrInitKthxConfig = async ({
  configPath,
  homeDir,
}: {
  configPath?: string;
  homeDir?: string;
}): Promise<LoadOrInitKthxResult> => {
  const normalizedHomeDir =
    typeof homeDir === "string" && homeDir.trim().length > 0
      ? path.resolve(homeDir)
      : DEFAULT_KTHX_HOME_DIR;
  const targetPath =
    typeof configPath === "string" && configPath.trim().length > 0
      ? path.resolve(configPath)
      : path.join(normalizedHomeDir, "config.json");

  const defaults = normalizeKthxConfig({}, normalizedHomeDir);
  await ensureDir(path.dirname(targetPath));

  const existingRaw = await fs
    .readFile(targetPath, "utf8")
    .catch(() => null);

  if (!existingRaw) {
    await fs.writeFile(
      targetPath,
      `${JSON.stringify(defaults, null, 2)}\n`,
      "utf8",
    );
    return { path: targetPath, config: defaults, created: true };
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(existingRaw);
  } catch {
    parsed = null;
  }

  if (!isRecord(parsed)) {
    const backupPath = `${targetPath}.invalid-${Date.now()}.json`;
    await fs.copyFile(targetPath, backupPath).catch(() => {
      /* best-effort */
    });
    await fs.writeFile(
      targetPath,
      `${JSON.stringify(defaults, null, 2)}\n`,
      "utf8",
    );
    return {
      path: targetPath,
      config: defaults,
      created: false,
      resetFromInvalid: true,
    };
  }

  const normalized = normalizeKthxConfig(parsed, normalizedHomeDir);
  const normalizedRaw = `${JSON.stringify(normalized, null, 2)}\n`;
  if (normalizedRaw !== `${existingRaw.trim()}\n`) {
    await fs.writeFile(targetPath, normalizedRaw, "utf8").catch(() => {
      /* best-effort */
    });
  }
  return { path: targetPath, config: normalized, created: false };
};
