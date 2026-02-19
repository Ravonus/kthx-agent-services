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

const OPENCLAW_ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/gu;
const DEFAULT_MINT_CHALLENGE_TIMEOUT_MS = 20_000;
const DEFAULT_MINT_CHALLENGE_THINKING_LEVEL = "off";

const parseMintChallengeTimeoutMs = (): number => {
  const raw = trimEnv("MG_AGENT_MINT_CHALLENGE_OPENCLAW_TIMEOUT_MS");
  if (!raw) return DEFAULT_MINT_CHALLENGE_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MINT_CHALLENGE_TIMEOUT_MS;
  return Math.max(5_000, Math.min(30_000, parsed));
};

const MINT_CHALLENGE_TIMEOUT_MS = parseMintChallengeTimeoutMs();
const MINT_CHALLENGE_THINKING_LEVEL = (() => {
  const raw = trimEnv("MG_AGENT_MINT_CHALLENGE_OPENCLAW_THINKING");
  if (!raw) return DEFAULT_MINT_CHALLENGE_THINKING_LEVEL;
  const normalized = raw.trim().toLowerCase();
  return normalized.length > 0
    ? normalized
    : DEFAULT_MINT_CHALLENGE_THINKING_LEVEL;
})();

const stripEmptyAgentFlag = (command: string): string =>
  command
    .replace(/\s--agent\s+"__MG_AGENT_AUTO__"/giu, " ")
    .replace(/\s--agent\s+'__MG_AGENT_AUTO__'/giu, " ")
    .replace(/\s--agent\s+__MG_AGENT_AUTO__/giu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();

const parseOpenClawAgentName = (value: unknown): string | null => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed.length || !/^[a-zA-Z0-9._-]{1,64}$/u.test(trimmed)) return null;
  return trimmed;
};

const extractTextFromUnknownChunk = (value: unknown): string => {
  if (typeof value === "string") {
    const normalized = value.replace(OPENCLAW_ANSI_PATTERN, "").replaceAll("\r", "");
    return normalized.length > 0 ? normalized : "";
  }
  if (!isRecord(value)) return "";
  for (const field of ["delta", "text", "reply", "content", "message", "outputText", "assistant"]) {
    const candidate = value[field];
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  if (Array.isArray(value.choices)) {
    for (const choice of value.choices) {
      if (!isRecord(choice)) continue;
      const delta = isRecord(choice.delta) ? choice.delta : null;
      if (delta && typeof delta.content === "string" && (delta.content as string).length > 0) return delta.content as string;
      if (typeof choice.text === "string" && (choice.text as string).length > 0) return choice.text as string;
    }
  }
  return "";
};

export const parseOpenClawStdoutDelta = (chunk: unknown): string => {
  const normalized = typeof chunk === "string" ? chunk.replace(OPENCLAW_ANSI_PATTERN, "").replaceAll("\r", "") : "";
  if (!normalized.length) return "";
  const lines = normalized.split(/\n/u).map((l) => l.trim()).filter((l) => l.length > 0);
  if (!lines.length) return "";
  let extracted = "";
  let parsedAnyJson = false;
  for (const line of lines) {
    if (line.startsWith("{") && line.endsWith("}")) {
      try { const parsed: unknown = JSON.parse(line); parsedAnyJson = true; extracted += extractTextFromUnknownChunk(parsed); continue; } catch { /* not json */ }
    }
    if (/^\[(?:info|debug|event|tool|json|status)\]/iu.test(line)) continue;
    extracted += line;
    if (!line.endsWith(" ")) extracted += " ";
  }
  return parsedAnyJson ? extracted : normalized;
};

const resolveAgentFromListOutput = (output: unknown): string | null => {
  const text = typeof output === "string" ? output : "";
  if (!text.trim().length) return null;
  const tokenPattern = /[a-zA-Z0-9._-]+/u;
  const defaultInlinePatterns = [
    /-\s*(?:name\s*:\s*)?([a-zA-Z0-9._-]+)\s*\(default\)/iu,
    /\bname\s*:\s*([a-zA-Z0-9._-]+)\s*\(default\)/iu,
  ];
  for (const pattern of defaultInlinePatterns) {
    const match = pattern.exec(text);
    if (match?.[1]?.trim().length) return match[1].trim();
  }

  // YAML-ish format support:
  // Agents:
  // - name: foo
  //   default: true
  const blockDefaultMatch =
    /-\s*name\s*:\s*([a-zA-Z0-9._-]+)[\s\S]{0,200}?\bdefault\s*:\s*(?:true|yes|1)\b/iu.exec(
      text,
    );
  if (blockDefaultMatch?.[1]?.trim().length) return blockDefaultMatch[1].trim();

  let currentName: string | null = null;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line.length) continue;
    const listNameMatch = /^-\s*(?:name\s*:\s*)?([a-zA-Z0-9._-]+)\b/iu.exec(line);
    if (listNameMatch?.[1]) {
      currentName = listNameMatch[1];
      if (/\(default\)/iu.test(line)) return currentName;
      continue;
    }
    const nameMatch = /^name\s*:\s*([a-zA-Z0-9._-]+)\b/iu.exec(line);
    if (nameMatch?.[1]) {
      currentName = nameMatch[1];
      if (/\(default\)/iu.test(line)) return currentName;
      continue;
    }
    if (
      currentName &&
      /^default\s*:\s*(?:true|yes|1)\b/iu.test(line)
    ) {
      return currentName;
    }
    if (currentName && /^-\s*/u.test(line) && !tokenPattern.test(line)) {
      currentName = null;
    }
  }

  const agentsInlineMatch = /Agents:\s*-\s*(?:name\s*:\s*)?([a-zA-Z0-9._-]+)/iu.exec(text);
  if (agentsInlineMatch?.[1]?.trim().length) return agentsInlineMatch[1].trim();
  const firstNameFieldMatch = /-\s*name\s*:\s*([a-zA-Z0-9._-]+)/iu.exec(text);
  if (firstNameFieldMatch?.[1]?.trim().length) return firstNameFieldMatch[1].trim();
  const firstMatch = /-\s*([a-zA-Z0-9._-]+)/u.exec(text);
  if (firstMatch?.[1]?.trim().length) return firstMatch[1].trim();
  return null;
};

