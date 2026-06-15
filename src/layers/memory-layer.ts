/**
 * memory-layer.ts
 *
 * L1 in-process cache using the SIEVE eviction algorithm backed by
 * pre-allocated typed arrays for near-zero GC pressure.
 *
 * Why SIEVE over strict LRU?
 *   - get() sets a single visited bit instead of delete+re-insert in Map.
 *     This drops the write cost of reads from 2 hash ops to 1 byte store.
 *   - Eviction scans a contiguous Uint8Array (L1-cache friendly) instead
 *     of chasing object pointers through the heap.
 *   - Hit ratio is equal or better than LRU on Zipfian and scan-heavy
 *     workloads because one-hit-wonders get evicted quickly while popular
 *     items accumulate visited=1 and survive multiple hand sweeps.
 *
 * Data layout (all arrays sized to `maxEntries` at construction):
 *   keys[i]     : string         — plain array
 *   vals[i]     : unknown        — plain array
 *   next[i]     : Int32Array     — next pointer in doubly-linked FIFO
 *   prev[i]     : Int32Array     — prev pointer in doubly-linked FIFO
 *   visited[i]  : Uint8Array     — SIEVE visited bit (0 or 1)
 *   expires[i]  : Float64Array   — absolute ms timestamp (0 = no TTL)
 *   sizes[i]    : Float64Array   — estimated byte size of entry
 *   tags[i]     : Set<string>|null — tag set (null when unused)
 *   accessCounts[i] : Uint32Array — access count for hot-key tracking
 *   originalTTLs[i] : Float64Array — original TTL for refresh-ahead calcs
 *
 * Free-list: evicted slot indices are pushed onto a stack for O(1) reuse.
 * The FIFO queue is a doubly-linked list threaded through next[]/prev[].
 */

import type { MemoryLayerOptions } from "../types/cache-options";
import { estimateSize } from "../utils/size-estimator";
import { Logger } from "../utils/logger";

const NONE = -1;

/**
 * Coarsened timestamp cache.
 *
 * Instead of calling Date.now() on every get()/has()/set() — which is
 * a syscall or vDSO read per call — we cache the result and refresh it
 * every ~4ms. This trades ≤4ms of expiry precision for eliminating
 * the #1 overhead on the TTL-enabled hot path.
 *
 * The timer is module-level and shared across all MemoryLayer instances.
 * It uses unref() so it doesn't prevent Node.js from exiting.
 */
let cachedNow = Date.now();
const nowTimer = setInterval(() => { cachedNow = Date.now(); }, 4);
if (nowTimer.unref) nowTimer.unref();

const DEFAULTS = {
  maxEntries: 50_000,
  maxMemoryMB: 512,
  defaultTTL: 60_000,
  sweepIntervalMs: 10_000,
} as const;

export class MemoryLayer {
  // Key → slot index lookup. This is the only Map.
  private readonly keyMap: Map<string, number>;

  // Parallel arrays — values and keys are plain arrays (hold arbitrary JS),
  // everything else is typed arrays for contiguous memory and zero GC.
  private readonly keys: (string | undefined)[];
  private readonly vals: (unknown | undefined)[];
  private readonly next: Int32Array;
  private readonly prev: Int32Array;
  private readonly visited: Uint8Array;
  private readonly expires: Float64Array;
  private readonly entrySizes: Float64Array;
  private readonly originalTTLs: Float64Array;
  private readonly accessCounts: Uint32Array;
  private readonly entryTags: (Set<string> | null)[];

  // SIEVE hand pointer
  private hand: number;

  // FIFO queue head/tail (head = newest, tail = oldest)
  private head: number;
  private tail: number;

  // Free-list (stack of available slot indices)
  private readonly freeStack: Int32Array;
  private freeTop: number;

  // Capacity config
  private readonly maxEntries: number;
  private readonly maxMemoryBytes: number;
  private readonly defaultTTL: number;

  // Fast-path flags — set once at construction so V8 can
  // inline the hot path without TTL/size/hotkey branches.
  private readonly hasTTL: boolean;
  private readonly hasMemoryLimit: boolean;
  private readonly hasHotKeys: boolean;

  // Running totals
  private _size: number;
  private currentMemoryBytes: number;

