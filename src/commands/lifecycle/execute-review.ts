/** Execute a content review command — prompt LLM, parse verdict, submit to server. */

import type {
  Command,
  CommandOutcome,
  OpenClawPromptExecutionResult,
} from "../types.js";
import { isRecord } from "../../lib/guards.js";
import { nowIso } from "../../lib/text.js";
import { successOutcome, failedOutcome } from "./outcome.js";

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

type MemoryWriter = { recordWrite(entry: unknown): Promise<void> };
type OpenClawPromptFn = (input: {
  prompt: string;
  purpose: string;
}) => Promise<OpenClawPromptExecutionResult | null>;
type SubmitReviewFn = (input: {
  requestId: string;
  verdict: string;
  reason: string;
  confidence: number;
}) => Promise<unknown>;

// ---------------------------------------------------------------------------
// executeReview
// ---------------------------------------------------------------------------

export async function executeReview(
  deps: {
    memory: MemoryWriter;
    runOpenClawPrompt: OpenClawPromptFn | null;
    submitReview: SubmitReviewFn;
  },
  command: Command,
): Promise<CommandOutcome> {
  const payload = isRecord(command.payload) ? command.payload : null;
  if (!payload) {
    return failedOutcome(command, "Invalid payload for review command.");
  }

  const requestId =
    typeof payload.requestId === "string" ? payload.requestId : null;
  const reviewType =
    typeof payload.reviewType === "string" ? payload.reviewType : null;
  const moderationGuidelines =
    typeof payload.moderationGuidelines === "string"
      ? payload.moderationGuidelines
      : null;

  if (!requestId || !reviewType) {
    return failedOutcome(
      command,
      "Review payload missing requestId or reviewType.",
      "review_invalid_payload",
    );
  }

  const reviewDetails = buildReviewDetails(reviewType, payload);

  // Build the LLM prompt using the moderation guidelines from the server
  const systemPrompt = moderationGuidelines ?? [
    "You are a content moderation reviewer.",
    "Evaluate the provided content for appropriateness. PG-13 is acceptable. Reject explicit hate, slurs, racism, violent extremism, or disallowed sexual content.",
    "If you cannot inspect the content well enough, respond with abstain instead of guessing.",
    'Respond ONLY with JSON: { "verdict": "approve" | "reject" | "abstain", "reason": "brief explanation", "confidence": 0.0-1.0 }',
  ].join("\n");

  const fullPrompt = [
    systemPrompt,
    "",
    "---",
    `Review type: ${reviewType}`,
    ...reviewDetails,
    "---",
    "",
    "Respond with ONLY a JSON object, no other text:",
  ].join("\n");

  // Call the LLM via OpenClaw
  if (!deps.runOpenClawPrompt) {
    return failedOutcome(
      command,
      "OpenClaw prompt runner not available.",
      "review_no_llm",
    );
  }

  try {
    const result = await deps.runOpenClawPrompt({
      prompt: fullPrompt,
      purpose: "content_review",
    });

    if (!result) {
      return failedOutcome(
        command,
        "LLM returned no result for review.",
        "review_llm_empty",
      );
    }

    // Parse the verdict from the LLM response
    let verdict: "approve" | "reject" | "abstain" = "abstain";
    let reason = "Could not parse LLM response.";
    let confidence = 0.5;

    const parsed = isRecord(result.parsed) ? result.parsed : null;
    const rawText = result.raw ?? "";

    if (parsed) {
      if (
        parsed.verdict === "approve" ||
        parsed.verdict === "reject" ||
        parsed.verdict === "abstain"
      ) {
        verdict = parsed.verdict;
      }
      if (typeof parsed.reason === "string") {
        reason = parsed.reason;
      }
      if (typeof parsed.confidence === "number") {
        confidence = Math.max(0, Math.min(1, parsed.confidence));
      }
    } else {
      // Try to extract JSON from the raw text
      const jsonMatch = rawText.match(/\{[^}]*"verdict"\s*:\s*"(approve|reject|abstain)"[^}]*\}/);
      if (jsonMatch) {
        try {
          const extracted = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
          if (
            extracted.verdict === "approve" ||
            extracted.verdict === "reject" ||
            extracted.verdict === "abstain"
          ) {
            verdict = extracted.verdict;
          }
          if (typeof extracted.reason === "string") {
            reason = extracted.reason;
          }
          if (typeof extracted.confidence === "number") {
            confidence = Math.max(0, Math.min(1, extracted.confidence));
          }
        } catch {
          // Fall through with abstain
        }
      }
    }

    // Submit the review verdict to the server
    const serverResult = await deps.submitReview({
      requestId,
      verdict,
      reason,
      confidence,
    });

    await deps.memory
      .recordWrite({
        type: "review_submitted",
        at: nowIso(),
        commandId: command.id,
        requestId,
        reviewType,
        verdict,
        confidence,
      })
      .catch(() => undefined);

    return successOutcome(command, {
      requestId,
      verdict,
      reason,
      confidence,
      serverResult,
    });
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    await deps.memory
      .recordWrite({
        type: "review_failed",
        at: nowIso(),
        commandId: command.id,
        requestId,
        reviewType,
        error: errorMessage,
      })
      .catch(() => undefined);

    return failedOutcome(
      command,
      `Review execution failed: ${errorMessage}`,
      "review_execution_failed",
    );
  }
}

function buildReviewDetails(
  reviewType: string,
  payload: Record<string, unknown>,
): string[] {
  if (reviewType === "username_review") {
    const textParts: string[] = ["Text to review:"];
    if (typeof payload.newHandle === "string") {
      textParts.push(`Username/handle: @${payload.newHandle}`);
    }
    if (typeof payload.newDisplayName === "string") {
      textParts.push(`Display name: ${payload.newDisplayName}`);
    }
    if (textParts.length === 1) {
      textParts.push("No text provided");
    }
    return textParts;
  }

  const sections: string[] = [];
  if (typeof payload.contentUrl === "string") {
    sections.push(`Primary media URL: ${payload.contentUrl}`);
  }
  if (typeof payload.textContent === "string" && payload.textContent.trim().length > 0) {
    sections.push(`Associated text:\n${payload.textContent.trim()}`);
  }
  const algorithmicSummary =
    payload.algorithmicSummary &&
    typeof payload.algorithmicSummary === "object" &&
    !Array.isArray(payload.algorithmicSummary)
      ? JSON.stringify(payload.algorithmicSummary)
      : null;
  if (algorithmicSummary) {
    sections.push(`Algorithmic summary: ${algorithmicSummary}`);
  }
  const policy =
    payload.policy && typeof payload.policy === "object" && !Array.isArray(payload.policy)
      ? JSON.stringify(payload.policy)
      : null;
  if (policy) {
    sections.push(`Policy: ${policy}`);
  }
  if (sections.length === 0) {
    sections.push("No structured review details were provided.");
  }
  return sections;
}
