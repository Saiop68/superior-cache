/**
 * sieve-cache.ts
 *
 * A standalone, high-performance, typed-array-backed cache implementing the
 * SIEVE eviction algorithm. Designed to be a drop-in replacement for isaacs/lru-cache.
 *
 * Employs two specialized concrete classes selected at construction time:
 * - SieveCacheLite: Optimized for the count-only hot path (no TTL, no size calculation, no callbacks).
 * - SieveCacheFull: Implements full TTL, size-weighted eviction, and lifecycle callbacks.
 */

const NONE = -1;

// Coarsened timer to avoid Date.now() syscalls on the get hot path
let cachedNow = Date.now();
const nowTimer = setInterval(() => {
  cachedNow = Date.now();
}, 4);
if (nowTimer.unref) {
  nowTimer.unref();
}

export interface SieveCacheOptions<K, V> {
  /** Maximum number of entries the cache can hold. (Required) */
  max: number;

  /** Default time-to-live in milliseconds for cache entries. */
  ttl?: number;

  /** Rounding resolution in ms for TTL timestamps. */
  ttlResolution?: number;

  /** Periodically purge expired items in the background. */
  ttlAutopurge?: boolean;

  /** Update the age of an entry when it is retrieved. */
  updateAgeOnGet?: boolean;

  /** Maximum size-weighted capacity for size-based eviction. */
  maxSize?: number;

  /** Function to calculate the size of an entry. */
  sizeCalculation?: (value: V, key: K) => number;

  /** Callback fired before an entry is removed/evicted. */
  dispose?: (value: V, key: K, reason: "evict" | "set" | "delete") => void;

  /** Callback fired after an entry is removed/evicted. */
  disposeAfter?: (value: V, key: K, reason: "evict" | "set" | "delete") => void;

  /** Do not trigger dispose callbacks on overwrite sets. */
  noDisposeOnSet?: boolean;

  /** Allow serving stale (expired) values while fetching fresh. */
  allowStale?: boolean;

  /** Async function to fetch values on cache miss. */
  fetchMethod?: (
    key: K,
    staleValue: V | undefined,
    options: { signal: AbortSignal; options: any; context: any }
  ) => Promise<V> | V;
}

export class SieveCache<K = any, V = any> {
  constructor(options: SieveCacheOptions<K, V>) {
    if (new.target !== SieveCache) {
      return;
    }
    const isLite =
      options.ttl === undefined &&
      options.maxSize === undefined &&
      options.sizeCalculation === undefined &&
      options.dispose === undefined &&
      options.disposeAfter === undefined &&
      options.fetchMethod === undefined;

    if (isLite) {
      return new SieveCacheLite<K, V>(options) as any;
    } else {
      return new SieveCacheFull<K, V>(options) as any;
    }
  }

  get size(): number { return 0; }
  get(key: K, options?: { updateAgeOnGet?: boolean }): V | undefined { return undefined; }
  set(key: K, value: V, options?: { ttl?: number; size?: number }): this { return this; }
  has(key: K): boolean { return false; }
  delete(key: K): boolean { return false; }
  peek(key: K): V | undefined { return undefined; }
  clear(): void {}

  *keys(): Generator<K, void, unknown> {}
  *values(): Generator<V, void, unknown> {}
  *entries(): Generator<[K, V], void, unknown> {}
  *[Symbol.iterator](): Generator<[K, V], void, unknown> {}
  forEach(callback: (value: V, key: K, cache: this) => void, thisArg?: any): void {}

  dump(): Array<[K, { value: V; ttl?: number; size?: number }]> { return []; }
  load(entries: Array<[K, { value: V; ttl?: number; size?: number }]>): void {}

  async fetch(
    key: K,
    options?: {
      ttl?: number;
      size?: number;
      forceRefresh?: boolean;
      allowStale?: boolean;
      signal?: AbortSignal;
      context?: any;
      options?: any;
    }
  ): Promise<V | undefined> {
    return undefined;
  }
}