  // Sweep timer
  private sweepTimer: ReturnType<typeof setInterval> | null;
  private readonly log: Logger;

  constructor(options: MemoryLayerOptions = {}, debug = false) {
    const max = options.maxEntries ?? DEFAULTS.maxEntries;
    this.maxEntries = max;
    this.maxMemoryBytes = (options.maxMemoryMB ?? DEFAULTS.maxMemoryMB) * 1024 * 1024;
    this.defaultTTL = options.defaultTTL ?? DEFAULTS.defaultTTL;
    this.log = new Logger("MemoryLayer", debug);

    // Fast-path: determine once whether we need TTL/size/hotkey bookkeeping.
    // When hasTTL=false, get()/has() skip the Date.now() syscall entirely.
    // When hasMemoryLimit=false, set() skips estimateSize() entirely.
    // When hasHotKeys=false, get() skips accessCounts updates.
    this.hasTTL = this.defaultTTL !== Infinity;
    this.hasMemoryLimit = (options.maxMemoryMB ?? DEFAULTS.maxMemoryMB) < Infinity;
    this.hasHotKeys = options.trackHotKeys !== false;

    // Allocate all storage up front.
    // pre-filling with undefined ensures the JIT engine sees packed (non-sparse)
    // arrays rather than holed arrays, avoiding costly prototype chain checks on reads.
    this.keyMap = new Map();
    this.keys = new Array(max).fill(undefined);
    this.vals = new Array(max).fill(undefined);
    this.next = new Int32Array(max).fill(NONE);
    this.prev = new Int32Array(max).fill(NONE);
    this.visited = new Uint8Array(max);
    this.expires = new Float64Array(max).fill(Infinity);
    this.entrySizes = new Float64Array(max);
    this.originalTTLs = new Float64Array(max);
    this.accessCounts = new Uint32Array(max);
    this.entryTags = new Array(max).fill(null);

    // Initialize free-list (all slots available, LIFO order)
    this.freeStack = new Int32Array(max);
    for (let i = 0; i < max; i++) {
      this.freeStack[i] = max - 1 - i;
    }
    this.freeTop = max - 1;

    this.head = NONE;
    this.tail = NONE;
    this.hand = NONE;
    this._size = 0;
    this.currentMemoryBytes = 0;
    this.sweepTimer = null;

    // Only run background sweep if TTL is enabled
    if (this.hasTTL) {
      this.startSweep(options.sweepIntervalMs ?? DEFAULTS.sweepIntervalMs);
    }
  }

  // ─── Core Operations ───────────────────────────────────────────

  /**
   * Get value from cache.
   *
   * SIEVE hot path: single byte write (visited[slot]=1) instead of
   * the Map delete+re-insert that strict LRU requires. This is the
   * primary performance advantage — reads don't mutate the list.
   */
  get<T = unknown>(key: string): T | undefined {
    const slot = this.keyMap.get(key);
    if (slot === undefined) return undefined;

    if (this.hasTTL && cachedNow >= this.expires[slot]) {
      this.evictSlot(slot);
      return undefined;
    }

    this.visited[slot] = 1;
    if (this.hasHotKeys) {
      this.accessCounts[slot]++;
    }
    return this.vals[slot] as T;
  }

  has(key: string): boolean {
    const slot = this.keyMap.get(key);
    if (slot === undefined) return false;
    if (this.hasTTL && cachedNow >= this.expires[slot]) {
      this.evictSlot(slot);
      return false;
    }
    return true;
  }

  peek<T = unknown>(key: string): T | undefined {
    const slot = this.keyMap.get(key);
    if (slot === undefined) return undefined;
    if (this.hasTTL && cachedNow >= this.expires[slot]) {
      this.evictSlot(slot);
      return undefined;
    }
    return this.vals[slot] as T;
  }

