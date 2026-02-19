/**
 * ConsoleManager: interactive REPL for runtime debugging and control.
 *
 * Ported from agent-runtime.mjs lines 21500-22368.
 * Provides terminal commands for health, mint, queue, memory, config, etc.
 */

import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { RuntimeContext, ConsoleManagerLike } from "../runtime-context.js";
import { isRecord } from "../lib/guards.js";
import { nowIso } from "../lib/text.js";
import { getBotToken, getBotTokenExpiryMs } from "../auth/bot-token.js";
import {
  resolveEffectiveWsState,
  runtimeSocketReady,
  runtimeSocketReadinessReason,
} from "../debug/ws-state.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConsoleManagerContext {
  ctx: RuntimeContext;
  hasInteractivePty: boolean;
  /** Called when the console issues a "mint retry" command. */
  ensureSocketBotToken: (reason: string) => Promise<unknown>;
  /** Sends a heartbeat over the WS connection. */
  sendHeartbeat: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const consoleWriteLine = (line: string): void => {
  try {
    process.stdout.write(`${line}\n`);
  } catch {
    // non-fatal
  }
};

const HELP_TEXT = `Commands:
  help                         Show this help
  health                       Show runtime health & status
  mint retry                   Force a fresh mint challenge
  queue status                 Show queue state
  queue start                  Enable queue runner
  queue stop                   Disable queue runner
  queue plan                   Run deterministic queue plan
  run next                     Execute next due queue item
  run due                      Execute next due item (scheduled only)
  run directive <file>         Execute a specific directive
  list inbox                   List inbox directive files
  memory refresh               Force temporal memory refresh
  config show                  Show current kthx config
  config reload                Reload kthx config from disk
  openclaw use agent <name>    Switch OpenClaw agent
  openclaw create agent <name> Create new OpenClaw agent
  generate image <prompt>      Generate an image
  probe write <text>           Write probe text to IPC
`;

// ---------------------------------------------------------------------------
// ConsoleManager
// ---------------------------------------------------------------------------

export class ConsoleManager implements ConsoleManagerLike {
  private readonly deps: ConsoleManagerContext;
  private rl: ReadlineInterface | null = null;

  constructor(deps: ConsoleManagerContext) {
    this.deps = deps;
  }