// ─── LITE MODE IMPLEMENTATION ────────────────────────────────────
class SieveCacheLite<K, V> extends SieveCache<K, V> {
  private readonly maxEntries: number;
  private readonly keyMap: Map<K, number>;

  private readonly keysArray: (K | undefined)[];
  private readonly vals: (V | undefined)[];
  private readonly next: Int32Array;
  private readonly prev: Int32Array;
  private readonly visited: Uint8Array;

  private head: number = NONE;
  private tail: number = NONE;
  private hand: number = NONE;

  private readonly freeStack: Int32Array;
  private freeTop: number;
  private _size: number = 0;

  constructor(options: SieveCacheOptions<K, V>) {
    super(options);
    const max = options.max || 50_000;
    this.maxEntries = max;
    this.keyMap = new Map();

    this.keysArray = new Array(max).fill(undefined);
    this.vals = new Array(max).fill(undefined);
    this.next = new Int32Array(max).fill(NONE);
    this.prev = new Int32Array(max).fill(NONE);
    this.visited = new Uint8Array(max);

    this.freeStack = new Int32Array(max);
    for (let i = 0; i < max; i++) {
      this.freeStack[i] = max - 1 - i;
    }
    this.freeTop = max - 1;
  }

  get size(): number {
    return this._size;
  }

  get(key: K): V | undefined {
    const slot = this.keyMap.get(key);
    if (slot === undefined) return undefined;

    this.visited[slot] = 1;
    return this.vals[slot];
  }

  has(key: K): boolean {
    return this.keyMap.has(key);
  }

  peek(key: K): V | undefined {
    const slot = this.keyMap.get(key);
    return slot === undefined ? undefined : this.vals[slot];
  }

  set(key: K, value: V): this {
    const existing = this.keyMap.get(key);
    if (existing !== undefined) {
      this.vals[existing] = value;
      this.visited[existing] = 1;
      return this;
    }

    if (this._size >= this.maxEntries && this._size > 0) {
      this.sieveEvict();
    }

    const slot = this.freeStack[this.freeTop--];
    this.keysArray[slot] = key;
    this.vals[slot] = value;
    this.visited[slot] = 0;

    this.pushHead(slot);
    this.keyMap.set(key, slot);
    this._size++;
    return this;
  }

  delete(key: K): boolean {
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
    this.keysArray[slot] = undefined;
    this.vals[slot] = undefined;

    this.freeStack[++this.freeTop] = slot;
    this._size--;
    return true;
  }

  clear(): void {
    this.keyMap.clear();
    this.keysArray.fill(undefined);
    this.vals.fill(undefined);
    this.next.fill(NONE);
    this.prev.fill(NONE);
    this.visited.fill(0);

    for (let i = 0; i < this.maxEntries; i++) {
      this.freeStack[i] = this.maxEntries - 1 - i;
    }
    this.freeTop = this.maxEntries - 1;
    this.head = NONE;
    this.tail = NONE;
    this.hand = NONE;
    this._size = 0;
  }

  *keys(): Generator<K, void, unknown> {
    let slot = this.head;
    while (slot !== NONE) {
      yield this.keysArray[slot]!;
      slot = this.prev[slot];
    }
  }

  *values(): Generator<V, void, unknown> {
    let slot = this.head;
    while (slot !== NONE) {
      yield this.vals[slot]!;
      slot = this.prev[slot];
    }
  }

  *entries(): Generator<[K, V], void, unknown> {
    let slot = this.head;
    while (slot !== NONE) {
      yield [this.keysArray[slot]!, this.vals[slot]!];
      slot = this.prev[slot];
    }
  }

  [Symbol.iterator](): Generator<[K, V], void, unknown> {
    return this.entries();
  }