  set<T = unknown>(key: string, value: T, ttl?: number, tags?: string[]): void {
    const effectiveTTL = ttl ?? this.defaultTTL;
    const expiry = this.hasTTL ? (effectiveTTL === Infinity ? Infinity : cachedNow + effectiveTTL) : Infinity;
    const sizeBytes = this.hasMemoryLimit ? estimateSize(value) : 0;

    const existing = this.keyMap.get(key);
    if (existing !== undefined) {
      if (this.hasMemoryLimit) {
        this.currentMemoryBytes -= this.entrySizes[existing];
        this.entrySizes[existing] = sizeBytes;
        this.currentMemoryBytes += sizeBytes;
      }
      this.vals[existing] = value;
      this.expires[existing] = expiry;
      this.originalTTLs[existing] = effectiveTTL;
      this.entryTags[existing] = tags && tags.length > 0 ? new Set(tags) : null;
      this.visited[existing] = 1;
      this.accessCounts[existing] = 0;
      return;
    }

    this.ensureCapacity(sizeBytes);

    const slot = this.freeStack[this.freeTop--];

    this.keys[slot] = key;
    this.vals[slot] = value;
    this.expires[slot] = expiry;
    this.originalTTLs[slot] = effectiveTTL;
    if (this.hasMemoryLimit) {
      this.entrySizes[slot] = sizeBytes;
      this.currentMemoryBytes += sizeBytes;
    }
    this.entryTags[slot] = tags && tags.length > 0 ? new Set(tags) : null;
    this.visited[slot] = 0;
    this.accessCounts[slot] = 0;

    this.pushHead(slot);
    this.keyMap.set(key, slot);
    this._size++;
  }

  /** Delete a key. Returns true if it existed. */
  delete(key: string): boolean {
    const slot = this.keyMap.get(key);
    if (slot === undefined) return false;

    // Inline unlinkSlot
    const p = this.prev[slot];
    const n = this.next[slot];

    if (p !== NONE) {
      this.next[p] = n;
    } else {
      this.tail = n;
    }

    if (n !== NONE) {
      this.prev[n] = p;
    } else {
      this.head = p;
    }

    if (this.hand === slot) {
      this.hand = n !== NONE ? n : this.tail;
    }

    // Inline evictSlot
    this.keyMap.delete(key);

    if (this.hasMemoryLimit) {
      this.currentMemoryBytes -= this.entrySizes[slot];
      if (this.currentMemoryBytes < 0) this.currentMemoryBytes = 0;
    }

    this.keys[slot] = undefined;
    this.vals[slot] = undefined;
    this.entryTags[slot] = null;

    this.freeStack[++this.freeTop] = slot;
    this._size--;

    return true;
  }

  /** Remove all entries and reset all state. */
  clear(): void {
    this.keyMap.clear();
    this.keys.fill(undefined);
    this.vals.fill(undefined);
    this.next.fill(NONE);
    this.prev.fill(NONE);
    this.visited.fill(0);
    this.expires.fill(Infinity);
    this.entrySizes.fill(0);
    this.originalTTLs.fill(0);
    this.accessCounts.fill(0);
    this.entryTags.fill(null);

    // Reset free-list
    for (let i = 0; i < this.maxEntries; i++) {
      this.freeStack[i] = this.maxEntries - 1 - i;
    }
    this.freeTop = this.maxEntries - 1;

    this.head = NONE;
    this.tail = NONE;
    this.hand = NONE;
    this._size = 0;
    this.currentMemoryBytes = 0;
  }

  // ─── Batch Operations ──────────────────────────────────────────

  /** Multi-get: returns a Map of found keys. */
  mget<T = unknown>(keys: string[]): Map<string, T> {
    const results = new Map<string, T>();
    for (let i = 0; i < keys.length; i++) {
      const value = this.get<T>(keys[i]);
      if (value !== undefined) results.set(keys[i], value);
    }
    return results;
  }

  // ─── Tag Invalidation ─────────────────────────────────────────

  /** Invalidate all entries tagged with `tag`. Returns count removed. */
  invalidateTag(tag: string): number {
    let count = 0;
    // Iterate keyMap (safer than iterating the linked list during mutation)
    const slotsToEvict: number[] = [];
    for (const [, slot] of this.keyMap) {
      const t = this.entryTags[slot];
      if (t !== null && t.has(tag)) {
        slotsToEvict.push(slot);
      }
    }
    for (let i = 0; i < slotsToEvict.length; i++) {
      this.evictSlot(slotsToEvict[i]);
      count++;
    }
    return count;
  }

