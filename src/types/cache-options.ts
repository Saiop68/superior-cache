/**
 * cache-options.ts
 * 
 * Defines every configuration option that SuperiorCache accepts.
 * These are the top-level options passed when creating a new cache instance.
 * Each field is documented so consumers know exactly what it controls.
 */

import type { RedisOptions } from "ioredis";
import type { SerializerType } from "./serializer";



/**
 * Options for the in-process LRU memory cache.
 * This is the fastest layer – pure in-memory access with no I/O.
 */
export interface MemoryLayerOptions {
  /** Maximum number of entries the memory cache can hold (default: 50_000). */
  maxEntries?: number;

  /** Maximum memory the cache is allowed to consume in megabytes (default: 512). */
  maxMemoryMB?: number;

  /** Default time-to-live in milliseconds for memory entries (default: 60_000 = 1 min). */
  defaultTTL?: number;

  /** How often (ms) to sweep for expired entries (default: 10_000 = 10 s). */
  sweepIntervalMs?: number;
}



/**
 * Options for the Redis-backed cache layer.
 * Supports all standard ioredis connection options.
 */
export interface RedisLayerOptions {
  /** Standard ioredis connection options (host, port, password, etc.). */
  connection?: RedisOptions;

  /** A Redis URL string (e.g. redis://user:pass@host:6379/0). Overrides `connection`. */
  url?: string;

  /** Key prefix added to every Redis key to avoid collisions (default: "sc:"). */
  keyPrefix?: string;

  /** Default TTL in milliseconds for Redis entries (default: 300_000 = 5 min). */
  defaultTTL?: number;

  /** Enable distributed invalidation over Redis Pub/Sub (default: true). */
  enablePubSub?: boolean;

  /** Channel name used for Pub/Sub invalidation messages (default: "superior-cache:invalidation"). */
  pubSubChannel?: string;

  /** Connection timeout in milliseconds (default: 5_000). */
  connectTimeoutMs?: number;
}



/**
 * Controls how the cache handles stampede protection and background refresh.
 */
export interface StampedeOptions {
  /** Enable stampede protection globally (default: true). */
  enabled?: boolean;

  /**
   * Grace period in milliseconds.  When a key expires, the stale value
   * is still served for this duration while a background refresh runs.
   * Default: 30_000 (30 s).
   */
  graceMs?: number;

  /**
   * Percentage of TTL remaining at which a background refresh is triggered.
   * For example, 0.2 means "refresh when 20 % of the TTL remains".
   * Only applies when `refreshAhead` is enabled on a fetch call.
   * Default: 0.2.
   */
  refreshAheadFraction?: number;
}



/**
 * Controls automatic compression of large values before they are stored.
 */
export interface CompressionOptions {
  /** Enable automatic compression (default: false). */
  enabled?: boolean;

  /**
   * Minimum value size (bytes) before compression kicks in.
   * Values smaller than this threshold are stored as-is.
   * Default: 1024 (1 KB).
   */
  thresholdBytes?: number;
}



/**
 * Options for multi-process / cluster synchronisation.
 */
export interface ClusterOptions {
  /** Enable Node.js cluster IPC-based invalidation (default: auto-detect). */
  enabled?: boolean;

  /** Unique identifier for this node in the cluster (default: auto-generated). */
  nodeId?: string;
}



/**
 * Configuration for the hot-key detector which tracks the most
 * frequently accessed keys.
 */
export interface HotKeyOptions {
  /** Enable hot-key tracking (default: true). */
  enabled?: boolean;

  /** Number of top keys to keep in the ranking (default: 100). */
  topN?: number;

  /** How often (ms) to decay the access counts to age out old data (default: 60_000). */
  decayIntervalMs?: number;
}



/**
 * The full set of configuration options for SuperiorCache.
 * Everything has sensible defaults so you can start with just `new SuperiorCache()`.
 */
export interface SuperiorCacheOptions {
  /** Configuration for the in-memory L1 cache. */
  memory?: MemoryLayerOptions;

  /** Configuration for the Redis L2 cache.  Set to `false` to disable Redis entirely. */
  redis?: RedisLayerOptions | false;

  /** Stampede protection and background refresh settings. */
  stampede?: StampedeOptions;

  /** Automatic compression settings. */
  compression?: CompressionOptions;

  /** Serializer to use when storing values in Redis (default: "json"). */
  serializer?: SerializerType;

  /** Cluster synchronisation settings. */
  cluster?: ClusterOptions;

  /** Hot key detection settings. */
  hotKeys?: HotKeyOptions;

  /** Global default TTL in milliseconds (default: 60_000). */
  defaultTTL?: number;

  /** Enable verbose debug logging to stdout (default: false). */
  debug?: boolean;
}



/**
 * Options that can be passed to individual `set` / `fetch` calls
 * to override global defaults on a per-key basis.
 */
export interface SetOptions {
  /** Time-to-live for this specific key, in milliseconds. */
  ttl?: number;

  /** Tags to associate with this key for bulk invalidation. */
  tags?: string[];

  /** If true, skip writing to the Redis layer. */
  localOnly?: boolean;

  /** If true, compress this value regardless of global settings. */
  compress?: boolean;
}

/**
 * Options for the `fetch` method which combines get + loader + set.
 */
export interface FetchOptions extends SetOptions {
  /**
   * Enable refresh-ahead for this key.
   * When the remaining TTL drops below the configured threshold,
   * a background refresh is triggered automatically.
   */
  refreshAhead?: boolean;

  /**
   * Force a fresh load even if the cache has a valid entry.
   * Useful for "cache-bust" scenarios.
   */
  forceRefresh?: boolean;
}

/**
 * Represents a single entry in a batch `mset` call.
 */
export interface BatchSetEntry<T = unknown> {
  key: string;
  value: T;
  options?: SetOptions;
}
