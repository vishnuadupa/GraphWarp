/**
 * Shared retry helper with exponential back-off.
 *
 * Only retries on transient errors (rate-limits, overload, server errors).
 * Re-throws immediately on non-retryable errors (auth, bad request, etc.)
 * so callers don't waste time on deterministic failures.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 1500,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const msg: string = err?.message ?? '';

      const isTransient =
        msg.includes('429') ||
        msg.includes('quota') ||
        msg.includes('rate') ||
        msg.includes('limit') ||
        msg.includes('503') ||
        msg.includes('502') ||
        msg.includes('Service Unavailable') ||
        msg.includes('overloaded') ||
        msg.includes('high demand') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('ECONNRESET');

      // Non-transient error — don't retry, surface immediately
      if (!isTransient || attempt === maxAttempts) throw err;

      // 429 / quota: back off more aggressively
      const delay = (msg.includes('429') || msg.includes('quota'))
        ? baseDelayMs * 2 * Math.pow(1.5, attempt - 1)
        : baseDelayMs * Math.pow(2, attempt - 1);

      console.warn(
        `[retry] Attempt ${attempt}/${maxAttempts} failed (${msg.slice(0, 80)}). ` +
        `Retrying in ${Math.round(delay)}ms…`,
      );
      await new Promise((r) => setTimeout(r, delay));
      lastError = err;
    }
  }
  throw lastError;
}
