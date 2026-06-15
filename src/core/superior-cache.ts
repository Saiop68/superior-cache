/**
 * superior-cache.ts
 * 
 * The main orchestrator class for SuperiorCache.
 * 
 * This is the primary public API.  It coordinates the memory layer (L1),
 * Redis layer (L2), request deduplication, stampede protection, background
 * refresh, tag/pattern/dependency invalidation, distributed locking,
 * predictive preloading, hot-key detection, metrics, and plugins.
 * 
 * Usage:
 * ```ts
 * const cache = new SuperiorCache({ redis: { url: "redis://localhost" } });
 * await cache.connect();
 * 
 * const user = await cache.fetch("user:123", () => db.users.findById(123));
 * ```
 */

import type {
  SuperiorCacheOptions,
  SetOptions,
  FetchOptions,
  BatchSetEntry,
  StampedeOptions,
} from "../types/cache-options";
import type { CacheEventMap, CacheEventName } from "../types/events";
import type { CachePlugin } from "../types/plugin";
import type { CacheStats } from "../types/stats";

import { MemoryLayer } from "../layers/memory-layer";
import { RedisLayer } from "../layers/redis-layer";
import { CacheEventBus } from "./event-bus";
import { Deduplicator } from "./deduplicator";
import { DependencyTracker } from "./dependency-tracker";
import { HotKeyDetector } from "./hot-key-detector";
import { LockManager, LockHandle } from "./lock-manager";
import { PredictivePreloader } from "./predictive-preloader";
import { MetricsCollector } from "./metrics-collector";
import { CacheNamespace } from "./namespace";
import { ClusterManager } from "./cluster-manager";
import { resolveSerializer } from "../serializers/serializer-factory";
import { Compressor } from "../utils/compression";
import { Logger } from "../utils/logger";
import { measureAsync } from "../utils/time";



const DEFAULT_STAMPEDE: Required<StampedeOptions> = {
  enabled: true,
  graceMs: 30_000,
  refreshAheadFraction: 0.2,
};



export class SuperiorCache {
  private readonly memory: MemoryLayer;
  private readonly redis: RedisLayer | null;
  private readonly events: CacheEventBus;
  private readonly deduplicator: Deduplicator;
  private readonly dependencies: DependencyTracker;
  private readonly hotKeys: HotKeyDetector;
  private readonly lockManager: LockManager;
  private readonly preloader: PredictivePreloader;
  private readonly metrics: MetricsCollector;
  private readonly compressor: Compressor;
  private readonly clusterManager: ClusterManager;
  private readonly log: Logger;

  private readonly options: SuperiorCacheOptions;
  private readonly stampede: Required<StampedeOptions>;
  private readonly defaultTTL: number;

  private readonly plugins: CachePlugin[] = [];

  private connected: boolean = false;
  private readonly loaders: Map<string, () => Promise<unknown>> = new Map();

  private readonly refreshInProgress: Set<string> = new Set();

  constructor(options: SuperiorCacheOptions = {}) {
    this.options = options;
    const debug = options.debug ?? false;

    this.log = new Logger("SuperiorCache", debug);
    this.defaultTTL = options.defaultTTL ?? 60_000;

    // Stampede settings
    this.stampede = {
      enabled: options.stampede?.enabled ?? DEFAULT_STAMPEDE.enabled,
      graceMs: options.stampede?.graceMs ?? DEFAULT_STAMPEDE.graceMs,
      refreshAheadFraction:
        options.stampede?.refreshAheadFraction ?? DEFAULT_STAMPEDE.refreshAheadFraction,
    };

    // Memory layer (L1)
    this.memory = new MemoryLayer({
      ...options.memory,
      trackHotKeys: options.hotKeys?.enabled !== false,
    }, debug);

    // Redis layer (L2) – null if explicitly disabled
    this.redis = options.redis === false
      ? null
      : new RedisLayer(options.redis ?? {}, debug);

    // Sub-systems
    this.events = new CacheEventBus();
    this.deduplicator = new Deduplicator(debug);
    this.dependencies = new DependencyTracker(debug);
    this.hotKeys = new HotKeyDetector(options.hotKeys, debug);
    this.lockManager = new LockManager(this.redis, debug);
    this.preloader = new PredictivePreloader(debug);
    this.metrics = new MetricsCollector(debug);
    this.compressor = new Compressor({
      enabled: options.compression?.enabled,
      thresholdBytes: options.compression?.thresholdBytes,
      debug,
    });
    this.clusterManager = new ClusterManager(options.cluster, debug);
  }

  