  forEach(callback: (value: V, key: K, cache: this) => void, thisArg?: any): void {
    let slot = this.head;
    const self = thisArg || this;
    while (slot !== NONE) {
      callback.call(self, this.vals[slot]!, this.keysArray[slot]!, this);
      slot = this.prev[slot];
    }
  }

  dump(): Array<[K, { value: V; ttl?: number; size?: number }]> {
    const result: Array<[K, { value: V; ttl?: number; size?: number }]> = [];
    for (const [key, slot] of this.keyMap) {
      result.push([key, { value: this.vals[slot]! }]);
    }
    return result;
  }

  load(entries: Array<[K, { value: V; ttl?: number; size?: number }]>): void {
    this.clear();
    for (const [key, entry] of entries) {
      this.set(key, entry.value);
    }
  }

  async fetch(key: K): Promise<V | undefined> {
    return this.get(key);
  }

  private sieveEvict(): void {
    if (this.hand === NONE) {
      this.hand = this.tail;
    }
    while (this.hand !== NONE) {
      if (this.visited[this.hand] === 1) {
        this.visited[this.hand] = 0;
        this.hand = this.next[this.hand];
        if (this.hand === NONE) {
          this.hand = this.tail;
        }
      } else {
        const victim = this.hand;
        this.hand = this.next[this.hand];
        if (this.hand === NONE) {
          this.hand = this.tail === victim ? NONE : this.tail;
        }
        this.evictSlot(victim);
        return;
      }
    }
  }

  private evictSlot(slot: number): void {
    const key = this.keysArray[slot]!;
    
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

    this.keyMap.delete(key);

    this.keysArray[slot] = undefined;
    this.vals[slot] = undefined;
    this.freeStack[++this.freeTop] = slot;
    this._size--;
  }

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
}

// ─── FULL MODE IMPLEMENTATION ────────────────────────────────────
class SieveCacheFull<K, V> extends SieveCache<K, V> {
  private readonly maxEntries: number;
  private readonly keyMap: Map<K, number>;

  private readonly keysArray: (K | undefined)[];
  private readonly vals: (V | undefined)[];
  private readonly next: Int32Array;
  private readonly prev: Int32Array;
  private readonly visited: Uint8Array;
  private readonly expires: Float64Array;
  private readonly sizes: Float64Array;

  private head: number = NONE;
  private tail: number = NONE;
  private hand: number = NONE;

  private readonly freeStack: Int32Array;
  private freeTop: number;
  private _size: number = 0;

  // Option overrides
  private readonly defaultTTL: number;
  private readonly ttlResolution: number;
  private readonly updateAgeOnGet: boolean;
  private readonly maxSize: number;
  private readonly sizeCalculation?: (value: V, key: K) => number;
  private readonly dispose?: (value: V, key: K, reason: "evict" | "set" | "delete") => void;
  private readonly disposeAfter?: (value: V, key: K, reason: "evict" | "set" | "delete") => void;
  private readonly noDisposeOnSet: boolean;
  private readonly allowStale: boolean;
  private readonly fetchMethod?: (
    key: K,
    staleValue: V | undefined,
    options: { signal: AbortSignal; options: any; context: any }
  ) => Promise<V> | V;

  private readonly hasTTL: boolean;
  private readonly hasSizeLimit: boolean;
  private readonly hasDispose: boolean;
  private readonly hasDisposeAfter: boolean;
  private currentSize: number = 0;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly inFlight: Map<K, Promise<V>> = new Map();

