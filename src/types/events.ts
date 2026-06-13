/**
 * events.ts
 * 
 * Defines the event map for the SuperiorCache event system.
 * Every cache event (hit, miss, set, delete, expire, etc.) is
 * strongly typed so consumers get full IntelliSense support.
 */



/** Payload emitted when a cache HIT occurs. */
export interface CacheHitEvent {
  /** The cache key that was accessed. */
  key: string;

  /** Which layer served the hit: "l1" (memory) or "l2" (Redis). */
  layer: "l1" | "l2";

  /** Time taken to retrieve the value, in milliseconds. */
  latencyMs: number;
}

/** Payload emitted when a cache MISS occurs. */
export interface CacheMissEvent {
  /** The cache key that was requested but not found. */
  key: string;
}

/** Payload emitted when a value is SET in the cache. */
export interface CacheSetEvent {
  /** The cache key that was written. */
  key: string;

  /** The TTL (ms) applied to this entry, if any. */
  ttl?: number;

  /** Tags associated with this entry. */
  tags?: string[];
}

/** Payload emitted when a key is explicitly DELETED. */
export interface CacheDeleteEvent {
  /** The cache key that was removed. */
  key: string;

  /** Whether this deletion was triggered by a cascade (dependency). */
  cascaded: boolean;
}

/** Payload emitted when a key EXPIRES naturally. */
export interface CacheExpireEvent {
  /** The cache key that expired. */
  key: string;
}

/** Payload emitted when an entire tag group is invalidated. */
export interface TagInvalidationEvent {
  /** The tag that was invalidated. */
  tag: string;

  /** Number of keys affected by this invalidation. */
  keysAffected: number;
}

/** Payload emitted when a loader function is executed. */
export interface LoaderExecutionEvent {
  /** The cache key the loader was invoked for. */
  key: string;

  /** Time the loader took to complete, in milliseconds. */
  durationMs: number;

  /** Whether this loader call was deduplicated (other waiters joined). */
  deduplicated: boolean;
}

/** Payload emitted when an error occurs internally. */
export interface CacheErrorEvent {
  /** A human-readable description of what went wrong. */
  message: string;

  /** The underlying error object, if available. */
  error: Error;

  /** The component that produced the error (e.g. "redis", "memory", "loader"). */
  source: string;
}



/**
 * Maps event names to their payload types.
 * Used by the EventEmitter wrapper to provide type-safe `.on()` / `.emit()`.
 */
export interface CacheEventMap {
  hit: CacheHitEvent;
  miss: CacheMissEvent;
  set: CacheSetEvent;
  delete: CacheDeleteEvent;
  expire: CacheExpireEvent;
  tagInvalidation: TagInvalidationEvent;
  loaderExecution: LoaderExecutionEvent;
  error: CacheErrorEvent;
}

/**
 * All valid event names.
 */
export type CacheEventName = keyof CacheEventMap;
