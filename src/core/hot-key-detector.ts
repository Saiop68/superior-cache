/**
 * hot-key-detector.ts
 * 
 * Detects heavily-accessed "hot" keys in the cache.
 * 
 * Hot-key detection helps operators identify:
 *  - Keys that might benefit from longer TTLs
 *  - Keys that are candidates for preloading
 *  - Potential bottlenecks in the data layer
 * 
 * Implementation:
 *  - Maintains a frequency counter (Map<key, count>) that is
 *    incremented on every cache access (get / fetch).
 *  - Periodically decays counts by halving them, so the ranking
 *    reflects recent traffic rather than all-time totals.
 *  - Returns the top-N keys by access frequency on demand.
 */

import { Logger } from "../utils/logger";
import type { HotKeyOptions } from "../types/cache-options";
import type { HotKeyEntry } from "../types/stats";



const DEFAULTS = {
  enabled: true,
  topN: 100,
  decayIntervalMs: 60_000, // 1 minute
} as const;



export class HotKeyDetector {
  /** Frequency counter: key → access count. */
  private readonly counters: Map<string, number>;

  /** Whether detection is enabled. */
  private readonly enabled: boolean;

  /** Number of top keys to track. */
  private readonly topN: number;

  /** Handle to the periodic decay timer. */
  private decayTimer: ReturnType<typeof setInterval> | null;

  /** Logger instance. */
  private readonly log: Logger;

  constructor(options: HotKeyOptions = {}, debug: boolean = false) {
    this.counters = new Map();
    this.enabled = options.enabled ?? DEFAULTS.enabled;
    this.topN = options.topN ?? DEFAULTS.topN;
    this.decayTimer = null;
    this.log = new Logger("HotKeyDetector", debug);

    if (this.enabled) {
      this.startDecay(options.decayIntervalMs ?? DEFAULTS.decayIntervalMs);
    }
  }

  /**
   * Record an access to a cache key.
   * Increments the frequency counter for the key.
   * 
   * @param key - The cache key that was accessed.
   */
  recordAccess(key: string): void {
    if (!this.enabled) return;

    const current = this.counters.get(key) ?? 0;
    this.counters.set(key, current + 1);
  }

  /**
   * Get the top-N most frequently accessed keys.
   * 
   * @param n - Override the default top-N count (optional).
   * @returns Array of { key, hits } sorted by hits descending.
   */
  getHotKeys(n?: number): HotKeyEntry[] {
    const limit = n ?? this.topN;
    const entries: HotKeyEntry[] = [];

    for (const [key, hits] of this.counters) {
      entries.push({ key, hits });
    }

    // Sort descending by hit count
    entries.sort((a, b) => b.hits - a.hits);

    return entries.slice(0, limit);
  }

  /**
   * Check if a specific key is "hot" (in the top-N).
   * 
   * @param key - The cache key to check.
   * @returns `true` if the key is in the top-N by access count.
   */
  isHot(key: string): boolean {
    const hotKeys = this.getHotKeys();
    return hotKeys.some((entry) => entry.key === key);
  }

  /**
   * Get the access count for a specific key.
   * 
   * @param key - The cache key.
   * @returns The access count (0 if never accessed).
   */
  getAccessCount(key: string): number {
    return this.counters.get(key) ?? 0;
  }

  /**
   * Decay all counters by halving them.
   * Removes entries that drop to zero.
   * 
   * This ensures the hot-key ranking reflects recent traffic
   * patterns rather than all-time totals.
   */
  decay(): void {
    for (const [key, count] of this.counters) {
      const newCount = Math.floor(count / 2);
      if (newCount === 0) {
        this.counters.delete(key);
      } else {
        this.counters.set(key, newCount);
      }
    }

    this.log.debug(`Decayed ${this.counters.size} counters`);
  }

  /**
   * Remove a key from the hot-key tracker.
   * Called when a key is deleted from the cache.
   * 
   * @param key - The cache key to remove.
   */
  remove(key: string): void {
    this.counters.delete(key);
  }

  /**
   * Clear all counters.
   */
  clear(): void {
    this.counters.clear();
  }

  /**
   * Stop the decay timer and clean up.
   */
  destroy(): void {
    if (this.decayTimer) {
      clearInterval(this.decayTimer);
      this.decayTimer = null;
    }
    this.clear();
    this.log.debug("Hot key detector destroyed");
  }

  

  /**
   * Start the periodic decay timer.
   * @param intervalMs - How often to decay counters.
   */
  private startDecay(intervalMs: number): void {
    this.decayTimer = setInterval(() => {
      this.decay();
    }, intervalMs);

    // Don't prevent Node.js from exiting
    if (this.decayTimer.unref) {
      this.decayTimer.unref();
    }
  }
}