  /**
   * Connect to Redis and initialise all sub-systems.
   * Must be called before using the cache.
   * If Redis is disabled, this is a no-op but still required.
   */
  async connect(): Promise<void> {
    if (this.redis) {
      const serializer = resolveSerializer(this.options.serializer);
      await this.redis.connect(serializer, this.compressor);

      // Set up distributed invalidation listener (Redis Pub/Sub)
      this.redis.onInvalidation((message) => {
        this.handleRemoteInvalidation(message);
      });
    }

    // Set up cluster IPC invalidation listener
    if (this.clusterManager.isActive) {
      this.clusterManager.onInvalidation((payload) => {
        this.handleClusterInvalidation(payload);
      });
    }

    this.connected = true;
    this.log.info("SuperiorCache connected and ready");
  }

  /**
   * Gracefully shut down the cache.
   * Releases all locks, disconnects from Redis, stops timers,
   * and destroys all plugins.
   */
  async destroy(): Promise<void> {
    this.log.info("Shutting down SuperiorCache...");

    // Destroy plugins
    for (const plugin of this.plugins) {
      if (plugin.destroy) {
        await plugin.destroy();
      }
    }

    // Destroy sub-systems
    await this.lockManager.destroy();
    this.preloader.destroy();
    this.hotKeys.destroy();
    this.clusterManager.destroy();
    this.memory.destroy();

    if (this.redis) {
      await this.redis.destroy();
    }

    this.events.removeAllListeners();
    this.connected = false;

    this.log.info("SuperiorCache shut down complete");
  }

  

  /**
   * Get a value from the cache (memory → Redis → null).
   * 
   * Checks L1 (memory) first for maximum speed, then falls back
   * to L2 (Redis).  On an L2 hit, the value is promoted to L1.
   * 
   * @param key - The cache key.
   * @returns The cached value, or `null` if not found.
   */
  async get<T = unknown>(key: string): Promise<T | null> {
    // Track access for hot-key detection and preloading
    this.hotKeys.recordAccess(key);
    this.preloader.recordAccess(key);

    // L1: Check memory
    const memoryValue = this.memory.get<T>(key);
    if (memoryValue !== undefined) {
      this.metrics.recordHit("l1");
      this.events.emit("hit", { key, layer: "l1", latencyMs: 0 });
      this.triggerPreloads(key);
      return memoryValue;
    }

    // L2: Check Redis
    if (this.redis?.isConnected) {
      const [redisValue, latency] = await measureAsync(() =>
        this.redis!.get<T>(key)
      );

      if (redisValue !== null) {
        // Promote to L1
        this.memory.set(key, redisValue, this.defaultTTL);
        this.metrics.recordHit("l2");
        this.events.emit("hit", { key, layer: "l2", latencyMs: latency });
        this.triggerPreloads(key);
        return redisValue;
      }
    }

    // Miss
    this.metrics.recordMiss();
    this.events.emit("miss", { key });
    return null;
  }

  /**
   * Set a value in the cache (both memory and Redis).
   * 
   * @param key     - The cache key.
   * @param value   - The value to cache.
   * @param options - Optional settings (TTL, tags, localOnly, etc.).
   */
  async set<T = unknown>(
    key: string,
    value: T,
    options?: SetOptions
  ): Promise<void> {
    const ttl = options?.ttl ?? this.defaultTTL;
    const tags = options?.tags ?? [];

    // L1: Always write to memory
    this.memory.set(key, value, ttl, tags);

    // L2: Write to Redis unless localOnly
    if (!options?.localOnly && this.redis?.isConnected) {
      await this.redis.set(key, value, ttl);

      // Store tag associations in Redis
      if (tags.length > 0) {
        await this.redis.addTags(key, tags);
      }
    }

    this.events.emit("set", { key, ttl, tags });
  }

