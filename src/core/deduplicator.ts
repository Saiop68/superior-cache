/**
 * deduplicator.ts
 * 
 * Prevents duplicate loader executions for the same cache key.
 * 
 * When multiple concurrent requests ask for the same key that
 * is not in the cache, only ONE loader function is executed.
 * All other requests wait for (and share) the result of that
 * single execution.
 * 
 * Implementation:
 *  - A Map tracks in-flight loader Promises keyed by cache key.
 *  - The first request for a key creates a Promise and stores it.
 *  - Subsequent requests for the same key await the stored Promise.
 *  - Once the Promise resolves/rejects, it is removed from the Map.
 * 
 * This is crucial for preventing "thundering herd" issues where
 * a popular key expires and hundreds of requests all try to
 * reload it simultaneously.
 */

import { Logger } from "../utils/logger";



export class Deduplicator {
  /**
   * Map of cache key → in-flight Promise.
   * The Promise resolves to the loader result (or rejects on error).
   */
  private readonly inflight: Map<string, Promise<unknown>>;

  /** Logger for diagnostics. */
  private readonly log: Logger;

  constructor(debug: boolean = false) {
    this.inflight = new Map();
    this.log = new Logger("Deduplicator", debug);
  }

  /**
   * Execute a loader function, deduplicating concurrent calls for the same key.
   * 
   * If another call is already in-flight for this key, the current call
   * will piggyback on the existing Promise instead of executing the
   * loader again.
   * 
   * @param key    - The cache key being loaded.
   * @param loader - The async function that fetches the data.
   * @returns An object with:
   *   - `value`: The loaded value.
   *   - `deduplicated`: Whether this call piggybacked on an existing one.
   * 
   * @example
   * ```ts
   * // 100 concurrent calls – only 1 loader execution
   * const results = await Promise.all(
   *   Array.from({ length: 100 }, () =>
   *     deduplicator.dedupe("user:123", () => db.findUser(123))
   *   )
   * );
   * ```
   */
  async dedupe<T>(
    key: string,
    loader: () => Promise<T>
  ): Promise<{ value: T; deduplicated: boolean }> {
    // Check if there's already an in-flight request for this key
    const existing = this.inflight.get(key);
    if (existing) {
      this.log.debug(`Deduplicating request for "${key}"`);
      const value = await existing;
      return { value: value as T, deduplicated: true };
    }

    // Create the Promise for this loader execution
    const promise = this.executeLoader(key, loader);
    this.inflight.set(key, promise);

    try {
      const value = await promise;
      return { value: value as T, deduplicated: false };
    } finally {
      // Always clean up the in-flight entry, even on error
      this.inflight.delete(key);
    }
  }

  /**
   * Check whether a loader is currently in-flight for a given key.
   * 
   * @param key - The cache key to check.
   * @returns `true` if a loader is currently executing for this key.
   */
  isInflight(key: string): boolean {
    return this.inflight.has(key);
  }

  /**
   * Get the number of currently in-flight loader executions.
   */
  get inflightCount(): number {
    return this.inflight.size;
  }

  /**
   * Clear all in-flight trackers.
   * WARNING: This does not cancel the actual loader executions.
   */
  clear(): void {
    this.inflight.clear();
  }

  

  /**
   * Execute the loader and handle errors gracefully.
   * 
   * @param key    - The cache key (for logging).
   * @param loader - The async loader function.
   * @returns The loader result.
   */
  private async executeLoader<T>(key: string, loader: () => Promise<T>): Promise<T> {
    this.log.debug(`Executing loader for "${key}"`);

    try {
      const result = await loader();
      this.log.debug(`Loader for "${key}" completed successfully`);
      return result;
    } catch (err) {
      this.log.error(`Loader for "${key}" failed:`, (err as Error).message);
      throw err;
    }
  }
}
