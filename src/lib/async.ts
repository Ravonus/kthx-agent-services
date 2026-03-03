/**
 * Async utility functions — shared across the agent-service.
 */

/** Delay execution for `ms` milliseconds. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * Apply jitter to a millisecond value.
 *
 * @param ms    Base delay in milliseconds.
 * @param jitter Fraction of variance (default `0.2` = ±20%).
 * @returns     Jittered delay, clamped to a non-negative integer.
 */
export const jitterDelay = (ms: number, jitter = 0.2): number => {
  const multiplier = 1 + (Math.random() * 2 - 1) * jitter;
  return Math.max(0, Math.round(ms * multiplier));
};