  constructor(options: SieveCacheOptions<K, V>) {
    super(options);
    const max = options.max || 50_000;
    this.maxEntries = max;
    this.keyMap = new Map();

    this.keysArray = new Array(max).fill(undefined);
    this.vals = new Array(max).fill(undefined);
    this.next = new Int32Array(max).fill(NONE);
    this.prev = new Int32Array(max).fill(NONE);
    this.visited = new Uint8Array(max);
    this.expires = new Float64Array(max).fill(Infinity);
    this.sizes = new Float64Array(max);

    this.freeStack = new Int32Array(max);
    for (let i = 0; i < max; i++) {
      this.freeStack[i] = max - 1 - i;
    }
    this.freeTop = max - 1;

    // Config options
    this.defaultTTL = options.ttl ?? Infinity;
    this.ttlResolution = options.ttlResolution ?? 0;
    this.updateAgeOnGet = options.updateAgeOnGet ?? false;
    this.maxSize = options.maxSize ?? Infinity;
    this.sizeCalculation = options.sizeCalculation;
    this.dispose = options.dispose;
    this.disposeAfter = options.disposeAfter;
    this.noDisposeOnSet = options.noDisposeOnSet ?? false;
    this.allowStale = options.allowStale ?? false;
    this.fetchMethod = options.fetchMethod;

    this.hasTTL = this.defaultTTL !== Infinity;
    this.hasSizeLimit = this.maxSize !== Infinity;
    this.hasDispose = options.dispose !== undefined;
    this.hasDisposeAfter = options.disposeAfter !== undefined;

    if (this.hasTTL && options.ttlAutopurge) {
      this.sweepTimer = setInterval(() => {
        const now = Date.now();
        const slotsToEvict: number[] = [];
        for (const [key, slot] of this.keyMap) {
          if (this.expires[slot] !== Infinity && now >= this.expires[slot]) {
            slotsToEvict.push(slot);
          }
        }
        for (let i = 0; i < slotsToEvict.length; i++) {
          this.evictSlot(slotsToEvict[i], "evict");
        }
      }, 10_000);
      if (this.sweepTimer.unref) {
        this.sweepTimer.unref();
      }
    }
  }

  get size(): number {
    return this._size;
  }

  get(key: K, options?: { updateAgeOnGet?: boolean }): V | undefined {
    const slot = this.keyMap.get(key);
    if (slot === undefined) return undefined;

    if (this.hasTTL && cachedNow >= this.expires[slot]) {
      this.evictSlot(slot, "evict");
      return undefined;
    }

    this.visited[slot] = 1;

    const updateAge = options === undefined ? this.updateAgeOnGet : (options.updateAgeOnGet ?? this.updateAgeOnGet);
    if (updateAge && this.hasTTL) {
      this.expires[slot] = cachedNow + this.defaultTTL;
    }

    return this.vals[slot];
  }

  has(key: K): boolean {
    const slot = this.keyMap.get(key);
    if (slot === undefined) return false;
    if (this.hasTTL && cachedNow >= this.expires[slot]) {
      this.evictSlot(slot, "evict");
      return false;
    }
    return true;
  }

  peek(key: K): V | undefined {
    const slot = this.keyMap.get(key);
    if (slot === undefined) return undefined;
    if (this.hasTTL && cachedNow >= this.expires[slot]) {
      this.evictSlot(slot, "evict");
      return undefined;
    }
    return this.vals[slot];
  }

  set(key: K, value: V, options?: { ttl?: number; size?: number }): this {
    const ttl = options === undefined ? this.defaultTTL : (options.ttl ?? this.defaultTTL);
    const expiry = ttl === Infinity ? Infinity : cachedNow + ttl;

    let entrySize = 0;
    if (this.hasSizeLimit) {
      entrySize = options === undefined ? 0 : (options.size ?? 0);
      if (entrySize === 0 && this.sizeCalculation) {
        entrySize = this.sizeCalculation(value, key);
      }
    }

    const existing = this.keyMap.get(key);
    if (existing !== undefined) {
      const oldValue = this.vals[existing]!;
      if (!this.noDisposeOnSet && this.hasDispose && this.dispose) {
        this.dispose(oldValue, key, "set");
      }

      if (this.hasSizeLimit) {
        this.currentSize -= this.sizes[existing];
        this.sizes[existing] = entrySize;
        this.currentSize += entrySize;
      }
      this.vals[existing] = value;
      this.expires[existing] = expiry;
      this.visited[existing] = 1;

      if (!this.noDisposeOnSet && this.hasDisposeAfter && this.disposeAfter) {
        this.disposeAfter(oldValue, key, "set");
      }
      return this;
    }

    this.ensureCapacity(entrySize);

    const slot = this.freeStack[this.freeTop--];
    this.keysArray[slot] = key;
    this.vals[slot] = value;
    this.expires[slot] = expiry;
    if (this.hasSizeLimit) {
      this.sizes[slot] = entrySize;
      this.currentSize += entrySize;
    }
    this.visited[slot] = 0;

    this.pushHead(slot);
    this.keyMap.set(key, slot);
    this._size++;
    return this;
  }

