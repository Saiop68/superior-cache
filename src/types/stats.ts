/**
 * stats.ts
 * 
 * Defines the shape of the statistics / metrics object returned
 * by `cache.stats()`. This gives operators a snapshot of cache
 * health, hit rates, memory consumption, and loader performance.
 */



/**
 * A single hot-key entry showing its key name and access count.
 */
export interface HotKeyEntry {
  /** The cache key. */
  key: string;

  /** Number of times this key was accessed since the last decay. */
  hits: number;
}

/**
 * Complete statistics snapshot returned by `cache.stats()`.
 */
export interface CacheStats {
  /** Total number of cache hits (L1 + L2) since startup. */
  hits: number;

  /** Total number of cache misses since startup. */
  misses: number;

  /** Hit rate as a fraction (0..1). Computed as hits / (hits + misses). */
  hitRate: number;

  /** Number of hits served from the L1 (memory) layer. */
  l1Hits: number;

  /** Number of hits served from the L2 (Redis) layer. */
  l2Hits: number;

  /** Current number of entries in the L1 memory cache. */
  l1Entries: number;

  /** Estimated memory consumption of the L1 cache, in bytes. */
  l1MemoryBytes: number;

  /** Whether the Redis connection is currently active. */
  redisConnected: boolean;

  /** Latest Redis round-trip latency in milliseconds (from PING). */
  redisLatencyMs: number;

  /** Total number of loader functions executed since startup. */
  loadersExecuted: number;

  /** Average time (ms) that loader functions take to complete. */
  avgLoadTimeMs: number;

  /** Number of distributed locks currently held by this instance. */
  activeLocks: number;

  /** The current list of most frequently accessed keys. */
  hotKeys: HotKeyEntry[];
}