  /** Invalidate entries whose key matches a glob pattern. Returns count removed. */
  invalidatePattern(pattern: string): number {
    const regex = globToRegex(pattern);
    let count = 0;
    const slotsToEvict: number[] = [];
    for (const [key, slot] of this.keyMap) {
      if (regex.test(key)) {
        slotsToEvict.push(slot);
      }
    }
    for (let i = 0; i < slotsToEvict.length; i++) {
      this.evictSlot(slotsToEvict[i]);
      count++;
    }
    return count;
  }

  // ─── Stampede / Refresh-Ahead Helpers ──────────────────────────

  /** Get a stale (expired) value for stampede protection. */
  getStale<T = unknown>(key: string, graceMs: number): T | undefined {
    const slot = this.keyMap.get(key);
    if (slot === undefined) return undefined;
    const exp = this.expires[slot];
    if (exp === Infinity) return this.vals[slot] as T; // No TTL = always fresh
    if (cachedNow > exp + graceMs) return undefined;
    return this.vals[slot] as T;
  }

  /** Check if a key is expired but within its grace period. */
  isStaleButUsable(key: string, graceMs: number): boolean {
    const slot = this.keyMap.get(key);
    if (slot === undefined) return false;
    const exp = this.expires[slot];
    if (exp === Infinity) return false;
    return cachedNow >= exp && cachedNow < exp + graceMs;
  }

  /** Check if a key should be proactively refreshed. */
  needsRefreshAhead(key: string, fraction: number): boolean {
    const slot = this.keyMap.get(key);
    if (slot === undefined) return false;
    const exp = this.expires[slot];
    if (exp === Infinity) return false; // No TTL
    const remaining = exp - cachedNow;
    const threshold = this.originalTTLs[slot] * fraction;
    return remaining > 0 && remaining <= threshold;
  }

  // ─── Accessors ─────────────────────────────────────────────────

  get size(): number { return this._size; }
  get memoryBytes(): number { return this.currentMemoryBytes; }

  /** All keys currently in the store. */
  allKeys(): string[] {
    return Array.from(this.keyMap.keys());
  }

  /** Top-N keys by access count. */
  getHotKeys(topN: number): Array<{ key: string; hits: number }> {
    const entries: Array<{ key: string; hits: number }> = [];
    for (const [key, slot] of this.keyMap) {
      entries.push({ key, hits: this.accessCounts[slot] });
    }
    entries.sort((a, b) => b.hits - a.hits);
    return entries.slice(0, topN);
  }

  /** Halve all access counts to decay historical data. */
  decayAccessCounts(): void {
    for (let i = 0; i < this.maxEntries; i++) {
      this.accessCounts[i] = this.accessCounts[i] >>> 1;
    }
  }

  // ─── Iteration (FIFO order: tail → head = oldest → newest) ────

  /** Iterate keys in insertion order (oldest first). */
  *iterKeys(): Generator<string> {
    let slot = this.tail;
    while (slot !== NONE) {
      const key = this.keys[slot]!;
      yield key;
      slot = this.next[slot];
    }
  }

  /** Iterate values in insertion order. */
  *iterValues(): Generator<unknown> {
    let slot = this.tail;
    while (slot !== NONE) {
      yield this.vals[slot];
      slot = this.next[slot];
    }
  }

  /** Iterate [key, value] pairs in insertion order. */
  *iterEntries(): Generator<[string, unknown]> {
    let slot = this.tail;
    while (slot !== NONE) {
      yield [this.keys[slot]!, this.vals[slot]];
      slot = this.next[slot];
    }
  }

  forEach(fn: (value: unknown, key: string) => void): void {
    let slot = this.tail;
    while (slot !== NONE) {
      fn(this.vals[slot], this.keys[slot]!);
      slot = this.next[slot];
    }
  }

  /** Dump cache contents for serialization. */
  dump(): Array<[string, { value: unknown; ttl: number; size: number }]> {
    const result: Array<[string, { value: unknown; ttl: number; size: number }]> = [];
    for (const [key, slot] of this.keyMap) {
      const exp = this.expires[slot];
      const remainingTTL = exp === Infinity ? Infinity : Math.max(0, exp - cachedNow);
      result.push([key, {
        value: this.vals[slot],
        ttl: remainingTTL,
        size: this.entrySizes[slot],
      }]);
    }
    return result;
  }