  /**
   * Delete a key from the cache (memory + Redis).
   * Also handles cascade deletion of dependent keys.
   * 
   * @param key - The cache key to delete.
   * @returns `true` if the key existed.
   */
  async delete(key: string): Promise<boolean> {
    // Handle dependency cascading first
    const dependents = this.dependencies.removeDependencies(key);

    for (const depKey of dependents) {
      await this.deleteInternal(depKey, true);
    }

    return this.deleteInternal(key, false);
  }

  

  /**
   * Smart fetch: get from cache or execute loader on miss.
   * 
   * This is the primary method for most use cases.  It:
   * 1. Checks L1 (memory)
   * 2. Checks L2 (Redis) 
   * 3. On miss: executes the loader (with deduplication)
   * 4. Caches the result in both layers
   * 5. Optionally triggers refresh-ahead
   * 
   * @param key     - The cache key.
   * @param loader  - Async function that fetches the data.
   * @param options - Optional fetch settings.
   * @returns The cached or freshly loaded value.
   */
  async fetch<T = unknown>(
    key: string,
    loader: () => Promise<T>,
    options?: FetchOptions
  ): Promise<T> {
    // Store the loader for preloading and refresh-ahead
    this.loaders.set(key, loader as () => Promise<unknown>);

    // Track access
    this.hotKeys.recordAccess(key);
    this.preloader.recordAccess(key);

    // Force refresh bypasses all caches
    if (options?.forceRefresh) {
      return this.executeAndCache(key, loader, options);
    }

    // L1: Check memory
    const memoryValue = this.memory.get<T>(key);
    if (memoryValue !== undefined) {
      this.metrics.recordHit("l1");
      this.events.emit("hit", { key, layer: "l1", latencyMs: 0 });

      // Check if refresh-ahead is needed
      if (options?.refreshAhead) {
        this.maybeRefreshAhead(key, loader, options);
      }

      this.triggerPreloads(key);
      return memoryValue;
    }

    // Stampede protection: serve stale value while refreshing
    if (this.stampede.enabled) {
      const stale = this.memory.getStale<T>(key, this.stampede.graceMs);
      if (stale !== undefined) {
        this.log.debug(`Serving stale value for "${key}" (stampede protection)`);
        // Trigger background refresh
        this.backgroundRefresh(key, loader, options);
        return stale;
      }
    }

    // L2: Check Redis
    if (this.redis?.isConnected) {
      const [redisValue, latency] = await measureAsync(() =>
        this.redis!.get<T>(key)
      );

      if (redisValue !== null) {
        // Promote to L1
        const ttl = options?.ttl ?? this.defaultTTL;
        this.memory.set(key, redisValue, ttl, options?.tags);
        this.metrics.recordHit("l2");
        this.events.emit("hit", { key, layer: "l2", latencyMs: latency });
        this.triggerPreloads(key);
        return redisValue;
      }
    }

    // Miss: execute loader (with deduplication)
    this.metrics.recordMiss();
    this.events.emit("miss", { key });

    return this.executeAndCache(key, loader, options);
  }

  

  /**
   * Retrieve multiple values from the cache.
   * 
   * Checks L1 first, then L2 for any misses.
   * 
   * @param keys - Array of cache keys.
   * @returns Map of key → value (misses are omitted).
   */
  async mget<T = unknown>(keys: string[]): Promise<Map<string, T>> {
    const results = new Map<string, T>();
    const l2Keys: string[] = [];

    // Check L1 first
    for (const key of keys) {
      const memVal = this.memory.get<T>(key);
      if (memVal !== undefined) {
        results.set(key, memVal);
        this.metrics.recordHit("l1");
      } else {
        l2Keys.push(key);
      }
    }

    // Check L2 for misses
    if (l2Keys.length > 0 && this.redis?.isConnected) {
      const redisResults = await this.redis.mget<T>(l2Keys);
      for (const [key, value] of redisResults) {
        results.set(key, value);
        this.memory.set(key, value, this.defaultTTL);
        this.metrics.recordHit("l2");
      }
    }

    // Record misses
    for (const key of keys) {
      if (!results.has(key)) {
        this.metrics.recordMiss();
      }
    }

    return results;
  }

