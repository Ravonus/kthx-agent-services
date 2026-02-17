/**
 * EventsManager: persistence layer for the events.jsonl file.
 *
 * Serializes writes through a queue promise to prevent interleaving and
 * automatically compacts the file when it exceeds `currentEventsMaxLines`.
 *
 * Ported from agent-runtime.mjs lines 4467-4526.
 */

import { nowIso } from "../lib/text.js";
import {
  appendJsonLine,
  readLastJsonLines,
  writeJsonLines,
} from "../lib/fs-helpers.js";
import type { EventsManagerLike } from "../runtime-context.js";

// ---------------------------------------------------------------------------
// Narrow context interface
// ---------------------------------------------------------------------------

/**
 * Narrow context that EventsManager needs to operate.
 * Avoids importing RuntimeContext directly to prevent circular deps.
 */
export interface EventsManagerContext {
  ipcPaths: {
    eventsPath: string;
  };
  config: {
    currentEventsMaxLines: number;
    tailMaxBytes: number;
  };
  memory: {
    recordWrite(payload: unknown): Promise<void>;
  };
}

// ---------------------------------------------------------------------------
// EventsManager
// ---------------------------------------------------------------------------

export class EventsManager implements EventsManagerLike {
  private readonly ctx: EventsManagerContext;

  /**
   * Running count of lines currently in the events file.
   * Updated after every append and after compaction.
   */
  private lineCount: number = 0;

  /**
   * Serialization promise: each write chains onto this so that
   * concurrent appendEvent() calls never interleave.
   */
  private persistQueue: Promise<void> = Promise.resolve();

  /**
   * Compaction headroom: we allow the file to grow this many lines
   * beyond the configured max before triggering a compaction pass.
   */
  private static readonly COMPACTION_HEADROOM = 25;

  constructor(ctx: EventsManagerContext) {
    this.ctx = ctx;
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  /**
   * Read the current events file and compact it if it already exceeds
   * the configured maximum. Call once at startup.
   */
  async initialize(): Promise<void> {
    const maxReadBytes = this.resolveMaxReadBytes();
    const maxLines = this.ctx.config.currentEventsMaxLines;

    const tail = await readLastJsonLines({
      filePath: this.ctx.ipcPaths.eventsPath,
      maxLines: maxLines + EventsManager.COMPACTION_HEADROOM,
      maxBytes: maxReadBytes,
    });

    if (tail.length > maxLines) {
      const kept = tail.slice(-maxLines);
      await writeJsonLines(this.ctx.ipcPaths.eventsPath, kept);
      this.lineCount = kept.length;
      await this.ctx.memory.recordWrite({
        type: "events_compacted",
        at: nowIso(),
        reason: "startup",
        kept: kept.length,
        maxLines,
      });
      return;
    }

    this.lineCount = tail.length;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Append a single event envelope to the events file.
   *
   * Writes are serialized through a queue promise so concurrent calls
   * from different async paths never interleave on disk.
   * Triggers compaction when lineCount exceeds the configured maximum
   * plus a small headroom buffer.
   */
  async appendEvent(event: unknown): Promise<void> {
    this.persistQueue = this.persistQueue
      .then(async () => {
        await appendJsonLine(this.ctx.ipcPaths.eventsPath, event);
        this.lineCount += 1;

        const compactionThreshold =
          this.ctx.config.currentEventsMaxLines +
          EventsManager.COMPACTION_HEADROOM;

        if (this.lineCount > compactionThreshold) {
          await this.compact("runtime");
        }
      })
      .catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : String(error);
        console.warn(
          "[agent-runtime] events persistence failed (non-fatal)",
          message,
        );
      });

    await this.persistQueue;
  }

  /** Returns the current number of lines in the events file. */
  getLineCount(): number {
    return this.lineCount;
  }

  /** No-op cleanup (no timers or handles to release). */
  dispose(): void {
    // Nothing to dispose; the persist queue will drain naturally.
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /**
   * Compact the current events file by reading the tail and rewriting.
   */
  private async compact(reason: string): Promise<void> {
    const maxReadBytes = this.resolveMaxReadBytes();
    const maxLines = this.ctx.config.currentEventsMaxLines;

    const tail = await readLastJsonLines({
      filePath: this.ctx.ipcPaths.eventsPath,
      maxLines,
      maxBytes: maxReadBytes,
    });

    await writeJsonLines(this.ctx.ipcPaths.eventsPath, tail);
    this.lineCount = tail.length;

    await this.ctx.memory.recordWrite({
      type: "events_compacted",
      at: nowIso(),
      reason,
      kept: tail.length,
      maxLines,
    });
  }

  /** Compute the maximum number of bytes to read when tailing the file. */
  private resolveMaxReadBytes(): number {
    return Math.max(
      this.ctx.config.tailMaxBytes,
      this.ctx.config.currentEventsMaxLines * 4096,
    );
  }
}
