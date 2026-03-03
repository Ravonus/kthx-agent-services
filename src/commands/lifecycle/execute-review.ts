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

  // Build the text to review from the payload
  const textParts: string[] = [];
  if (typeof payload.newHandle === "string") {
    textParts.push(`Username/handle: @${payload.newHandle}`);
  }
  if (typeof payload.newDisplayName === "string") {
    textParts.push(`Display name: ${payload.newDisplayName}`);
  }
  const textToReview = textParts.join("\n") || "No text provided";

  // Build the LLM prompt using the moderation guidelines from the server
  const systemPrompt = moderationGuidelines ?? [
    "You are a content moderation reviewer.",
    "Evaluate the text for appropriateness. PG-13 acceptable. No racism, profanity, hate speech, or sexually explicit content.",
    'Respond ONLY with JSON: { "verdict": "approve" | "reject", "reason": "brief explanation", "confidence": 0.0-1.0 }',
  ].join("\n");

  const fullPrompt = [
    systemPrompt,
    "",
    "---",
    `Review type: ${reviewType}`,
    `Text to review:`,
    textToReview,
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
      if (parsed.verdict === "approve" || parsed.verdict === "reject") {
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
      const jsonMatch = rawText.match(/\{[^}]*"verdict"\s*:\s*"(approve|reject)"[^}]*\}/);
      if (jsonMatch) {
        try {
          const extracted = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
          if (extracted.verdict === "approve" || extracted.verdict === "reject") {
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
