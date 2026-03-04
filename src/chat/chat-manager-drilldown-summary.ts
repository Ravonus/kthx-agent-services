import { isRecord } from "../lib/guards.js";
import type { ContextBundle } from "../types/memory.js";

const MEMORY_INTERNAL_BULLET_PATTERN =
  /\b(openclaw|bot token|session token|agent key|directive|queue|runtime|bridge|heartbeat|mint|challenge|permission(?:s)?(?:\s+state)?|no_grant|api\/agent\/chat|port\s*\d{3,5}|websocket|socket|postgres|database|sql|migration|column\s+\w+)\b/iu;

const isSafeMemoryBullet = (value: string): boolean =>
  !MEMORY_INTERNAL_BULLET_PATTERN.test(value.trim().toLowerCase());

export const buildDrilldownMemorySummary = (bundle: ContextBundle): string => {
  const lines: string[] = [];
  lines.push("## Memory Snapshot");
  lines.push(`generatedAt=${bundle.generatedAt}`);
  if (bundle.mood) {
    lines.push(
      `mood=${bundle.mood.primary} score=${Number.parseFloat(String(bundle.mood.score)).toFixed(2)}`,
    );
  }

  if (isRecord(bundle.temporal?.tiers)) {
    lines.push("temporal:");
    for (const tierKey of ["24h", "7d", "30d", "365d"]) {
      const tier = bundle.temporal.tiers[tierKey];
      if (!isRecord(tier)) continue;
      const bullets = Array.isArray(tier.bullets)
        ? tier.bullets
            .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
            .filter((entry) => isSafeMemoryBullet(entry))
            .slice(0, tierKey === "24h" ? 3 : 1)
            .map((entry) => entry.trim())
        : [];
      const eventCount =
        typeof tier.eventCount === "number" && Number.isFinite(tier.eventCount)
          ? tier.eventCount
          : 0;
      lines.push(`- ${tierKey} events=${eventCount}`);
      for (const bullet of bullets) {
        lines.push(`  - ${bullet}`);
      }
    }
  }

  if (
    isRecord(bundle.view) &&
    bundle.view.enabled === true &&
    bundle.view.relevant === true &&
    Array.isArray(bundle.view.lines) &&
    bundle.view.lines.length > 0
  ) {
    lines.push("view:");
    for (const line of bundle.view.lines.slice(0, 12)) {
      if (typeof line !== "string") continue;
      const trimmed = line.trim();
      if (!trimmed.length) continue;
      lines.push(`- ${trimmed}`);
    }
  }

  if (
    isRecord(bundle.retrieval) &&
    bundle.retrieval.enabled === true &&
    Array.isArray(bundle.retrieval.lines) &&
    bundle.retrieval.lines.length > 0
  ) {
    lines.push("retrieval:");
    if (typeof bundle.retrieval.query === "string" && bundle.retrieval.query.trim().length > 0) {
      lines.push(`- query=${bundle.retrieval.query.trim()}`);
    }
    for (const line of bundle.retrieval.lines.slice(0, 10)) {
      if (typeof line !== "string") continue;
      const trimmed = line.trim();
      if (!trimmed.length) continue;
      lines.push(`- ${trimmed}`);
    }
  }

  if (bundle.target.postId || bundle.target.commentId) {
    lines.push("target:");
    lines.push(
      `- postId=${bundle.target.postId ?? "null"} commentId=${bundle.target.commentId ?? "null"} targetEvents=${bundle.target.events.length}`,
    );
    const focusBullets = Array.isArray(bundle.target.focus?.bullets)
      ? bundle.target.focus.bullets
          .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          .filter((entry) => isSafeMemoryBullet(entry))
          .slice(0, 4)
          .map((entry) => entry.trim())
      : [];
    for (const bullet of focusBullets) {
      lines.push(`  - ${bullet}`);
    }
  }

  lines.push("retrievalPolicy=prefer_recent_first_then_targeted_archive_then_single_clarifying_question");
  return lines.join("\n");
};
