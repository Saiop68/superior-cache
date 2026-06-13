/**
 * time.ts
 * 
 * Time-related utility functions used throughout SuperiorCache.
 * 
 * Centralises timestamp creation, duration measurement, and
 * TTL arithmetic so the rest of the codebase doesn't have to
 * worry about Date vs performance.now() inconsistencies.
 */



/**
 * Returns the current high-resolution timestamp in milliseconds.
 * Uses `performance.now()` when available (Node 16+), otherwise
 * falls back to `Date.now()`.
 *
 * @returns Current time in milliseconds with sub-millisecond precision.
 */
export function nowMs(): number {
  // `performance` is globally available in Node 16+ without import.
  if (typeof performance !== "undefined" && performance.now) {
    return performance.now();
  }
  return Date.now();
}



/**
 * Measure the wall-clock duration of an async operation.
 * Returns both the result and the elapsed time in milliseconds.
 *
 * @param fn - An async function to execute and measure.
 * @returns A tuple of [result, elapsedMs].
 *
 * @example
 * ```ts
 * const [data, ms] = await measureAsync(() => db.query("SELECT ..."));
 * console.log(`Query took ${ms}ms`);
 * ```
 */
export async function measureAsync<T>(
  fn: () => Promise<T>
): Promise<[T, number]> {
  const start = nowMs();
  const result = await fn();
  const elapsed = nowMs() - start;
  return [result, elapsed];
}



/**
 * Calculate the absolute expiration timestamp from a TTL value.
 *
 * @param ttlMs - Time-to-live in milliseconds.
 * @returns The Unix timestamp (ms) at which the entry expires.
 */
export function expiresAt(ttlMs: number): number {
  return Date.now() + ttlMs;
}

/**
 * Check whether an absolute expiration timestamp has passed.
 *
 * @param expirationMs - The Unix timestamp (ms) when the entry expires.
 * @returns `true` if the entry is expired, `false` otherwise.
 */
export function isExpired(expirationMs: number): boolean {
  return Date.now() >= expirationMs;
}

/**
 * Compute the remaining TTL in milliseconds for an entry.
 * Returns 0 if the entry is already expired.
 *
 * @param expirationMs - The Unix timestamp (ms) when the entry expires.
 * @returns Remaining time in milliseconds (never negative).
 */
export function remainingTTL(expirationMs: number): number {
  return Math.max(0, expirationMs - Date.now());
}



/**
 * Returns a promise that resolves after `ms` milliseconds.
 * Useful for tests, retry back-off, and rate limiting.
 *
 * @param ms - Number of milliseconds to wait.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