  /** Load entries from a previous dump(). */
  load(entries: Array<[string, { value: unknown; ttl: number; size?: number }]>): void {
    for (const [key, entry] of entries) {
      this.set(key, entry.value, entry.ttl === Infinity ? undefined : entry.ttl);
    }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────

  destroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.clear();
  }

  // ─── SIEVE Eviction (Private) ─────────────────────────────────

  /**
   * SIEVE eviction: scan from hand backward through the FIFO list.
   * - If visited[hand] === 1: clear it and advance (second chance).
   * - If visited[hand] === 0: evict this slot.
   *
   * Amortized O(1): each entry is visited at most twice before eviction
   * (once to clear visited, once to evict).
   */
  private sieveEvict(): void {
    if (this._size === 0) return;

    // Initialize hand at tail if not set
    if (this.hand === NONE) {
      this.hand = this.tail;
    }

    // Scan for a victim
    while (this.hand !== NONE) {
      if (this.visited[this.hand] === 1) {
        // Give it a second chance
        this.visited[this.hand] = 0;
        this.hand = this.next[this.hand];
        // Wrap around
        if (this.hand === NONE) {
          this.hand = this.tail;
        }
      } else {
        // Found victim
        const victim = this.hand;
        // Advance hand before evicting (so we don't lose our place)
        this.hand = this.next[this.hand];
        if (this.hand === NONE) {
          this.hand = this.tail === victim ? NONE : this.tail;
        }
        this.evictSlot(victim);
        return;
      }
    }
  }

  private ensureCapacity(newSizeBytes: number): void {
    // Evict by count limit
    if (this._size >= this.maxEntries && this._size > 0) {
      this.sieveEvict();
    }
    // Evict by memory limit
    if (this.hasMemoryLimit) {
      while (this.currentMemoryBytes + newSizeBytes > this.maxMemoryBytes && this._size > 0) {
        this.sieveEvict();
      }
    }
  }

  /** Remove a slot from the cache entirely. */
  private evictSlot(slot: number): void {
    const key = this.keys[slot]!;

    // Inline unlinkSlot
    const p = this.prev[slot];
    const n = this.next[slot];

    if (p !== NONE) {
      this.next[p] = n;
    } else {
      this.tail = n;
    }

    if (n !== NONE) {
      this.prev[n] = p;
    } else {
      this.head = p;
    }

    if (this.hand === slot) {
      this.hand = n !== NONE ? n : this.tail;
    }

    // Remove from key map
    this.keyMap.delete(key);

    // Update memory tracking
    if (this.hasMemoryLimit) {
      this.currentMemoryBytes -= this.entrySizes[slot];
      if (this.currentMemoryBytes < 0) this.currentMemoryBytes = 0;
    }

    // Clear slot data to prevent memory leaks. We DO NOT reset numeric metadata arrays
    // like originalTTLs, entrySizes, visited, accessCounts, or expires because they will
    // be completely overwritten when this slot index is reused from the free list,
    // saving precious CPU cycles on hot-path eviction/deletion.
    this.keys[slot] = undefined;
    this.vals[slot] = undefined;
    if (this.entryTags[slot] !== null) {
      this.entryTags[slot] = null;
    }

    // Return slot to free-list
    this.freeStack[++this.freeTop] = slot;
    this._size--;
  }

  // ─── Doubly-Linked List Operations (via typed arrays) ─────────

  /** Insert slot at head (newest position) of the FIFO queue. */
  private pushHead(slot: number): void {
    this.prev[slot] = this.head;
    this.next[slot] = NONE;

    if (this.head !== NONE) {
      this.next[this.head] = slot;
    }
    this.head = slot;

    if (this.tail === NONE) {
      this.tail = slot;
    }
  }

  // ─── Background Sweep ─────────────────────────────────────────

  private startSweep(intervalMs: number): void {
    this.sweepTimer = setInterval(() => {
      const now = Date.now();
      const slotsToEvict: number[] = [];
      for (const [, slot] of this.keyMap) {
        if (this.expires[slot] !== 0 && now >= this.expires[slot]) {
          slotsToEvict.push(slot);
        }
      }
      for (let i = 0; i < slotsToEvict.length; i++) {
        this.evictSlot(slotsToEvict[i]);
      }
    }, intervalMs);
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }
}

// ─── Utility ───────────────────────────────────────────────────

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}