  /**
   * Set multiple values in the cache.
   * 
   * @param entries - Array of { key, value, options } entries.
   */
  async mset<T = unknown>(entries: BatchSetEntry<T>[]): Promise<void> {
    for (const entry of entries) {
      await this.set(entry.key, entry.value, entry.options);
    }
  }

  /**
   * Delete multiple keys from the cache.
   * 
   * @param keys - Array of cache keys to delete.
   * @returns Number of keys deleted.
   */
  async mdelete(keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      const deleted = await this.delete(key);
      if (deleted) count++;
    }
    return count;
  }

  

  /**
   * Invalidate all cache entries tagged with a specific tag.
   * 
   * Removes matching entries from both L1 and L2, and broadcasts
   * the invalidation to other instances via Pub/Sub.
   * 
   * @param tag - The tag to invalidate.
   */
  async invalidateTag(tag: string): Promise<void> {
    // L1: Remove from memory
    const l1Count = this.memory.invalidateTag(tag);

    // L2: Get tagged keys from Redis and delete them
    if (this.redis?.isConnected) {
      const keys = await this.redis.getTagMembers(tag);

      if (keys.length > 0) {
        await this.redis.mdelete(keys);
      }

      await this.redis.deleteTag(tag);

      // Broadcast to other instances
      await this.redis.publishInvalidation(
        JSON.stringify({ type: "tag", tag })
      );
    }

    this.events.emit("tagInvalidation", {
      tag,
      keysAffected: l1Count,
    });

    // Broadcast to cluster workers via IPC
    this.clusterManager.broadcastTagInvalidation(tag);
  }

  /**
   * Invalidate all cache entries whose keys match a glob pattern.
   * 
   * @param pattern - A glob-style pattern (e.g. "user:*").
   */
  async invalidatePattern(pattern: string): Promise<void> {
    // L1: Remove matching entries from memory
    this.memory.invalidatePattern(pattern);

    // L2: Scan Redis for matching keys and delete them
    if (this.redis?.isConnected) {
      const keys = await this.redis.scanPattern(pattern);

      if (keys.length > 0) {
        await this.redis.mdelete(keys);
      }

      await this.redis.publishInvalidation(
        JSON.stringify({ type: "pattern", pattern })
      );
    }

    // Broadcast to cluster workers via IPC
    this.clusterManager.broadcastPatternInvalidation(pattern);
  }

  

  /**
   * Register a dependency: when the parent key is deleted,
   * all child keys are automatically cascade-deleted.
   * 
   * @param parentKey - The parent cache key.
   * @param childKeys - Dependent child keys.
   */
  depends(parentKey: string, childKeys: string[]): void {
    this.dependencies.depends(parentKey, childKeys);
  }

  

  /**
   * Acquire a distributed lock on a resource.
   * 
   * @param key       - The resource to lock.
   * @param ttlMs     - Lock validity period (default: 30s).
   * @param maxRetries - Max retry attempts (default: 50).
   * @returns A LockHandle on success, or `null` on failure.
   */
  async lock(
    key: string,
    ttlMs?: number,
    maxRetries?: number
  ): Promise<LockHandle | null> {
    return this.lockManager.acquire(key, ttlMs, maxRetries);
  }

  /**
   * Release a previously acquired lock.
   * 
   * @param handle - The LockHandle from `lock()`.
   */
  async unlock(handle: LockHandle): Promise<boolean> {
    return this.lockManager.release(handle);
  }

  

  /**
   * Create a namespaced view of this cache.
   * All keys are automatically prefixed with the namespace.
   * 
   * @param name - The namespace name.
   * @returns A CacheNamespace instance.
   */
  namespace(name: string): CacheNamespace {
    return new CacheNamespace(this, name);
  }

  

  /**
   * Register a listener for a cache event.
   */
  on<E extends CacheEventName>(
    event: E,
    listener: (payload: CacheEventMap[E]) => void
  ): this {
    this.events.on(event, listener);
    return this;
  }

  /**
   * Register a one-time event listener.
   */
  once<E extends CacheEventName>(
    event: E,
    listener: (payload: CacheEventMap[E]) => void
  ): this {
    this.events.once(event, listener);
    return this;
  }

  /**
   * Remove an event listener.
   */
  off<E extends CacheEventName>(
    event: E,
    listener: (payload: CacheEventMap[E]) => void
  ): this {
    this.events.off(event, listener);
    return this;
  }

  

  /**
   * Register a plugin.
   * The plugin's `install()` method is called with this cache instance.
   * 
   * @param plugin - The plugin to install.
   */
  async use(plugin: CachePlugin): Promise<void> {
    this.log.info(`Installing plugin: ${plugin.name}`);
    await plugin.install(this);
    this.plugins.push(plugin);
  }

  

  /**
   * Get a snapshot of cache statistics.
   */
  async stats(): Promise<CacheStats> {
    const redisLatency = this.redis?.isConnected
      ? await this.redis.ping()
      : -1;

    return this.metrics.snapshot({
      l1Entries: this.memory.size,
      l1MemoryBytes: this.memory.memoryBytes,
      redisConnected: this.redis?.isConnected ?? false,
      redisLatencyMs: redisLatency,
      activeLocks: this.lockManager.activeLockCount,
      hotKeys: this.hotKeys.getHotKeys(10),
    });
  }



  

  /**
   * Internal delete that handles both direct and cascade deletions.
   */
  private async deleteInternal(key: string, cascaded: boolean): Promise<boolean> {
    const memDeleted = this.memory.delete(key);

    let redisDeleted = false;
    if (this.redis?.isConnected) {
      redisDeleted = await this.redis.delete(key);

      // Broadcast to other server instances via Pub/Sub
      await this.redis.publishInvalidation(
        JSON.stringify({ type: "delete", key })
      );
    }

    // Broadcast to other cluster workers via IPC
    this.clusterManager.broadcastDelete(key);

    const existed = memDeleted || redisDeleted;

    if (existed) {
      this.events.emit("delete", { key, cascaded });
      this.hotKeys.remove(key);
      this.dependencies.removeChild(key);
    }

    return existed;
  }

  /**
   * Execute a loader, cache the result, and return it.
   * Uses deduplication to prevent concurrent duplicate loads.
   */
  private async executeAndCache<T>(
    key: string,
    loader: () => Promise<T>,
    options?: FetchOptions
  ): Promise<T> {
    const { value, deduplicated } = await this.deduplicator.dedupe(key, async () => {
      const [result, durationMs] = await measureAsync(loader);

      this.metrics.recordLoaderExecution(durationMs);
      this.events.emit("loaderExecution", {
        key,
        durationMs,
        deduplicated: false,
      });

      return result;
    });

    // Cache the result (only the original executor needs to do this)
    if (!deduplicated) {
      await this.set(key, value, {
        ttl: options?.ttl,
        tags: options?.tags,
        localOnly: options?.localOnly,
      });
    } else {
      // Still put in L1 for deduplicated requests
      const ttl = options?.ttl ?? this.defaultTTL;
      this.memory.set(key, value, ttl, options?.tags);
    }

    return value as T;
  }

  /**
   * Check if refresh-ahead should be triggered and do it in background.
   */
  private maybeRefreshAhead<T>(
    key: string,
    loader: () => Promise<T>,
    options?: FetchOptions
  ): void {
    if (this.memory.needsRefreshAhead(key, this.stampede.refreshAheadFraction)) {
      this.backgroundRefresh(key, loader, options);
    }
  }

  /**
   * Refresh a cache entry in the background without blocking.
   */
  private backgroundRefresh<T>(
    key: string,
    loader: () => Promise<T>,
    options?: FetchOptions
  ): void {
    // Avoid multiple simultaneous refreshes for the same key
    if (this.refreshInProgress.has(key)) return;
    this.refreshInProgress.add(key);

    this.log.debug(`Background refresh started for "${key}"`);

    loader()
      .then(async (value) => {
        await this.set(key, value, {
          ttl: options?.ttl,
          tags: options?.tags,
          localOnly: options?.localOnly,
        });
        this.log.debug(`Background refresh completed for "${key}"`);
      })
      .catch((err) => {
        this.log.error(`Background refresh failed for "${key}":`, (err as Error).message);
        this.events.emit("error", {
          message: `Background refresh failed for "${key}"`,
          error: err as Error,
          source: "backgroundRefresh",
        });
      })
      .finally(() => {
        this.refreshInProgress.delete(key);
      });
  }

  /**
   * Trigger predictive preloads for keys frequently accessed after `key`.
   */
  private triggerPreloads(key: string): void {
    const targets = this.preloader.getPreloadTargets(key);

    for (const target of targets) {
      // Only preload if not already in L1 and we have a loader
      if (!this.memory.has(target)) {
        const loader = this.loaders.get(target);
        if (loader) {
          this.log.debug(`Preloading "${target}" (triggered by "${key}")`);
          loader()
            .then(async (value) => {
              await this.set(target, value);
            })
            .catch((err) => {
              this.log.error(`Preload of "${target}" failed:`, (err as Error).message);
            });
        }
      }
    }
  }

  /**
   * Handle an invalidation message from another instance via Pub/Sub.
   */
  private handleRemoteInvalidation(message: string): void {
    try {
      const parsed = JSON.parse(message);

      switch (parsed.type) {
        case "delete":
          this.memory.delete(parsed.key);
          this.log.debug(`Remote invalidation: delete "${parsed.key}"`);
          break;

        case "tag":
          this.memory.invalidateTag(parsed.tag);
          this.log.debug(`Remote invalidation: tag "${parsed.tag}"`);
          break;

        case "pattern":
          this.memory.invalidatePattern(parsed.pattern);
          this.log.debug(`Remote invalidation: pattern "${parsed.pattern}"`);
          break;

        default:
          this.log.warn(`Unknown invalidation type: ${parsed.type}`);
      }
    } catch (err) {
      this.log.error("Failed to parse invalidation message:", (err as Error).message);
    }
  }

  /**
   * Handle an invalidation message from another cluster worker via IPC.
   */
  private handleClusterInvalidation(payload: {
    action: string;
    key?: string;
    tag?: string;
    pattern?: string;
  }): void {
    switch (payload.action) {
      case "delete":
        if (payload.key) {
          this.memory.delete(payload.key);
          this.log.debug(`Cluster invalidation: delete "${payload.key}"`);
        }
        break;

      case "tag":
        if (payload.tag) {
          this.memory.invalidateTag(payload.tag);
          this.log.debug(`Cluster invalidation: tag "${payload.tag}"`);
        }
        break;

      case "pattern":
        if (payload.pattern) {
          this.memory.invalidatePattern(payload.pattern);
          this.log.debug(`Cluster invalidation: pattern "${payload.pattern}"`);
        }
        break;

      case "clear":
        this.memory.clear();
        this.log.debug("Cluster invalidation: clear");
        break;

      default:
        this.log.warn(`Unknown cluster invalidation action: ${payload.action}`);
    }
  }

  

  /**
   * Clear all entries from the cache (both L1 and L2 for prefixed keys).
   * Broadcasts to cluster workers and remote instances.
   */
  async clear(): Promise<void> {
    this.memory.clear();
    this.deduplicator.clear();
    this.dependencies.clear();
    this.hotKeys.clear();
    this.preloader.clear();
    this.loaders.clear();
    this.refreshInProgress.clear();

    // Broadcast to cluster workers
    this.clusterManager.broadcastClear();

    this.log.info("Cache cleared");
  }
}
