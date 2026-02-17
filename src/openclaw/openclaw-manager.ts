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
  const defaultMatch = /-\s*([a-zA-Z0-9._-]+)\s*\(default\)/iu.exec(text);
  if (defaultMatch?.[1]?.trim().length) return defaultMatch[1].trim();
  const agentsInlineMatch = /Agents:\s*-\s*([a-zA-Z0-9._-]+)/iu.exec(text);
  if (agentsInlineMatch?.[1]?.trim().length) return agentsInlineMatch[1].trim();
  const firstMatch = /-\s*([a-zA-Z0-9._-]+)/u.exec(text);
  if (firstMatch?.[1]?.trim().length) return firstMatch[1].trim();
  return null;
};

/** Build a resolved shell command from a template with placeholder substitution. */
const resolveTemplateCommand = (
  template: string, agentName: string | null,
  config: { agentHomeDir: string; stateDir: string; kthxConfigPath: string },
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

  constructor(ctx: OpenClawManagerContext) { this.ctx = ctx; }

  async resolveAgentName(): Promise<string | null> {
    const ocConfig = this.ctx.openclawConfig();
    if (!ocConfig || !ocConfig.enabled) return null;
    if (typeof ocConfig.agentName === "string" && ocConfig.agentName.trim().length > 0) return ocConfig.agentName.trim();
    if (this.ctx.openclaw.resolvedOpenClawAgentName && Date.now() - this.ctx.openclaw.openClawAgentResolvedAtMs < 120_000) {
      return this.ctx.openclaw.resolvedOpenClawAgentName;
    }
    const listCommand = typeof ocConfig.listAgentsCommand === "string" && ocConfig.listAgentsCommand.trim().length > 0
      ? ocConfig.listAgentsCommand.trim() : "openclaw agents";
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
    const command = resolveTemplateCommand(
      template.replaceAll("{prompt}", promptForCommand),
      agentName, this.ctx.config,
    );
    const timeoutMs = typeof ocConfig.timeoutMs === "number" && Number.isFinite(ocConfig.timeoutMs)
      ? Math.max(15_000, Math.floor(ocConfig.timeoutMs)) : 120_000;
    const allowNativeTextStreaming = purpose === "chat_reply"
      && this.ctx.config.chatRuntimeTextStreamEnabled
      && this.ctx.config.chatRuntimeTextStreamNativeEnabled
      && typeof onTextDelta === "function";
    const result = await this.runLockedShellCommand({
      command, timeoutMs,
      ...(allowNativeTextStreaming ? { onStdoutData: (chunk: string) => { const delta = parseOpenClawStdoutDelta(chunk); if (delta.length) onTextDelta(delta); } } : {}),
    });
    await this.ctx.memory.recordWrite({
      type: "openclaw_prompt_result", at: nowIso(), purpose, ok: result.ok,
      code: result.code, agentName: agentName ?? null,
      commandPreview: toAnswerPreview(command, 180), stderrPreview: toAnswerPreview(result.stderr, 180),
    });
    if (!result.ok) return null;
    const parsedRaw = parseJsonFromMixedText(result.stdout);
    let parsed = parsedRaw;
    let payloadText: string | null = null;
    let envelope: Record<string, unknown> | null = null;
    if (parsedRaw !== null) {
      const unwrapped = unwrapOpenClawEnvelopePayload(parsedRaw);
      parsed = unwrapped.parsed; payloadText = unwrapped.payloadText; envelope = unwrapped.envelope;
    } else {
      const stdoutText = typeof result.stdout === "string" ? result.stdout.trim() : "";
      if (stdoutText.length > 0) { parsed = { text: stdoutText }; payloadText = stdoutText; }
    }
    return { parsed, raw: result.stdout, agentName, payloadText, envelope };
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
    const command = resolveTemplateCommand(template, currentAgent, this.ctx.config, { "{new_agent}": parsedName });
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
      const child = spawn(opts.command, { shell: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...(opts.extraEnv ?? {}) } });
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
        resolve({ ok: false, code: null, stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), error: error.message });
      });
      child.on("close", (code: number | null) => {
        clearTimeout(timer);
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