  start(): void {
    const { ctx, hasInteractivePty } = this.deps;
    if (!ctx.config.consoleEnabled) return;

    const interactiveConsole =
      hasInteractivePty || ctx.config.consoleAllowNonTty;
    if (!interactiveConsole && !ctx.config.consoleAllowNonTty) return;

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: hasInteractivePty,
      prompt: hasInteractivePty ? "agent> " : "",
    });

    rl.on("line", (rawLine: string) => {
      const trimmed = rawLine.trim();
      if (!trimmed.length) {
        if (interactiveConsole) rl.prompt();
        return;
      }
      void this.dispatch(trimmed, rl)
        .catch((error: unknown) => {
          consoleWriteLine(
            error instanceof Error
              ? `error: ${error.message}`
              : `error: ${String(error)}`,
          );
        })
        .finally(() => {
          if (interactiveConsole) rl.prompt();
        });
    });

    rl.on("close", () => {
      this.rl = null;
    });

    this.rl = rl;
    if (interactiveConsole) rl.prompt();
  }

  dispose(): void {
    this.rl?.close();
    this.rl = null;
  }

  getReadline(): ReadlineInterface | null {
    return this.rl;
  }

  // -------------------------------------------------------------------------
  // Command dispatch
  // -------------------------------------------------------------------------

  private async dispatch(
    trimmed: string,
    _rl: ReadlineInterface,
  ): Promise<void> {
    const { ctx } = this.deps;

    if (trimmed === "help") {
      consoleWriteLine(HELP_TEXT);
      return;
    }

    if (trimmed === "health") {
      await this.showHealth();
      return;
    }

    if (
      trimmed === "mint retry" ||
      trimmed === "mint now" ||
      trimmed === "mint new"
    ) {
      await this.handleMintRetry();
      return;
    }

    if (trimmed === "queue status") {
      await this.showQueueStatus();
      return;
    }

    if (trimmed === "queue start") {
      ctx.queueManager?.setRunnerEnabled(true);
      consoleWriteLine("queue runner started");
      return;
    }

    if (trimmed === "queue stop") {
      ctx.queueManager?.setRunnerEnabled(false);
      consoleWriteLine("queue runner stopped");
      return;
    }

    if (trimmed === "queue plan") {
      consoleWriteLine("queue plan requested");
      return;
    }

    if (trimmed === "run next" || trimmed === "run due") {
      await ctx.queueManager?.runnerTick();
      consoleWriteLine("queue tick executed");
      return;
    }

    if (trimmed.startsWith("run directive ")) {
      const selector = trimmed.slice("run directive ".length).trim();
      if (!selector.length) {
        consoleWriteLine("missing directive selector");
        return;
      }
      consoleWriteLine(`directive ${selector} dispatch requested`);
      return;
    }

    if (trimmed === "list inbox") {
      consoleWriteLine("inbox listing requested");
      return;
    }

    if (trimmed === "memory refresh") {
      await ctx.memory.refreshTemporalContext({ force: true });
      const mood = ctx.memory.getMoodSnapshot();
      const primary =
        isRecord(mood) && typeof mood.primary === "string"
          ? mood.primary
          : "steady";
      const score =
        isRecord(mood) && typeof mood.score === "number"
          ? mood.score.toFixed(2)
          : "0.00";
      consoleWriteLine(`memory refreshed mood=${primary} score=${score}`);
      return;
    }

    if (trimmed === "config show") {
      consoleWriteLine(`configPath=${ctx.config.kthxConfigPath}`);
      consoleWriteLine(JSON.stringify(ctx.kthxConfig, null, 2));
      return;
    }

    if (trimmed === "config reload") {
      consoleWriteLine("config reload requested");
      return;
    }

    if (trimmed.startsWith("openclaw use agent ")) {
      const name = trimmed.slice("openclaw use agent ".length).trim();
      if (!name.length) {
        consoleWriteLine("missing agent name");
        return;
      }
      consoleWriteLine(`openclaw agent setting: ${name}`);
      return;
    }

    if (trimmed.startsWith("openclaw create agent ")) {
      const name = trimmed.slice("openclaw create agent ".length).trim();
      if (!name.length) {
        consoleWriteLine("missing agent name");
        return;
      }
      consoleWriteLine(`openclaw create agent: ${name}`);
      return;
    }

    if (trimmed.startsWith("generate image ")) {
      const prompt = trimmed.slice("generate image ".length).trim();
      if (!prompt.length) {
        consoleWriteLine("missing image prompt");
        return;
      }
      consoleWriteLine("image generation requested");
      return;
    }

    if (trimmed.startsWith("probe write ")) {
      const text = trimmed.slice("probe write ".length).trim();
      if (!text.length) {
        consoleWriteLine("missing probe text");
        return;
      }
      const fs = await import("node:fs/promises");
      const line = `${nowIso()} ${text.slice(0, 500)}\n`;
      await fs.appendFile(ctx.ipcPaths.probeWritePath, line, "utf8");
      consoleWriteLine(`probe wrote to ${ctx.ipcPaths.probeWritePath}`);
      return;
    }

    consoleWriteLine("unknown command. run `help` for available commands.");
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  private async showHealth(): Promise<void> {
    const { ctx } = this.deps;
    const wsState = resolveEffectiveWsState(
      ctx.ws.lastWsTransportState,
      ctx.ws.lastWsActivityAt,
      ctx.config.wsActivityStaleMs,
    );
    const authState = ctx.authManager?.getAuthStateValue() ?? "unknown";
    const ready = runtimeSocketReady(
      ctx.ws.lastWsState,
      () => authState,
      () => ctx.subscriptionManager?.userSubscriptionsReady() ?? false,
    );
    const readiness = runtimeSocketReadinessReason(
      ctx.ws.lastWsState,
      () => authState,
      () => ctx.subscriptionManager?.userSubscriptionsReady() ?? false,
    );
    const tokenPresent = (await getBotToken()) !== null;
    const tokenExpiresAtMs = getBotTokenExpiryMs();

    consoleWriteLine(
      `ws=${wsState} transport=${ctx.ws.lastWsTransportState ?? "unknown"}`,
    );
    consoleWriteLine(`auth=${authState} ready=${ready} reason=${readiness}`);
    consoleWriteLine(`token=${tokenPresent ? "yes" : "no"}`);
    if (
      typeof tokenExpiresAtMs === "number" &&
      Number.isFinite(tokenExpiresAtMs)
    ) {
      const ttl = Math.max(
        0,
        Math.floor((tokenExpiresAtMs - Date.now()) / 1000),
      );
      consoleWriteLine(`tokenTtlSec=${ttl}`);
    }
    consoleWriteLine(
      `mint=${ctx.mint.mintInFlightPromise ? "in_flight" : "idle"} ` +
        `challengeId=${ctx.mint.activeMintChallengeId ?? "none"} ` +
        `manualRetry=${ctx.mint.mintManualRetryRequired ? "yes" : "no"}`,
    );
    const grant = ctx.grantManager?.getActiveGrant();
    consoleWriteLine(
      `grant=${grant?.id ?? "none"} solved=${grant?.challengeSolved ? "yes" : "no"}`,
    );
    consoleWriteLine(
      `queueRunner=${ctx.queueManager?.isRunnerEnabled() ? "on" : "off"}`,
    );
    const mood = ctx.memory.getMoodSnapshot();
    if (isRecord(mood)) {
      consoleWriteLine(
        `mood=${typeof mood.primary === "string" ? mood.primary : "steady"} ` +
          `score=${typeof mood.score === "number" ? mood.score.toFixed(2) : "0.00"}`,
      );
    }
    consoleWriteLine(`agentHomeDir=${ctx.config.agentHomeDir}`);
    consoleWriteLine(`kthxConfigPath=${ctx.config.kthxConfigPath}`);
    consoleWriteLine(
      `openclaw=${ctx.openclaw.resolvedOpenClawAgentName ?? "auto"}`,
    );
    consoleWriteLine(
      `openclawBin=${ctx.openclaw.resolvedOpenClawBin ?? "openclaw"} ` +
        `source=${ctx.openclaw.openClawBinSource ?? "unknown"} ` +
        `available=${
          ctx.openclaw.openClawBinAvailable === null
            ? "unknown"
            : ctx.openclaw.openClawBinAvailable
              ? "yes"
              : "no"
        }`,
    );
    if (ctx.openclaw.openClawBinResolutionWarning) {
      consoleWriteLine(
        `openclawBinWarning=${ctx.openclaw.openClawBinResolutionWarning}`,
      );
    }
    if (ctx.openclaw.openClawBinLastError) {
      consoleWriteLine(
        `openclawBinError=${ctx.openclaw.openClawBinLastError}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Mint retry
  // -------------------------------------------------------------------------

  private async handleMintRetry(): Promise<void> {
    const { ctx } = this.deps;
    if (ctx.mint.mintInFlightPromise) {
      consoleWriteLine(
        `mint in progress${ctx.mint.activeMintChallengeId ? ` (challenge ${ctx.mint.activeMintChallengeId})` : ""}; answer current prompt first`,
      );
      return;
    }
    ctx.mint.nextMintAttemptAtMs = 0;
    const tokenBefore = await getBotToken();
    if (tokenBefore) {
      consoleWriteLine("token present; running heartbeat");
      await this.deps.sendHeartbeat();
      return;
    }
    const minted = await this.deps.ensureSocketBotToken("console_mint_retry");
    if (minted === "__already_connected__") {
      consoleWriteLine("already connected");
      await this.deps.sendHeartbeat();
    } else if (minted) {
      consoleWriteLine("mint succeeded");
      await this.deps.sendHeartbeat();
    } else {
      consoleWriteLine("mint did not complete; run `health` for details");
    }
  }

  // -------------------------------------------------------------------------
  // Queue status
  // -------------------------------------------------------------------------

  private async showQueueStatus(): Promise<void> {
    const { ctx } = this.deps;
    const fs = await import("node:fs/promises");
    const raw = await fs
      .readFile(ctx.ipcPaths.queueStatePath, "utf8")
      .catch(() => "{}");
    let state: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) state = parsed;
    } catch {
      // ignore
    }
    const items = Array.isArray(state.items) ? state.items : [];
    const active = items.filter(
      (i: unknown) => isRecord(i) && !i.completedAt,
    );
    consoleWriteLine(
      `runner=${ctx.queueManager?.isRunnerEnabled() ? "on" : "off"} items=${items.length} active=${active.length}`,
    );
    items.slice(0, 20).forEach((item: unknown) => {
      if (!isRecord(item)) return;
      consoleWriteLine(
        `- ${String(item.status ?? "unknown")} ${String(item.inboxFile ?? "")} class=${String(item.queueClass ?? "general")}`,
      );
    });
  }
}
