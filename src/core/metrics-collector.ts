/**
 * metrics-collector.ts
 * 
 * Collects operational metrics for the cache system.
 * 
 * Tracks hits, misses, loader executions, timing data, and
 * computes derived metrics like hit rate and average load time.
 * 
 * The `snapshot()` method returns a `CacheStats` object suitable
 * for the `cache.stats()` API and the dashboard.
 */

import type { CacheStats, HotKeyEntry } from "../types/stats";
import { Logger } from "../utils/logger";



export class MetricsCollector {
  /** Total cache hits since startup. */
  private hits: number = 0;

  /** Total cache misses since startup. */
  private misses: number = 0;

  /** Hits served from L1 (memory). */
  private l1Hits: number = 0;

  /** Hits served from L2 (Redis). */
  private l2Hits: number = 0;

  /** Total number of loader functions executed. */
  private loadersExecuted: number = 0;

  /** Sum of all loader durations (ms) for average calculation. */
  private totalLoadTimeMs: number = 0;

  /** Logger instance. */
  private readonly log: Logger;

  constructor(debug: boolean = false) {
    this.log = new Logger("MetricsCollector", debug);
  }

  

  /**
   * Record a cache hit on a specific layer.
   * 
   * @param layer - Which layer served the hit: "l1" or "l2".
   */
  recordHit(layer: "l1" | "l2"): void {
    this.hits++;
    if (layer === "l1") {
      this.l1Hits++;
    } else {
      this.l2Hits++;
    }
  }

  /**
   * Record a cache miss.
   */
  recordMiss(): void {
    this.misses++;
  }

  /**
   * Record a loader execution with its duration.
   * 
   * @param durationMs - How long the loader took in milliseconds.
   */
  recordLoaderExecution(durationMs: number): void {
    this.loadersExecuted++;
    this.totalLoadTimeMs += durationMs;
  }

  

  /**
   * Produce a complete metrics snapshot.
   * 
   * Requires external data (memory usage, Redis status, etc.)
   * that the SuperiorCache orchestrator provides.
   * 
   * @param external - Data from other components.
   * @returns A complete CacheStats object.
   */
  snapshot(external: {
    l1Entries: number;
    l1MemoryBytes: number;
    redisConnected: boolean;
    redisLatencyMs: number;
    activeLocks: number;
    hotKeys: HotKeyEntry[];
  }): CacheStats {
    const total = this.hits + this.misses;

    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      l1Hits: this.l1Hits,
      l2Hits: this.l2Hits,
      l1Entries: external.l1Entries,
      l1MemoryBytes: external.l1MemoryBytes,
      redisConnected: external.redisConnected,
      redisLatencyMs: external.redisLatencyMs,
      loadersExecuted: this.loadersExecuted,
      avgLoadTimeMs: this.loadersExecuted > 0
        ? this.totalLoadTimeMs / this.loadersExecuted
        : 0,
      activeLocks: external.activeLocks,
      hotKeys: external.hotKeys,
    };
  }

  

  /** Get the current hit count. */
  getHits(): number { return this.hits; }

  /** Get the current miss count. */
  getMisses(): number { return this.misses; }

  /** Get the current hit rate (0..1). */
  getHitRate(): number {
    const total = this.hits + this.misses;
    return total > 0 ? this.hits / total : 0;
  }

  /** Get the number of loaders executed. */
  getLoadersExecuted(): number { return this.loadersExecuted; }

  

  /**
   * Reset all counters to zero.
   * Useful for periodic reporting or testing.
   */
  reset(): void {
    this.hits = 0;
    this.misses = 0;
    this.l1Hits = 0;
    this.l2Hits = 0;
    this.loadersExecuted = 0;
    this.totalLoadTimeMs = 0;
    this.log.debug("Metrics reset");
  }
}
