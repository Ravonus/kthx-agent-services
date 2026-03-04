import fs from "node:fs/promises";

import { isRecord } from "../lib/guards.js";

export interface PendingMintChallengeRecord {
  challengeId: string;
  promptToken: string | null;
  instruction: string;
  answerType: string | null;
  attemptsRemaining: number | null;
  expiresAt: string | null;
  expiresAtMs: number | null;
  solverFailures: number;
}

export type RestorePendingChallengeFromDebugDeps = {
  mintDebugPath: string;
  expirySkewMs: number;
  trace: (payload: Record<string, unknown>) => Promise<void>;
};

export const restorePendingChallengeFromDebug = async (
  deps: RestorePendingChallengeFromDebugDeps,
): Promise<PendingMintChallengeRecord | null> => {
  const raw = await fs.readFile(deps.mintDebugPath, "utf8").catch(() => null);
  if (!raw || !raw.trim().length) return null;

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const challengeId =
    typeof parsed.pendingChallengeId === "string" &&
    parsed.pendingChallengeId.trim().length > 0
      ? parsed.pendingChallengeId.trim()
      : null;
  if (!challengeId) return null;

  const instruction =
    typeof parsed.pendingChallengeInstruction === "string" &&
    parsed.pendingChallengeInstruction.trim().length > 0
      ? parsed.pendingChallengeInstruction.trim()
      : null;
  if (!instruction) return null;

  const promptToken =
    typeof parsed.pendingPromptToken === "string" &&
    parsed.pendingPromptToken.trim().length > 0
      ? parsed.pendingPromptToken.trim()
      : null;
  const answerType =
    typeof parsed.pendingChallengeAnswerType === "string" &&
    parsed.pendingChallengeAnswerType.trim().length > 0
      ? parsed.pendingChallengeAnswerType.trim()
      : null;
  const attemptsRemaining =
    typeof parsed.pendingChallengeAttemptsRemaining === "number" &&
    Number.isFinite(parsed.pendingChallengeAttemptsRemaining)
      ? Math.max(0, Math.floor(parsed.pendingChallengeAttemptsRemaining))
      : null;
  const expiresAt =
    typeof parsed.pendingChallengeExpiresAt === "string" &&
    parsed.pendingChallengeExpiresAt.trim().length > 0
      ? parsed.pendingChallengeExpiresAt.trim()
      : null;
  const expiresAtMs =
    expiresAt && Number.isFinite(Date.parse(expiresAt))
      ? Date.parse(expiresAt)
      : null;
  if (
    expiresAtMs !== null &&
    Date.now() >= expiresAtMs - deps.expirySkewMs
  ) {
    return null;
  }

  const solverFailures =
    typeof parsed.pendingChallengeSolverFailures === "number" &&
    Number.isFinite(parsed.pendingChallengeSolverFailures)
      ? Math.max(0, Math.floor(parsed.pendingChallengeSolverFailures))
      : 0;

  const restored: PendingMintChallengeRecord = {
    challengeId,
    promptToken,
    instruction,
    answerType,
    attemptsRemaining,
    expiresAt,
    expiresAtMs,
    solverFailures,
  };
  await deps.trace({
    type: "mint_challenge_restored_from_debug",
    challengeId,
    promptToken,
    attemptsRemaining,
    expiresAt,
    solverFailures,
  });

  return restored;
};
