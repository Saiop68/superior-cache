/**
 * memory-layer.ts
 * 
 * The L1 (in-process) cache layer — a fast LRU map with TTL,
 * tag invalidation, pattern matching, and stampede helpers.
 */

import type { MemoryLayerOptions } from "../types/cache-options";
import type { MemoryEntry } from "./memory-entry";
import { estimateSize } from "../utils/size-estimator";
import { isExpired } from "../utils/time";
import { globToRegex } from "../utils/pattern-matcher";
import { Logger } from "../utils/logger";

const DEFAULTS = {
  maxEntries: 50_000,
  maxMemoryMB: 512,
  defaultTTL: 60_000,
  sweepIntervalMs: 10_000,
} as const;

export class MemoryLayer {
  private readonly store: Map<string, MemoryEntry>;
  private readonly maxEntries: number;
  private readonly maxMemoryBytes: number;
  private readonly defaultTTL: number;
  private currentMemoryBytes: number;
  private sweepTimer: ReturnType<typeof setInterval> | null;
  private readonly log: Logger;

  constructor(options: MemoryLayerOptions = {}, debug = false) {
    this.store = new Map();
    this.maxEntries = options.maxEntries ?? DEFAULTS.maxEntries;
    this.maxMemoryBytes = (options.maxMemoryMB ?? DEFAULTS.maxMemoryMB) * 1024 * 1024;
    this.defaultTTL = options.defaultTTL ?? DEFAULTS.defaultTTL;
    this.currentMemoryBytes = 0;
    this.sweepTimer = null;
    this.log = new Logger("MemoryLayer", debug);
    this.startSweep(options.sweepIntervalMs ?? DEFAULTS.sweepIntervalMs);
  }


  /** Get value from memory, promoting to MRU position on hit. */
  get<T = unknown>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (isExpired(entry.expiresAt)) {
      this.evictEntry(key, entry);
      return undefined;
    }
    // Re-insert at end for LRU ordering
    this.store.delete(key);
    this.store.set(key, entry);
    entry.lastAccessedAt = Date.now();
    entry.accessCount++;
    return entry.value as T;
  }

  /** Check key existence without promoting LRU order. */
  has(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (isExpired(entry.expiresAt)) {
      this.evictEntry(key, entry);
      return false;
    }
    return true;
  }

  /** Store a value, evicting LRU entries if over capacity. */
  set<T = unknown>(key: string, value: T, ttl?: number, tags?: string[]): void {
    const existing = this.store.get(key);
    if (existing) {
      this.currentMemoryBytes -= existing.sizeBytes;
      this.store.delete(key);
    }
    const effectiveTTL = ttl ?? this.defaultTTL;
    const sizeBytes = estimateSize(value);
    const entry: MemoryEntry<T> = {
      value,
      expiresAt: effectiveTTL === Infinity ? Infinity : Date.now() + effectiveTTL,
      originalTTL: effectiveTTL,
      sizeBytes,
      tags: new Set(tags ?? []),
      lastAccessedAt: Date.now(),
      accessCount: 0,
    };
    this.ensureCapacity(sizeBytes);
    this.store.set(key, entry);
    this.currentMemoryBytes += sizeBytes;
  }

  /** Delete a key. Returns true if it existed. */
  delete(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    this.evictEntry(key, entry);
    return true;
  }

  /** Remove all entries and reset counters. */
  clear(): void {
    this.store.clear();
    this.currentMemoryBytes = 0;
  }


  /** Multi-get: returns a Map of found keys. */
  mget<T = unknown>(keys: string[]): Map<string, T> {
    const results = new Map<string, T>();
    for (const key of keys) {
      const value = this.get<T>(key);
      if (value !== undefined) results.set(key, value);
    }
    return results;
  }

  /** Invalidate all entries tagged with `tag`. Returns count removed. */
  invalidateTag(tag: string): number {
    let count = 0;
    for (const [key, entry] of this.store) {
      if (entry.tags.has(tag)) {
        this.evictEntry(key, entry);
        count++;
      }
    }
    return count;
  }

  /** Invalidate entries matching a glob pattern. Returns count removed. */
  invalidatePattern(pattern: string): number {
    const regex = globToRegex(pattern);
    let count = 0;
    for (const [key, entry] of this.store) {
      if (regex.test(key)) {
        this.evictEntry(key, entry);
        count++;
      }
    }
    return count;
  }

  /** All keys currently in the store. */
  keys(): string[] {
    return Array.from(this.store.keys());
  }


  /** Get a stale (expired) value for stampede protection. */
  getStale<T = unknown>(key: string, graceMs: number): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt + graceMs) return undefined;
    return entry.value as T;
  }

  /** Check if a key is expired but within its grace period. */
  isStaleButUsable(key: string, graceMs: number): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    const now = Date.now();
    return now >= entry.expiresAt && now < entry.expiresAt + graceMs;
  }

  /** Check if a key should be proactively refreshed. */
  needsRefreshAhead(key: string, fraction: number): boolean {
    const entry = this.store.get(key);
    if (!entry || entry.expiresAt === Infinity) return false;
    const remaining = entry.expiresAt - Date.now();
    const threshold = entry.originalTTL * fraction;
    return remaining > 0 && remaining <= threshold;
  }


  get size(): number { return this.store.size; }
  get memoryBytes(): number { return this.currentMemoryBytes; }

  /** Top-N keys by access count. */
  getHotKeys(topN: number): Array<{ key: string; hits: number }> {
    const entries: Array<{ key: string; hits: number }> = [];
    for (const [key, entry] of this.store) {
      entries.push({ key, hits: entry.accessCount });
    }
    entries.sort((a, b) => b.hits - a.hits);
    return entries.slice(0, topN);
  }

  /** Halve all access counts to decay historical data. */
  decayAccessCounts(): void {
    for (const entry of this.store.values()) {
      entry.accessCount = Math.floor(entry.accessCount / 2);
    }
  }


  destroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.clear();
  }


  private startSweep(intervalMs: number): void {
    this.sweepTimer = setInterval(() => {
      for (const [key, entry] of this.store) {
        if (isExpired(entry.expiresAt)) this.evictEntry(key, entry);
      }
    }, intervalMs);
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  private ensureCapacity(newSizeBytes: number): void {
    while (this.store.size >= this.maxEntries) this.evictLRU();
    while (this.currentMemoryBytes + newSizeBytes > this.maxMemoryBytes && this.store.size > 0) {
      this.evictLRU();
    }
  }

  private evictLRU(): void {
    const firstKey = this.store.keys().next().value;
    if (firstKey === undefined) return;
    const entry = this.store.get(firstKey);
    if (entry) this.evictEntry(firstKey, entry);
  }

  private evictEntry(key: string, entry: MemoryEntry): void {
    this.store.delete(key);
    this.currentMemoryBytes -= entry.sizeBytes;
    if (this.currentMemoryBytes < 0) this.currentMemoryBytes = 0;
  }
}