  delete(key: K): boolean {
    const slot = this.keyMap.get(key);
    if (slot === undefined) return false;

    const hasCallbacks = this.hasDispose || this.hasDisposeAfter;
    const val = hasCallbacks ? this.vals[slot]! : undefined;

    if (this.hasDispose && this.dispose && val !== undefined) {
      this.dispose(val, key, "delete");
    }

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

    if (this.hasSizeLimit) {
      this.currentSize -= this.sizes[slot];
    }

    this.keysArray[slot] = undefined;
    this.vals[slot] = undefined;

    this.freeStack[++this.freeTop] = slot;
    this._size--;

    if (this.hasDisposeAfter && this.disposeAfter && val !== undefined) {
      this.disposeAfter(val, key, "delete");
    }
    return true;
  }

  clear(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.keyMap.clear();
    this.keysArray.fill(undefined);
    this.vals.fill(undefined);
    this.next.fill(NONE);
    this.prev.fill(NONE);
    this.visited.fill(0);
    this.expires.fill(Infinity);
    this.sizes.fill(0);

    for (let i = 0; i < this.maxEntries; i++) {
      this.freeStack[i] = this.maxEntries - 1 - i;
    }
    this.freeTop = this.maxEntries - 1;
    this.head = NONE;
    this.tail = NONE;
    this.hand = NONE;
    this._size = 0;
    this.currentSize = 0;
    this.inFlight.clear();
  }

  *keys(): Generator<K, void, unknown> {
    let slot = this.head;
    while (slot !== NONE) {
      if (this.hasTTL && cachedNow >= this.expires[slot]) {
        slot = this.prev[slot];
        continue;
      }
      yield this.keysArray[slot]!;
      slot = this.prev[slot];
    }
  }

  *values(): Generator<V, void, unknown> {
    let slot = this.head;
    while (slot !== NONE) {
      if (this.hasTTL && cachedNow >= this.expires[slot]) {
        slot = this.prev[slot];
        continue;
      }
      yield this.vals[slot]!;
      slot = this.prev[slot];
    }
  }

  *entries(): Generator<[K, V], void, unknown> {
    let slot = this.head;
    while (slot !== NONE) {
      if (this.hasTTL && cachedNow >= this.expires[slot]) {
        slot = this.prev[slot];
        continue;
      }
      yield [this.keysArray[slot]!, this.vals[slot]!];
      slot = this.prev[slot];
    }
  }

  [Symbol.iterator](): Generator<[K, V], void, unknown> {
    return this.entries();
  }

  forEach(callback: (value: V, key: K, cache: this) => void, thisArg?: any): void {
    let slot = this.head;
    const self = thisArg || this;
    while (slot !== NONE) {
      if (this.hasTTL && cachedNow >= this.expires[slot]) {
        slot = this.prev[slot];
        continue;
      }
      callback.call(self, this.vals[slot]!, this.keysArray[slot]!, this);
      slot = this.prev[slot];
    }
  }

