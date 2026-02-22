/**
 * Context prompt renderer.
 *
 * Ported from agent-runtime.mjs lines 2627-2754
 * (MemoryStore.renderContextPrompt).
 *
 * Extracted as a standalone function so MemoryStore can delegate to it
 * without carrying the rendering logic inline.
 */

import crypto from "node:crypto";

import type { ContextBundle, MemoryEnvelope } from "~/types/memory.js";
import { isRecord } from "~/lib/guards.js";
import { extractKeysFromPayload } from "./extract.js";

// ---------------------------------------------------------------------------
// renderContextPrompt
// ---------------------------------------------------------------------------

export const renderContextPrompt = (bundle: ContextBundle): string => {
  const parts: string[] = [];
  parts.push("# Molkgram Agent Context");
  parts.push(`generatedAt: ${bundle.generatedAt}`);

  if (bundle.identity) {
    parts.push(`\n## Identity\n${bundle.identity.trim()}`);
  }
  if (bundle.mode) {
    parts.push(`\n## Mode\n${bundle.mode.trim()}`);
  }

  // -- mood -----------------------------------------------------------------
  if (isRecord(bundle.mood)) {
    const moodPrimary =
      typeof bundle.mood.primary === "string" &&
      bundle.mood.primary.trim().length > 0
        ? bundle.mood.primary.trim()
        : "steady";
    const moodScore =
      typeof bundle.mood.score === "number" &&
      Number.isFinite(bundle.mood.score)
        ? bundle.mood.score
        : 0;
    const moodSecondary = Array.isArray(bundle.mood.secondary)
      ? (bundle.mood.secondary as unknown[])
          .filter(
            (item): item is string =>
              typeof item === "string" && item.trim().length > 0,
          )
          .map((item) => item.trim())
          .slice(0, 4)
      : [];
    const moodSignals = Array.isArray(bundle.mood.recentSignals)
      ? bundle.mood.recentSignals
          .slice(-4)
          .map((signal) =>
            isRecord(signal) && typeof signal.reason === "string"
              ? signal.reason.trim()
              : "",
          )
          .filter((item) => item.length > 0)
      : [];

    parts.push("\n## Mood");
    parts.push(
      `primary=${moodPrimary} score=${Number.parseFloat(String(moodScore)).toFixed(2)}`,
    );
    if (moodSecondary.length) {
      parts.push(`secondary=${moodSecondary.join(", ")}`);
    }
    if (moodSignals.length) {
      parts.push(`signals=${moodSignals.join(" | ")}`);
    }
  }

  // -- notes ----------------------------------------------------------------
  if (Array.isArray(bundle.notes) && bundle.notes.length) {
    parts.push("\n## Notes");
    bundle.notes.forEach((note) => {
      parts.push(`- ${note.title}: ${note.content}`);
    });
  }

  // -- view context ---------------------------------------------------------
  if (
    isRecord(bundle.view) &&
    bundle.view.enabled === true &&
    bundle.view.relevant === true &&
    Array.isArray(bundle.view.lines) &&
    bundle.view.lines.length > 0
  ) {
    parts.push("\n## View Context");
    bundle.view.lines
      .filter(
        (line): line is string =>
          typeof line === "string" && line.trim().length > 0,
      )
      .slice(0, 16)
      .forEach((line) => parts.push(`- ${line.trim()}`));
  }

  // -- retrieval context ----------------------------------------------------
  if (
    isRecord(bundle.retrieval) &&
    bundle.retrieval.enabled === true &&
    Array.isArray(bundle.retrieval.lines) &&
    bundle.retrieval.lines.length > 0
  ) {
    parts.push("\n## Retrieval Context");
    if (typeof bundle.retrieval.intent === "string" && bundle.retrieval.intent.trim().length > 0) {
      parts.push(`intent=${bundle.retrieval.intent.trim()}`);
    }
    if (typeof bundle.retrieval.query === "string" && bundle.retrieval.query.trim().length > 0) {
      parts.push(`query=${bundle.retrieval.query.trim()}`);
    }
    if (Array.isArray(bundle.retrieval.keywords) && bundle.retrieval.keywords.length > 0) {
      parts.push(`keywords=${bundle.retrieval.keywords.join(",")}`);
    }
    if (
      Array.isArray(bundle.retrieval.lookupPlans) &&
      bundle.retrieval.lookupPlans.length > 0
    ) {
      parts.push(`lookupPlans=${bundle.retrieval.lookupPlans.length}`);
      for (const plan of bundle.retrieval.lookupPlans.slice(0, 8)) {
        if (!isRecord(plan)) continue;
        if (typeof plan.action !== "string" || plan.action.trim().length === 0) {
          continue;
        }
        if (typeof plan.reason !== "string" || plan.reason.trim().length === 0) {
          continue;
        }
        if (!isRecord(plan.args)) continue;
        const argText = Object.entries(plan.args)
          .filter((entry): entry is [string, string | number | boolean | null] => {
            const value = entry[1];
            return (
              typeof value === "string" ||
              typeof value === "number" ||
              typeof value === "boolean" ||
              value === null
            );
          })
          .map(([key, value]) => `${key}=${String(value)}`)
          .join(" ");
        parts.push(
          `- lookup ${plan.action.trim()} ${argText} reason=${plan.reason.trim()}`.trim(),
        );
      }
    }
    bundle.retrieval.lines
      .filter(
        (line): line is string =>
          typeof line === "string" && line.trim().length > 0,
      )
      .slice(0, 16)
      .forEach((line) => parts.push(`- ${line.trim()}`));
  }

  // -- target ---------------------------------------------------------------
  if (bundle.target.postId || bundle.target.commentId) {
    parts.push("\n## Target");
    parts.push(
      `postId=${bundle.target.postId ?? "null"} commentId=${bundle.target.commentId ?? "null"}`,
    );
    parts.push(`events=${bundle.target.events.length}`);

    if (isRecord(bundle.target.focus)) {
      const counterpartySummary = Array.isArray(
        bundle.target.focus.counterparties,
      )
        ? bundle.target.focus.counterparties
            .map((item) =>
              isRecord(item) && typeof item.name === "string"
                ? `${item.name}${typeof item.count === "number" ? ` (${item.count})` : ""}`
                : "",
            )
            .filter((item) => item.length > 0)
            .slice(0, 4)
        : [];
      if (counterpartySummary.length) {
        parts.push(`counterparties=${counterpartySummary.join(", ")}`);
      }
    }
  }

  // -- temporal memory ------------------------------------------------------
  if (isRecord(bundle.temporal) && isRecord(bundle.temporal.tiers)) {
    parts.push("\n## Temporal Memory");
    const tierOrder = ["24h", "7d", "30d", "365d"];
    tierOrder.forEach((tierKey) => {
      const tier = bundle.temporal.tiers[tierKey];
      if (!isRecord(tier)) return;
      const eventCount =
        typeof tier.eventCount === "number" &&
        Number.isFinite(tier.eventCount)
          ? tier.eventCount
          : 0;
      parts.push(
        `- ${tierKey}: events=${eventCount} compressedBy=${(tier.compressedBy as string | undefined) ?? "algorithm"}`,
      );
      const bullets = Array.isArray(tier.bullets)
        ? (tier.bullets as unknown[])
            .filter(
              (line): line is string =>
                typeof line === "string" && line.trim().length > 0,
            )
            .map((line) => line.trim())
            .slice(0, tierKey === "24h" ? 4 : 2)
        : [];
      bullets.forEach((line) => parts.push(`  - ${line}`));
    });
  }

  // -- events (recent / archive) --------------------------------------------
  const renderEvents = (
    label: string,
    events: MemoryEnvelope[],
  ): void => {
    if (!events.length) return;
    parts.push(`\n## ${label}`);
    events.slice(-60).forEach((event) => {
      const keys = extractKeysFromPayload(event.payload);
      const kind = keys.type ?? "event";
      const summary = [
        kind,
        keys.postId ? `post=${keys.postId}` : "",
        keys.commentId ? `comment=${keys.commentId}` : "",
      ]
        .filter((token) => token.length)
        .join(" ");
      parts.push(`- ${event.receivedAt} ${summary} topic=${event.topic}`);
    });
  };

  renderEvents("Recent", bundle.recent ?? []);
  renderEvents("Archive", bundle.archive ?? []);

  // -- target raw payloads --------------------------------------------------
  if (bundle.target.events.length) {
    parts.push("\n## Target Raw Payloads (JSON)");
    bundle.target.events.slice(-20).forEach((event) => {
      parts.push(
        JSON.stringify({
          receivedAt: event.receivedAt,
          topic: event.topic,
          payload: event.payload,
        }),
      );
    });
  }

  const nonce = crypto.randomUUID();
  parts.push(`\nnonce=${nonce}`);
  return parts.join("\n");
};
