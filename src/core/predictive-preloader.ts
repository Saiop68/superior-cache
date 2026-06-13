/**
 * predictive-preloader.ts
 * 
 * Learns access patterns and preloads frequently co-accessed keys.
 * 
 * When key A is often accessed just before key B, the preloader
 * learns this pattern and automatically loads B in the background
 * when A is accessed, so B is already cached when it's needed.
 * 
 * Implementation:
 *  - Tracks sequential access pairs within a configurable time window.
 *  - When a pair (A → B) occurs more than `minFrequency` times,
 *    it is registered as a preload rule.
 *  - On access of A, B is fetched in the background if not cached.
 *  - Only works with keys that have a registered loader (via fetch).
 * 
 * This is an advanced optimisation for applications with predictable
 * access patterns (e.g. fetching a user profile → then their posts).
 */

import { Logger } from "../utils/logger";



const DEFAULTS = {
  /**
   * Maximum time (ms) between two accesses for them to be
   * considered "sequential" (part of the same pattern).
   */
  windowMs: 5_000,

  /**
   * Minimum number of times a pair must occur before
   * preloading is triggered.
   */
  minFrequency: 3,

  /**
   * Maximum number of patterns to track (to bound memory).
   */
  maxPatterns: 1_000,
} as const;



interface PatternEntry {
  /** How many times this A → B pattern has been observed. */
  frequency: number;

  /** Timestamp of the last observation. */
  lastSeen: number;
}



export class PredictivePreloader {
  /**
   * Tracks pair frequencies: "keyA → keyB" → PatternEntry.
   * The composite key is `${keyA}\0${keyB}`.
   */
  private readonly patterns: Map<string, PatternEntry>;

  /** The last accessed key and when it was accessed. */
  private lastAccess: { key: string; time: number } | null;

  /** Time window (ms) for considering two accesses as sequential. */
  private readonly windowMs: number;

  /** Minimum frequency before preloading kicks in. */
  private readonly minFrequency: number;

  /** Maximum number of patterns to track. */
  private readonly maxPatterns: number;

  /** Logger instance. */
  private readonly log: Logger;

  constructor(debug: boolean = false) {
    this.patterns = new Map();
    this.lastAccess = null;
    this.windowMs = DEFAULTS.windowMs;
    this.minFrequency = DEFAULTS.minFrequency;
    this.maxPatterns = DEFAULTS.maxPatterns;
    this.log = new Logger("PredictivePreloader", debug);
  }

  /**
   * Record a key access and learn sequential patterns.
   * 
   * If the previous access was within the time window, this
   * creates/increments a pattern entry for the pair.
   * 
   * @param key - The cache key that was just accessed.
   */
  recordAccess(key: string): void {
    const now = Date.now();

    if (this.lastAccess) {
      const elapsed = now - this.lastAccess.time;

      // Only track if within the time window and it's a different key
      if (elapsed <= this.windowMs && this.lastAccess.key !== key) {
        this.incrementPattern(this.lastAccess.key, key);
      }
    }

    this.lastAccess = { key, time: now };
  }

  /**
   * Get keys that should be preloaded when `key` is accessed.
   * 
   * Returns keys that have been frequently accessed after `key`
   * (frequency >= minFrequency).
   * 
   * @param key - The key that was just accessed.
   * @returns Array of keys to preload.
   */
  getPreloadTargets(key: string): string[] {
    const targets: string[] = [];

    for (const [compositeKey, entry] of this.patterns) {
      const [sourceKey, targetKey] = compositeKey.split("\0");

      if (sourceKey === key && entry.frequency >= this.minFrequency) {
        targets.push(targetKey);
      }
    }

    return targets;
  }

  /**
   * Check if there are any preload targets for a given key.
   * 
   * @param key - The source key.
   * @returns `true` if preloading targets exist.
   */
  hasPreloadTargets(key: string): boolean {
    for (const [compositeKey, entry] of this.patterns) {
      const [sourceKey] = compositeKey.split("\0");
      if (sourceKey === key && entry.frequency >= this.minFrequency) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get all learned patterns for inspection/debugging.
   * 
   * @returns Array of { source, target, frequency } objects.
   */
  getPatterns(): Array<{
    source: string;
    target: string;
    frequency: number;
  }> {
    const result: Array<{
      source: string;
      target: string;
      frequency: number;
    }> = [];

    for (const [compositeKey, entry] of this.patterns) {
      const [source, target] = compositeKey.split("\0");
      result.push({ source, target, frequency: entry.frequency });
    }

    return result.sort((a, b) => b.frequency - a.frequency);
  }

  /**
   * Clear all learned patterns.
   */
  clear(): void {
    this.patterns.clear();
    this.lastAccess = null;
    this.log.debug("All patterns cleared");
  }

  /**
   * Clean up resources.
   */
  destroy(): void {
    this.clear();
    this.log.debug("Predictive preloader destroyed");
  }

  

  /**
   * Increment the frequency counter for a source → target pattern.
   * 
   * @param source - The first key in the pair.
   * @param target - The second key in the pair.
   */
  private incrementPattern(source: string, target: string): void {
    const compositeKey = `${source}\0${target}`;
    const existing = this.patterns.get(compositeKey);

    if (existing) {
      existing.frequency++;
      existing.lastSeen = Date.now();
    } else {
      // Enforce max patterns limit
      if (this.patterns.size >= this.maxPatterns) {
        this.evictOldestPattern();
      }

      this.patterns.set(compositeKey, {
        frequency: 1,
        lastSeen: Date.now(),
      });
    }

    this.log.debug(
      `Pattern "${source}" → "${target}": ` +
      `frequency=${this.patterns.get(compositeKey)?.frequency}`
    );
  }

  /**
   * Remove the oldest (least recently seen) pattern to make room.
   */
  private evictOldestPattern(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.patterns) {
      if (entry.lastSeen < oldestTime) {
        oldestTime = entry.lastSeen;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.patterns.delete(oldestKey);
    }
  }
}