const enforceMintChallengeFastThinking = (command: string): string => {
  const normalized = command.trim();
  if (!normalized.length) return command;
  const tokenMatch =
    /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/u.exec(normalized);
  const commandToken = (tokenMatch?.[1] ?? tokenMatch?.[2] ?? tokenMatch?.[3] ?? "").trim();
  const commandBase = commandToken ? path.basename(commandToken).toLowerCase() : "";
  const isOpenClawCommand =
    /^openclaw(?:\.(?:cmd|exe|bat|ps1))?$/iu.test(commandBase);
  if (!isOpenClawCommand) return command;
  const desiredThinking = MINT_CHALLENGE_THINKING_LEVEL.trim();
  if (!desiredThinking.length) return command;
  if (/\s--thinking\s+\S+/iu.test(command)) {
    return command.replace(/\s--thinking\s+\S+/iu, ` --thinking ${desiredThinking}`);
  }
  if (/\s-m\s/iu.test(command)) {
    return command.replace(/\s-m\s/iu, ` --thinking ${desiredThinking} -m `);
  }
  return `${command} --thinking ${desiredThinking}`;
};

/** Build a resolved shell command from a template with placeholder substitution. */
const resolveTemplateCommand = (
  template: string, agentName: string | null,
  config: { agentHomeDir: string; stateDir: string; kthxConfigPath: string },
  binary: OpenClawBinaryResolution,
  extraReplacements?: Record<string, string>,
): string => {
  let raw = template;
  if (extraReplacements) {
    for (const [key, value] of Object.entries(extraReplacements)) {
      raw = raw.replaceAll(key, value.replaceAll('"', '\\"'));
    }
  }
  raw = raw
    .replaceAll("{agent}", (agentName ?? "__MG_AGENT_AUTO__").replaceAll('"', '\\"'))
    .replaceAll("{home}", config.agentHomeDir.replaceAll('"', '\\"'))
    .replaceAll("{state}", config.stateDir.replaceAll('"', '\\"'))
    .replaceAll("{config}", config.kthxConfigPath.replaceAll('"', '\\"'));
  raw = applyOpenClawBinaryToShellCommand(raw, binary);
  return stripEmptyAgentFlag(raw);
};

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
    if (!result.ok) return null;
    const selected = resolveAgentFromListOutput(result.stdout);
    if (!selected) return null;
    this.ctx.openclaw.resolvedOpenClawAgentName = selected;
    this.ctx.openclaw.openClawAgentResolvedAtMs = Date.now();
    return selected;
  }

  async prompt(
    input: string,
    opts?: { purpose?: string; onTextDelta?: ((delta: string) => void) | null },
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
    const agentName = await this.resolveAgentName();
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
      ? enforceMintChallengeFastThinking(command)
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
      ...(allowNativeTextStreaming ? { onStdoutData: (chunk: string) => { const delta = parseOpenClawStdoutDelta(chunk); if (delta.length) onTextDelta(delta); } } : {}),
    });
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
    agentName: string; source?: string;
  }): Promise<{ ok: boolean; error?: string; agentName?: string; stdout?: string }> {
    const parsedName = parseOpenClawAgentName(opts.agentName);
    if (!parsedName) return { ok: false, error: "Invalid agent name. Use only letters, numbers, dot, underscore, or dash (max 64 chars)." };
    const ocConfig = this.ctx.openclawConfig();
    if (!ocConfig || !ocConfig.enabled) return { ok: false, error: "OpenClaw integration is disabled in config." };
    if (ocConfig.allowCreateAgent !== true) return { ok: false, error: "Agent creation is disabled. Set openclaw.allowCreateAgent=true in kthx config." };
    const template = typeof ocConfig.createAgentCommand === "string" ? ocConfig.createAgentCommand.trim() : "";
    if (!template.length) return { ok: false, error: "openclaw.createAgentCommand is empty." };
    const currentAgent = await this.resolveAgentName();
    const openClawBinary = this.getOpenClawBinaryResolution();
    const command = resolveTemplateCommand(
      template,
      currentAgent,
      this.ctx.config,
      openClawBinary,
      { "{new_agent}": parsedName },
    );
    const timeoutMs = typeof ocConfig.timeoutMs === "number" && Number.isFinite(ocConfig.timeoutMs)
      ? Math.max(15_000, Math.floor(ocConfig.timeoutMs)) : 120_000;
    const result = await this.runLockedShellCommand({ command, timeoutMs });
    const source = opts.source ?? "runtime";
    await this.ctx.memory.recordWrite({
      type: "openclaw_create_agent_result", at: nowIso(), source, requestedAgentName: parsedName,
      ok: result.ok, code: result.code, commandPreview: toAnswerPreview(command, 180),
      stdoutPreview: toAnswerPreview(result.stdout, 180), stderrPreview: toAnswerPreview(result.stderr, 180),
    });
    if (!result.ok) {
      const errorMessage = typeof result.stderr === "string" && result.stderr.trim().length > 0 ? result.stderr.trim()
        : typeof result.error === "string" && result.error.trim().length > 0 ? result.error.trim() : "create agent command failed";
      return { ok: false, error: errorMessage };
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
    onStdoutData?: ((chunk: string) => void) | null;
  }): Promise<ShellResult> {
    return new Promise((resolve) => {
      const openClawBinary = this.getOpenClawBinaryResolution();
      const mergedEnv = withOpenClawPathInEnv(
        { ...process.env, ...(opts.extraEnv ?? {}) },
        openClawBinary,
      );
      const child = spawn(opts.command, {
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: mergedEnv,
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
        resolve({ ok: false, code: null, stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), error: error.message });
      });
      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        this.ctx.openclaw.openClawBinCheckedAtMs = Date.now();
        if (code === 0) {
          this.ctx.openclaw.openClawBinAvailable = true;
          this.ctx.openclaw.openClawBinLastError = null;
        }
        resolve({ ok: code === 0, code: typeof code === "number" ? code : null, stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), error: null });
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
