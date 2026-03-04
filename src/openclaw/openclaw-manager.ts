/**
 * OpenClawManager: integration layer for the OpenClaw AI agent CLI,
 * including agent name resolution, prompt execution, wake batching,
 * and agent creation.
 *
 * Ported from agent-runtime.mjs lines 4831-5094 (shell commands,
 * agent resolution, prompt), lines 6285-6361 (create agent),
 * and lines 7409-7730 (wake classification and batching).
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { trimEnv } from "../lib/env-parse.js";
import { isRecord } from "../lib/guards.js";
import { nowIso, toAnswerPreview } from "../lib/text.js";
import {
  parseJsonFromMixedText,
  unwrapOpenClawEnvelopePayload,
} from "../lib/parsing.js";
import type { OpenClawManagerLike } from "../runtime-context.js";
import {
  classifyOpenClawWake,
  normalizeWakeInput,
  getWakeDebounceKey,
  buildWakeBody,
  buildBatchWakeBody,
  isActionableWake,
  deliverWakeBody,
  type WakeInput,
} from "./openclaw-wake.js";
import {
  applyOpenClawBinaryToShellCommand,
  resolveOpenClawBinary,
  withOpenClawPathInEnv,
  type OpenClawBinaryResolution,
} from "./openclaw-binary.js";
import {
  DEFAULT_RESPONSE_AGENT_MODEL,
  MINT_CHALLENGE_TIMEOUT_MS,
  MINT_CHALLENGE_UTIL_ALLOWED_ENV_KEYS,
  MINT_CHALLENGE_UTIL_INHERIT_NONE,
  MINT_CHALLENGE_UTIL_READONLY_CWD,
  applyMintChallengeExtraFlags,
  buildMintChallengeSubprocessEnv,
  cleanupMintUtilTempCwd,
  enforceMintChallengeFastThinking,
  listOutputIncludesAgent,
  normalizeModelToken,
  parseOpenClawAgentName,
  parseOpenClawStdoutDelta,
  prepareMintUtilTempCwd,
  resolveAgentFromListOutput,
  resolveResponseAgentModelFromListOutput,
  resolveTemplateCommand,
  writeUtilAgentWorkspace,
} from "./openclaw-manager-helpers.js";

export { parseOpenClawStdoutDelta } from "./openclaw-manager-helpers.js";

// ---------------------------------------------------------------------------
// Narrow context interface
// ---------------------------------------------------------------------------

export interface OpenClawManagerContext {
  config: {
    agentHomeDir: string;
    stateDir: string;
    kthxConfigPath: string;
    chatRuntimeTextStreamEnabled: boolean;
    chatRuntimeTextStreamNativeEnabled: boolean;
    openClawWakeDebounceMs: number;
    openClawWakeBatchMs: number;
    openClawWakeIncludeSocketStateChange: boolean;
    openClawWakeIncludeMediaPrepared: boolean;
  };
  openclaw: OpenClawTrackingState;
  openclawConfig: () => OpenClawConfigSnapshot | null;
  memory: { recordWrite(payload: unknown): Promise<void> };
  ipcPaths: {
    hookRequestsPath: string;
    hookWakePath: string;
    wakePath: string;
  };
  touchWake: (path: string) => Promise<void>;
}

export interface OpenClawConfigSnapshot {
  enabled: boolean;
  binPath: string;
  agentName: string;
  autoCreateResponseAgent: boolean;
  responseAgentName: string;
  responseAgentModel: string;
  listAgentsCommand: string;
  promptCommand: string;
  scheduleCommand: string;
  wakeUrl: string;
  wakeToken: string;
  wakeReasons: string[];
  allowCreateAgent: boolean;
  createAgentCommand: string;
  timeoutMs: number;
}

export interface OpenClawTrackingState {
  openClawWakeUrl: string | null;
  openClawWakeKey: string | null;
  openClawWakeReasonSet: Set<string> | null;
  resolvedOpenClawBin: string | null;
  openClawBinSource: string | null;
  openClawBinResolvedPath: string | null;
  openClawBinResolutionWarning: string | null;
  openClawBinAvailable: boolean | null;
  openClawBinVersion: string | null;
  openClawBinCheckedAtMs: number;
  openClawBinLastError: string | null;
  resolvedOpenClawAgentName: string | null;
  openClawAgentResolvedAtMs: number;
  openClawDraftCache: Map<string, unknown>;
}

export interface ShellResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
}

export interface OpenClawPromptResult {
  parsed: unknown;
  raw: string;
  agentName: string | null;
  payloadText: string | null;
  envelope: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Helper constants/parsers are in openclaw-manager-helpers.ts.

// ---------------------------------------------------------------------------
// OpenClawManager class
// ---------------------------------------------------------------------------

export class OpenClawManager implements OpenClawManagerLike {
  private readonly ctx: OpenClawManagerContext;
  private commandLock: Promise<void> = Promise.resolve();
  private wakeDebounceByKey = new Map<string, number>();
  private wakeBatchTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeBatchItems: WakeInput[] = [];
  private lastSocketWakeConnectivity: boolean | null = null;
  private mintSandboxPolicyLogged = false;
  private openClawBinaryCache: {
    cacheKey: string;
    value: OpenClawBinaryResolution;
  } | null = null;

  constructor(ctx: OpenClawManagerContext) { this.ctx = ctx; }

  private getOpenClawBinaryResolution(): OpenClawBinaryResolution {
    const ocConfig = this.ctx.openclawConfig();
    const configuredBinPath =
      typeof ocConfig?.binPath === "string" ? ocConfig.binPath.trim() : "";
    const envOverride = trimEnv("MG_OPENCLAW_BIN") ?? trimEnv("OPENCLAW_BIN") ?? "";
    const cacheKey = `${configuredBinPath}::${envOverride}`;
    if (this.openClawBinaryCache?.cacheKey === cacheKey) {
      return this.openClawBinaryCache.value;
    }
    const resolution = resolveOpenClawBinary({
      configuredBinPath: configuredBinPath.length > 0 ? configuredBinPath : null,
    });
    this.openClawBinaryCache = { cacheKey, value: resolution };
    this.ctx.openclaw.resolvedOpenClawBin = resolution.command;
    this.ctx.openclaw.openClawBinSource = resolution.source;
    this.ctx.openclaw.openClawBinResolvedPath = resolution.resolvedPath;
    this.ctx.openclaw.openClawBinResolutionWarning = resolution.warning;
    return resolution;
  }

  async resolveAgentName(): Promise<string | null> {
    const ocConfig = this.ctx.openclawConfig();
    if (!ocConfig || !ocConfig.enabled) return null;
    if (typeof ocConfig.agentName === "string" && ocConfig.agentName.trim().length > 0) return ocConfig.agentName.trim();
    if (this.ctx.openclaw.resolvedOpenClawAgentName && Date.now() - this.ctx.openclaw.openClawAgentResolvedAtMs < 120_000) {
      return this.ctx.openclaw.resolvedOpenClawAgentName;
    }
    const openClawBinary = this.getOpenClawBinaryResolution();
    const listTemplate =
      typeof ocConfig.listAgentsCommand === "string" && ocConfig.listAgentsCommand.trim().length > 0
        ? ocConfig.listAgentsCommand.trim()
        : "openclaw agents";
    const listCommand = applyOpenClawBinaryToShellCommand(
      listTemplate,
      openClawBinary,
    );
    const timeoutMs = typeof ocConfig.timeoutMs === "number" && Number.isFinite(ocConfig.timeoutMs)
      ? Math.max(5_000, Math.floor(ocConfig.timeoutMs / 2)) : 60_000;
    const result = await this.runLockedShellCommand({ command: listCommand, timeoutMs });
    if (!result.ok) {
      await this.ctx.memory.recordWrite({
        type: "openclaw_agent_resolution_failed",
        at: nowIso(),
        reason: "list_failed",
        code: result.code,
        stderrPreview: toAnswerPreview(result.stderr, 180),
      });
      return await this.tryAutoCreateUtilAgent(ocConfig);
    }
    const selected = resolveAgentFromListOutput(result.stdout);
    if (!selected) {
      const modelOverride = resolveResponseAgentModelFromListOutput(
        result.stdout,
        parseOpenClawAgentName(ocConfig.responseAgentName) ?? "util-agent",
      );
      await this.ctx.memory.recordWrite({
        type: "openclaw_agent_resolution_failed",
        at: nowIso(),
        reason: "no_default_agent_in_list",
        stdoutPreview: toAnswerPreview(result.stdout, 180),
        responseAgentModelOverride: modelOverride,
      });
      return await this.tryAutoCreateUtilAgent(ocConfig, modelOverride);
    }
    this.ctx.openclaw.resolvedOpenClawAgentName = selected;
    this.ctx.openclaw.openClawAgentResolvedAtMs = Date.now();
    return selected;
  }

  async ensureUtilAgent(): Promise<void> {
    const ocConfig = this.ctx.openclawConfig();
    if (!ocConfig?.enabled) return;
    const targetName =
      parseOpenClawAgentName(ocConfig.responseAgentName) ?? "util-agent";
    const configuredModel = normalizeModelToken(ocConfig.responseAgentModel);
    const binary = this.getOpenClawBinaryResolution();
    const listCmd = applyOpenClawBinaryToShellCommand(
      ocConfig.listAgentsCommand || "openclaw agents",
      binary,
    );
    const result = await this.runLockedShellCommand({
      command: listCmd,
      timeoutMs: 30_000,
    });
    const detectedModel = result.ok
      ? resolveResponseAgentModelFromListOutput(result.stdout, targetName)
      : null;
    const responseAgentModel =
      detectedModel ?? configuredModel ?? DEFAULT_RESPONSE_AGENT_MODEL;
    if (result.ok && listOutputIncludesAgent(result.stdout, targetName)) {
      await writeUtilAgentWorkspace(this.ctx.config.agentHomeDir, targetName).catch(
        () => {},
      );
      await this.ctx.memory.recordWrite({
        type: "openclaw_util_agent_already_present",
        at: nowIso(),
        agentName: targetName,
        responseAgentModel,
      });
      return;
    }
    if (!result.ok) {
      await this.ctx.memory.recordWrite({
        type: "openclaw_util_agent_list_failed",
        at: nowIso(),
        agentName: targetName,
        code: result.code,
        stderrPreview: toAnswerPreview(result.stderr, 180),
      });
    }
    await this.ctx.memory.recordWrite({
      type: "openclaw_util_agent_auto_create_start",
      at: nowIso(),
      agentName: targetName,
      responseAgentModel,
    });
    const created = await this.createAgent({
      agentName: targetName,
      source: "startup_ensure_util_agent",
      responseAgentModelOverride: responseAgentModel,
    });
    await this.ctx.memory.recordWrite({
      type: "openclaw_util_agent_auto_create_result",
      at: nowIso(),
      agentName: targetName,
      responseAgentModel,
      ok: created.ok,
      error: created.error ?? null,
    });
  }

  private async tryAutoCreateUtilAgent(
    ocConfig: OpenClawConfigSnapshot,
    modelOverride: string | null = null,
  ): Promise<string | null> {
    const targetName =
      parseOpenClawAgentName(ocConfig.responseAgentName) ?? "util-agent";
    const configuredModel = normalizeModelToken(ocConfig.responseAgentModel);
    const responseAgentModel =
      normalizeModelToken(modelOverride ?? "") ??
      configuredModel ??
      DEFAULT_RESPONSE_AGENT_MODEL;
    const created = await this.createAgent({
      agentName: targetName,
      source: "auto_util_agent_bootstrap",
      responseAgentModelOverride: responseAgentModel,
    });
    if (!created.ok) {
      await this.ctx.memory.recordWrite({
        type: "openclaw_util_agent_auto_create_failed",
        at: nowIso(),
        agentName: targetName,
        responseAgentModel,
        error: created.error ?? "unknown_error",
      });
      return null;
    }
    this.ctx.openclaw.resolvedOpenClawAgentName = targetName;
    this.ctx.openclaw.openClawAgentResolvedAtMs = Date.now();
    await this.ctx.memory.recordWrite({
      type: "openclaw_util_agent_auto_created",
      at: nowIso(),
      agentName: targetName,
      responseAgentModel,
    });
    return targetName;
  }

  async prompt(
    input: string,
    opts?: { purpose?: string; onTextDelta?: ((delta: string) => void) | null },
  ): Promise<OpenClawPromptResult | null> {
    return this.promptWithAgent(input, opts, null);
  }

  async promptAgent(
    agentName: string,
    input: string,
    opts?: { purpose?: string; onTextDelta?: ((delta: string) => void) | null },
  ): Promise<OpenClawPromptResult | null> {
    const parsedAgentName = parseOpenClawAgentName(agentName);
    if (!parsedAgentName) {
      await this.ctx.memory.recordWrite({
        type: "openclaw_prompt_skipped",
        at: nowIso(),
        purpose: opts?.purpose ?? "general",
        reason: "invalid_agent_name",
      });
      return null;
    }
    return this.promptWithAgent(input, opts, parsedAgentName);
  }

  private async promptWithAgent(
    input: string,
    opts: { purpose?: string; onTextDelta?: ((delta: string) => void) | null } | undefined,
    explicitAgentName: string | null,
  ): Promise<OpenClawPromptResult | null> {
    const purpose = opts?.purpose ?? "general";
    const isMintChallenge = purpose === "mint_challenge";
    const onTextDelta = opts?.onTextDelta ?? null;
    const ocConfig = this.ctx.openclawConfig();
    if (!ocConfig || !ocConfig.enabled) {
      await this.ctx.memory.recordWrite({ type: "openclaw_prompt_skipped", at: nowIso(), purpose, reason: "disabled" });
      return null;
    }
    const template = purpose === "schedule" ? ocConfig.scheduleCommand : ocConfig.promptCommand;
    if (typeof template !== "string" || !template.trim().length) {
      await this.ctx.memory.recordWrite({ type: "openclaw_prompt_skipped", at: nowIso(), purpose, reason: "missing_template" });
      return null;
    }
    const agentName = explicitAgentName ?? (await this.resolveAgentName());
    const resolvedPrompt = typeof input === "string" ? input.trim() : "";
    if (!resolvedPrompt.length) {
      await this.ctx.memory.recordWrite({ type: "openclaw_prompt_skipped", at: nowIso(), purpose, reason: "empty_prompt" });
      return null;
    }
    const promptForCommand = resolvedPrompt.replace(/\r?\n/gu, " ").replaceAll('"', '\\"');
    const openClawBinary = this.getOpenClawBinaryResolution();
    const command = resolveTemplateCommand(
      template.replaceAll("{prompt}", promptForCommand),
      agentName,
      this.ctx.config,
      openClawBinary,
    );
    const effectiveCommand = isMintChallenge
      ? applyMintChallengeExtraFlags(
          enforceMintChallengeFastThinking(command),
        )
      : command;
    const configuredTimeoutMs =
      typeof ocConfig.timeoutMs === "number" && Number.isFinite(ocConfig.timeoutMs)
        ? Math.max(15_000, Math.floor(ocConfig.timeoutMs))
        : 120_000;
    const timeoutMs = isMintChallenge
      ? Math.min(configuredTimeoutMs, MINT_CHALLENGE_TIMEOUT_MS)
      : configuredTimeoutMs;
    const allowNativeTextStreaming = purpose === "chat_reply"
      && this.ctx.config.chatRuntimeTextStreamEnabled
      && this.ctx.config.chatRuntimeTextStreamNativeEnabled
      && typeof onTextDelta === "function";
    const runCommand = isMintChallenge
      ? this.runShellCommand.bind(this)
      : this.runLockedShellCommand.bind(this);
    const result = await runCommand({
      command: effectiveCommand, timeoutMs,
      ...(isMintChallenge ? { executionProfile: "mint_challenge_util" as const } : {}),
      ...(allowNativeTextStreaming ? { onStdoutData: (chunk: string) => { const delta = parseOpenClawStdoutDelta(chunk); if (delta.length) onTextDelta(delta); } } : {}),
    });
    if (isMintChallenge && !this.mintSandboxPolicyLogged) {
      this.mintSandboxPolicyLogged = true;
      await this.ctx.memory.recordWrite({
        type: "mint_challenge_util_agent_policy",
        at: nowIso(),
        envInherit: MINT_CHALLENGE_UTIL_INHERIT_NONE ? "none" : "process",
        readOnlyCwd: MINT_CHALLENGE_UTIL_READONLY_CWD,
        allowedEnvKeys: MINT_CHALLENGE_UTIL_ALLOWED_ENV_KEYS,
        openClawBinarySource: openClawBinary.source,
      });
    }
    const stdoutText = typeof result.stdout === "string" ? result.stdout.trim() : "";
    const stderrText = typeof result.stderr === "string" ? result.stderr.trim() : "";
    const parseSourceRaw = stdoutText.length > 0 ? result.stdout : stderrText.length > 0 ? result.stderr : result.stdout;
    const parseSource = stdoutText.length > 0 ? "stdout" : stderrText.length > 0 ? "stderr" : "none";
    await this.ctx.memory.recordWrite({
      type: "openclaw_prompt_result", at: nowIso(), purpose, ok: result.ok,
      code: result.code, agentName: agentName ?? null,
      executionMode: isMintChallenge ? "direct_subprocess" : "locked_subprocess",
      commandPreview: toAnswerPreview(effectiveCommand, 180),
      stdoutPreview: toAnswerPreview(result.stdout, 240),
      stderrPreview: toAnswerPreview(result.stderr, 240),
      parseSource,
    });
    const canParseFailedMintResult =
      isMintChallenge && parseSourceRaw.trim().length > 0;
    if (!result.ok && !canParseFailedMintResult) return null;
    if (!result.ok && canParseFailedMintResult) {
      await this.ctx.memory.recordWrite({
        type: "openclaw_prompt_nonzero_with_output",
        at: nowIso(),
        purpose,
        code: result.code,
        parseSource,
        stdoutPreview: toAnswerPreview(result.stdout, 240),
        stderrPreview: toAnswerPreview(result.stderr, 240),
      });
    }
    const parsedRaw = parseJsonFromMixedText(parseSourceRaw);
    let parsed = parsedRaw;
    let payloadText: string | null = null;
    let envelope: Record<string, unknown> | null = null;
    if (parsedRaw !== null) {
      const unwrapped = unwrapOpenClawEnvelopePayload(parsedRaw);
      parsed = unwrapped.parsed; payloadText = unwrapped.payloadText; envelope = unwrapped.envelope;
    } else {
      const fallbackText = parseSourceRaw.trim();
      if (fallbackText.length > 0) { parsed = { text: fallbackText }; payloadText = fallbackText; }
    }
    return { parsed, raw: parseSourceRaw, agentName, payloadText, envelope };
  }

  scheduleWake(reasons: string[]): void {
    for (const reason of reasons) {
      this.wakeBatchItems.push({ reason, topic: "runtime:wake", receivedAt: nowIso(), eventId: null, source: null, hint: null });
    }
    this.scheduleFlush();
  }

  async wakeFromEnvelope(envelope: unknown): Promise<void> {
    const wakeMeta = classifyOpenClawWake(envelope);
    if (!wakeMeta) return;
    await this.postWake({
      reason: wakeMeta.reason,
      topic: isRecord(envelope) && typeof envelope.topic === "string" ? envelope.topic : "runtime:unknown",
      receivedAt: isRecord(envelope) && typeof envelope.receivedAt === "string" ? envelope.receivedAt : nowIso(),
      eventId: wakeMeta.eventId ?? null, source: wakeMeta.source ?? null, hint: null,
    });
  }

  async createAgent(opts: {
    agentName: string;
    source?: string;
    responseAgentModelOverride?: string;
  }): Promise<{ ok: boolean; error?: string; agentName?: string; stdout?: string }> {
    const parsedName = parseOpenClawAgentName(opts.agentName);
    if (!parsedName) return { ok: false, error: "Invalid agent name. Use only letters, numbers, dot, underscore, or dash (max 64 chars)." };
    const ocConfig = this.ctx.openclawConfig();
    if (!ocConfig || !ocConfig.enabled) return { ok: false, error: "OpenClaw integration is disabled in config." };
    const source = opts.source ?? "runtime";
    const bypassAllowCreateGate =
      source === "startup_ensure_util_agent" ||
      source === "auto_util_agent_bootstrap";
    if (ocConfig.allowCreateAgent !== true && !bypassAllowCreateGate) {
      return {
        ok: false,
        error:
          "Agent creation is disabled. Set openclaw.allowCreateAgent=true in kthx config.",
      };
    }
    const template = typeof ocConfig.createAgentCommand === "string" ? ocConfig.createAgentCommand.trim() : "";
    if (!template.length) return { ok: false, error: "openclaw.createAgentCommand is empty." };
    const resolvedResponseAgentModel =
      normalizeModelToken(opts.responseAgentModelOverride ?? "") ??
      normalizeModelToken(ocConfig.responseAgentModel) ??
      DEFAULT_RESPONSE_AGENT_MODEL;
    const currentAgent =
      this.ctx.openclaw.resolvedOpenClawAgentName ??
      (typeof ocConfig.agentName === "string" && ocConfig.agentName.trim().length > 0
        ? ocConfig.agentName.trim()
        : null);
    const openClawBinary = this.getOpenClawBinaryResolution();
    const command = resolveTemplateCommand(
      template,
      currentAgent,
      this.ctx.config,
      openClawBinary,
      {
        "{new_agent}": parsedName,
        "{response_agent_model}": resolvedResponseAgentModel.replaceAll(
          '"',
          '\\"',
        ),
      },
    );
    const timeoutMs = typeof ocConfig.timeoutMs === "number" && Number.isFinite(ocConfig.timeoutMs)
      ? Math.max(15_000, Math.floor(ocConfig.timeoutMs)) : 120_000;
    const result = await this.runLockedShellCommand({ command, timeoutMs });
    await this.ctx.memory.recordWrite({
      type: "openclaw_create_agent_result", at: nowIso(), source, requestedAgentName: parsedName,
      ok: result.ok, code: result.code, commandPreview: toAnswerPreview(command, 180),
      responseAgentModel: resolvedResponseAgentModel,
      stdoutPreview: toAnswerPreview(result.stdout, 180), stderrPreview: toAnswerPreview(result.stderr, 180),
    });
    if (!result.ok) {
      const errorMessage = typeof result.stderr === "string" && result.stderr.trim().length > 0 ? result.stderr.trim()
        : typeof result.error === "string" && result.error.trim().length > 0 ? result.error.trim() : "create agent command failed";
      return { ok: false, error: errorMessage };
    }
    if (
      parsedName ===
      (parseOpenClawAgentName(ocConfig.responseAgentName) ?? "util-agent")
    ) {
      await writeUtilAgentWorkspace(this.ctx.config.agentHomeDir, parsedName).catch(
        () => {},
      );
    }
    return { ok: true, agentName: parsedName, stdout: result.stdout };
  }

  dispose(): void {
    if (this.wakeBatchTimer) { clearTimeout(this.wakeBatchTimer); this.wakeBatchTimer = null; }
  }

  // -----------------------------------------------------------------------
  // Private: shell command execution with serialised lock
  // -----------------------------------------------------------------------

  private async runLockedShellCommand(opts: {
    command: string; timeoutMs: number;
    extraEnv?: Record<string, string>;
    executionProfile?: "default" | "mint_challenge_util";
    onStdoutData?: ((chunk: string) => void) | null;
  }): Promise<ShellResult> {
    let release: () => void = () => {};
    const pending = this.commandLock;
    this.commandLock = new Promise((resolve) => { release = resolve; });
    await pending;
    try { return await this.runShellCommand(opts); } finally { release(); }
  }

  private runShellCommand(opts: {
    command: string; timeoutMs: number;
    extraEnv?: Record<string, string>;
    executionProfile?: "default" | "mint_challenge_util";
    onStdoutData?: ((chunk: string) => void) | null;
  }): Promise<ShellResult> {
    return new Promise((resolve) => {
      const openClawBinary = this.getOpenClawBinaryResolution();
      const isMintChallengeUtil = opts.executionProfile === "mint_challenge_util";
      const baseEnv = isMintChallengeUtil
        ? buildMintChallengeSubprocessEnv(openClawBinary)
        : withOpenClawPathInEnv({ ...process.env }, openClawBinary);
      const mergedEnv: NodeJS.ProcessEnv = {
        ...baseEnv,
        ...(opts.extraEnv ?? {}),
      };

      let tempCwd: string | null = null;
      const spawnWithCwd = async (): Promise<void> => {
        if (!isMintChallengeUtil) return;
        tempCwd = await prepareMintUtilTempCwd();
      };

      const cleanupCwd = async (): Promise<void> => {
        await cleanupMintUtilTempCwd(tempCwd);
      };

      void spawnWithCwd().then(() => {
      const child = spawn(opts.command, {
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: mergedEnv,
        ...(tempCwd ? { cwd: tempCwd } : {}),
      });
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      const timer = setTimeout(() => { child.kill("SIGTERM"); }, opts.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        const text = String(chunk); stdoutChunks.push(text);
        if (typeof opts.onStdoutData === "function") { try { opts.onStdoutData(text); } catch { /* best-effort */ } }
      });
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(String(chunk)));
      child.on("error", (error: Error) => {
        clearTimeout(timer);
        this.ctx.openclaw.openClawBinCheckedAtMs = Date.now();
        this.ctx.openclaw.openClawBinAvailable = false;
        this.ctx.openclaw.openClawBinLastError = error.message;
        void cleanupCwd().finally(() => {
          resolve({ ok: false, code: null, stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), error: error.message });
        });
      });
      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        this.ctx.openclaw.openClawBinCheckedAtMs = Date.now();
        if (code === 0) {
          this.ctx.openclaw.openClawBinAvailable = true;
          this.ctx.openclaw.openClawBinLastError = null;
        }
        void cleanupCwd().finally(() => {
          resolve({ ok: code === 0, code: typeof code === "number" ? code : null, stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), error: null });
        });
      });
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.ctx.openclaw.openClawBinCheckedAtMs = Date.now();
        this.ctx.openclaw.openClawBinAvailable = false;
        this.ctx.openclaw.openClawBinLastError = message;
        resolve({
          ok: false,
          code: null,
          stdout: "",
          stderr: "",
          error: message,
        });
      });
    });
  }

  // -----------------------------------------------------------------------
  // Private: wake posting internals (delegates to openclaw-wake helpers)
  // -----------------------------------------------------------------------

  private scheduleFlush(): void {
    if (this.ctx.config.openClawWakeBatchMs <= 0) { void this.flushWakeBatch(); return; }
    if (!this.wakeBatchTimer) {
      this.wakeBatchTimer = setTimeout(() => { void this.flushWakeBatch(); }, this.ctx.config.openClawWakeBatchMs);
    }
  }

  private async postWake(payload: WakeInput): Promise<void> {
    const normalized = normalizeWakeInput(payload);
    if (!normalized) return;
    const result = isActionableWake(normalized, {
      includeMediaPrepared: this.ctx.config.openClawWakeIncludeMediaPrepared,
      includeSocketStateChange: this.ctx.config.openClawWakeIncludeSocketStateChange,
      lastSocketWakeConnectivity: this.lastSocketWakeConnectivity,
    });
    this.lastSocketWakeConnectivity = result.nextSocketConnectivity;
    if (!result.actionable) return;
    if (this.ctx.openclaw.openClawWakeReasonSet && !this.ctx.openclaw.openClawWakeReasonSet.has(normalized.reason)) return;
    this.wakeBatchItems.push(normalized);
    this.scheduleFlush();
  }

  private async flushWakeBatch(): Promise<void> {
    if (this.wakeBatchTimer) { clearTimeout(this.wakeBatchTimer); this.wakeBatchTimer = null; }
    const batch = this.wakeBatchItems;
    this.wakeBatchItems = [];
    if (!batch.length) return;
    const nowMs = Date.now();
    const selected: WakeInput[] = [];
    for (const wake of batch) {
      const key = getWakeDebounceKey(wake);
      const lastAt = this.wakeDebounceByKey.get(key) ?? 0;
      if (this.ctx.config.openClawWakeDebounceMs > 0 && nowMs - lastAt < this.ctx.config.openClawWakeDebounceMs) continue;
      this.wakeDebounceByKey.set(key, nowMs);
      selected.push(wake);
    }
    if (!selected.length) return;
    const body = selected.length === 1 && selected[0]
      ? buildWakeBody(selected[0], this.ctx.config.stateDir)
      : buildBatchWakeBody(selected, this.ctx.config.stateDir, this.ctx.config.openClawWakeBatchMs);
    await deliverWakeBody(body, {
      hookRequestsPath: this.ctx.ipcPaths.hookRequestsPath,
      hookWakePath: this.ctx.ipcPaths.hookWakePath,
      wakeUrl: this.ctx.openclaw.openClawWakeUrl,
      wakeKey: this.ctx.openclaw.openClawWakeKey,
      touchWake: this.ctx.touchWake,
    });
  }
}