  dump(): Array<[K, { value: V; ttl?: number; size?: number }]> {
    const result: Array<[K, { value: V; ttl?: number; size?: number }]> = [];
    const now = Date.now();
    for (const [key, slot] of this.keyMap) {
      if (this.hasTTL && now >= this.expires[slot]) {
        continue;
      }
      const exp = this.expires[slot];
      const remainingTTL = exp === Infinity ? undefined : Math.max(0, exp - now);
      result.push([
        key,
        {
          value: this.vals[slot]!,
          ttl: remainingTTL,
          size: this.sizes[slot],
        },
      ]);
    }
    return result;
  }

  load(entries: Array<[K, { value: V; ttl?: number; size?: number }]>): void {
    this.clear();
    for (const [key, entry] of entries) {
      this.set(key, entry.value, { ttl: entry.ttl, size: entry.size });
    }
  }

  async fetch(
    key: K,
    options?: {
      ttl?: number;
      size?: number;
      forceRefresh?: boolean;
      allowStale?: boolean;
      signal?: AbortSignal;
      context?: any;
      options?: any;
    }
  ): Promise<V | undefined> {
    const forceRefresh = options?.forceRefresh ?? false;

    if (!forceRefresh) {
      const cached = this.get(key);
      if (cached !== undefined) {
        return cached;
      }
    }

    let promise = this.inFlight.get(key);
    if (!promise) {
      const fetchMethod = this.fetchMethod;
      if (!fetchMethod) {
        return undefined;
      }

      const allowStale = options?.allowStale ?? this.allowStale;
      const staleVal = allowStale ? this.peek(key) : undefined;

      const controller = new AbortController();
      if (options?.signal) {
        const sig = options.signal;
        sig.addEventListener("abort", () => controller.abort());
      }

      promise = (async () => {
        try {
          const result = await fetchMethod(key, staleVal, {
            signal: controller.signal,
            options: options?.options,
            context: options?.context,
          });
          this.set(key, result, { ttl: options?.ttl, size: options?.size });
          return result;
        } catch (err) {
          if (controller.signal.aborted && staleVal !== undefined) {
            return staleVal;
          }
          if (staleVal !== undefined) {
            return staleVal;
          }
          throw err;
        } finally {
          this.inFlight.delete(key);
        }
      })();

      this.inFlight.set(key, promise);
    }

    return promise;
  }

  private ensureCapacity(newSizeBytes: number): void {
    if (this._size >= this.maxEntries && this._size > 0) {
      this.sieveEvict();
    }
    if (this.hasSizeLimit) {
      while (this.currentSize + newSizeBytes > this.maxSize && this._size > 0) {
        this.sieveEvict();
      }
    }
  }

  private sieveEvict(): void {
    if (this.hand === NONE) {
      this.hand = this.tail;
    }
    while (this.hand !== NONE) {
      if (this.visited[this.hand] === 1) {
        this.visited[this.hand] = 0;
        this.hand = this.next[this.hand];
        if (this.hand === NONE) {
          this.hand = this.tail;
        }
      } else {
        const victim = this.hand;
        this.hand = this.next[this.hand];
        if (this.hand === NONE) {
          this.hand = this.tail === victim ? NONE : this.tail;
        }
        this.evictSlot(victim, "evict");
        return;
      }
    }
  }

  private evictSlot(slot: number, reason: "evict" | "delete"): void {
    const key = this.keysArray[slot]!;
    const hasCallbacks = this.hasDispose || this.hasDisposeAfter;
    const val = hasCallbacks ? this.vals[slot]! : undefined;

    if (this.hasDispose && this.dispose && val !== undefined) {
      this.dispose(val, key, reason);
    }

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

    this.keyMap.delete(key);

    if (this.hasSizeLimit) {
      this.currentSize -= this.sizes[slot];
    }

    this.keysArray[slot] = undefined;
    this.vals[slot] = undefined;

    this.freeStack[++this.freeTop] = slot;
    this._size--;

    if (this.hasDisposeAfter && this.disposeAfter && val !== undefined) {
      this.disposeAfter(val, key, reason);
    }
  }

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
}
