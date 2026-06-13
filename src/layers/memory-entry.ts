/**
 * memory-entry.ts
 * 
 * Defines the structure of a single entry stored in the in-memory
 * LRU cache (L1 layer).
 * 
 * Each entry holds the cached value along with metadata required
 * for TTL expiration, LRU eviction, size tracking, and tagging.
 */



/**
 * A single cached entry in the memory layer.
 * 
 * The LRU doubly-linked-list ordering is handled by the MemoryLayer
 * itself (using a Map which preserves insertion order in modern JS),
 * so entries don't store prev/next pointers.
 */
export interface MemoryEntry<T = unknown> {
  /** The cached value. */
  value: T;

  /**
   * Absolute timestamp (Date.now() ms) when this entry expires.
   * Set to `Infinity` for entries without a TTL.
   */
  expiresAt: number;

  /**
   * The original TTL in milliseconds that was used when this entry
   * was created.  Needed for stampede grace period calculations.
   */
  originalTTL: number;

  /**
   * Estimated byte size of the value (computed once at write time).
   * Used to enforce the `maxMemoryMB` limit.
   */
  sizeBytes: number;

  /**
   * Set of tags associated with this entry.
   * Used for bulk invalidation via `invalidateTag()`.
   */
  tags: Set<string>;

  /**
   * Timestamp (Date.now() ms) of the last time this entry was
   * accessed.  Used by the hot-key detector.
   */
  lastAccessedAt: number;

  /**
   * Number of times this entry has been accessed.
   * Used by the hot-key detector for ranking.
   */
  accessCount: number;
}
