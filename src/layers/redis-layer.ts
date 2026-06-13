/**
 * redis-layer.ts
 * 
 * The L2 (Redis-backed) cache layer.
 * 
 * Provides persistent, distributed caching via Redis.
 * Supports Pub/Sub for cross-instance cache invalidation,
 * distributed locking, and pattern-based key scanning.
 */

import Redis from "ioredis";
import type { RedisLayerOptions } from "../types/cache-options";
import type { Serializer } from "../types/serializer";
import { Logger } from "../utils/logger";
import { Compressor } from "../utils/compression";



const DEFAULTS = {
  keyPrefix: "sc:",
  defaultTTL: 300_000, // 5 minutes
  pubSubChannel: "superior-cache:invalidation",
  connectTimeoutMs: 5_000,
} as const;



export class RedisLayer {
  /** The main Redis client for reads/writes. */
  private client: Redis | null = null;

  /** A separate Redis client for Pub/Sub (Redis requires a dedicated connection). */
  private subscriber: Redis | null = null;

  /** Key prefix for all Redis keys. */
  private readonly keyPrefix: string;

  /** Default TTL in milliseconds. */
  private readonly defaultTTL: number;

  /** Pub/Sub channel name for invalidation messages. */
  private readonly pubSubChannel: string;

  /** Whether Pub/Sub is enabled. */
  private readonly pubSubEnabled: boolean;

  /** The serializer for encoding/decoding values. */
  private serializer!: Serializer;

  /** The compressor for large values. */
  private compressor!: Compressor;

  /** Logger instance. */
  private readonly log: Logger;

  /** Connection options. */
  private readonly connectionOptions: RedisLayerOptions;

  /** Whether the client is connected. */
  private connected: boolean = false;

  /** Callbacks registered for invalidation messages. */
  private invalidationCallbacks: Array<(message: string) => void> = [];

  constructor(options: RedisLayerOptions = {}, debug: boolean = false) {
    this.keyPrefix = options.keyPrefix ?? DEFAULTS.keyPrefix;
    this.defaultTTL = options.defaultTTL ?? DEFAULTS.defaultTTL;
    this.pubSubChannel = options.pubSubChannel ?? DEFAULTS.pubSubChannel;
    this.pubSubEnabled = options.enablePubSub ?? true;
    this.connectionOptions = options;
    this.log = new Logger("RedisLayer", debug);
  }

  

  /**
   * Connect to Redis and set up Pub/Sub if enabled.
   * Must be called before any cache operations.
   */
  async connect(serializer: Serializer, compressor: Compressor): Promise<void> {
    this.serializer = serializer;
    this.compressor = compressor;

    const redisOptions = this.connectionOptions.url
      ? this.connectionOptions.url
      : {
          host: this.connectionOptions.connection?.host ?? "127.0.0.1",
          port: this.connectionOptions.connection?.port ?? 6379,
          password: this.connectionOptions.connection?.password,
          db: this.connectionOptions.connection?.db ?? 0,
          connectTimeout: this.connectionOptions.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs,
          lazyConnect: true,
          maxRetriesPerRequest: 3,
          retryStrategy: (times: number) => Math.min(times * 200, 2000),
        };

    this.client = new Redis(redisOptions as string);
    
    // Track whether we've already logged a connection error to avoid spam
    let errorLogged = false;

    // Set up error handling — suppress repeated errors
    this.client.on("error", (err: Error) => {
      if (!errorLogged) {
        this.log.error("Redis client error:", err.message);
        errorLogged = true;
      }
      this.connected = false;
    });

    this.client.on("connect", () => {
      this.connected = true;
      errorLogged = false; // Reset on successful connection
      this.log.debug("Redis client connected");
    });

    this.client.on("close", () => {
      this.connected = false;
      this.log.debug("Redis client disconnected");
    });

    try {
      await this.client.connect();
      this.connected = true;
      this.log.debug("Redis connection established");
    } catch (err) {
      this.log.error("Failed to connect to Redis:", (err as Error).message);
      // Disconnect and prevent further reconnection attempts
      this.client.disconnect(false);
      this.client = null;
      this.connected = false;
      throw err;
    }

    // Set up Pub/Sub on a separate connection
    if (this.pubSubEnabled) {
      await this.setupPubSub();
    }
  }

  

  /**
   * Retrieve a value from Redis.
   * Handles deserialization and decompression automatically.
   */
  async get<T = unknown>(key: string): Promise<T | null> {
    if (!this.client || !this.connected) return null;

    try {
      const prefixedKey = this.prefixKey(key);
      const raw = await this.client.getBuffer(prefixedKey);

      if (raw === null) return null;

      const decompressed = this.compressor.decompress(raw);
      return this.serializer.deserialize(decompressed) as T;
    } catch (err) {
      this.log.error(`GET "${key}" failed:`, (err as Error).message);
      return null;
    }
  }

  /**
   * Store a value in Redis with optional TTL.
   * Handles serialization and compression automatically.
   */
  async set(key: string, value: unknown, ttl?: number): Promise<void> {
    if (!this.client || !this.connected) return;

    try {
      const prefixedKey = this.prefixKey(key);
      const serialized = this.serializer.serialize(value);
      const compressed = this.compressor.compress(serialized);
      const effectiveTTL = ttl ?? this.defaultTTL;

      if (effectiveTTL === Infinity) {
        await this.client.set(prefixedKey, compressed);
      } else {
        // Redis PX = milliseconds
        await this.client.set(prefixedKey, compressed, "PX", effectiveTTL);
      }

      this.log.debug(`SET "${key}" (TTL=${effectiveTTL}ms)`);
    } catch (err) {
      this.log.error(`SET "${key}" failed:`, (err as Error).message);
    }
  }

  /**
   * Delete a key from Redis.
   */
  async delete(key: string): Promise<boolean> {
    if (!this.client || !this.connected) return false;

    try {
      const prefixedKey = this.prefixKey(key);
      const result = await this.client.del(prefixedKey);
      return result > 0;
    } catch (err) {
      this.log.error(`DELETE "${key}" failed:`, (err as Error).message);
      return false;
    }
  }

  /**
   * Retrieve multiple values from Redis in a single MGET call.
   */
  async mget<T = unknown>(keys: string[]): Promise<Map<string, T>> {
    const results = new Map<string, T>();
    if (!this.client || !this.connected || keys.length === 0) return results;

    try {
      const prefixedKeys = keys.map((k) => this.prefixKey(k));
      const rawValues = await this.client.mgetBuffer(...prefixedKeys);

      for (let i = 0; i < keys.length; i++) {
        const raw = rawValues[i];
        if (raw !== null) {
          const decompressed = this.compressor.decompress(raw);
          results.set(keys[i], this.serializer.deserialize(decompressed) as T);
        }
      }
    } catch (err) {
      this.log.error("MGET failed:", (err as Error).message);
    }

    return results;
  }

  /**
   * Delete multiple keys from Redis.
   */
  async mdelete(keys: string[]): Promise<number> {
    if (!this.client || !this.connected || keys.length === 0) return 0;

    try {
      const prefixedKeys = keys.map((k) => this.prefixKey(k));
      return await this.client.del(...prefixedKeys);
    } catch (err) {
      this.log.error("MDELETE failed:", (err as Error).message);
      return 0;
    }
  }

  

  /**
   * Associate a key with one or more tags in Redis.
   * Tags are stored as Redis Sets: tag → Set<key>.
   */
  async addTags(key: string, tags: string[]): Promise<void> {
    if (!this.client || !this.connected || tags.length === 0) return;

    try {
      const pipeline = this.client.pipeline();
      for (const tag of tags) {
        pipeline.sadd(this.prefixKey(`tag:${tag}`), key);
      }
      await pipeline.exec();
    } catch (err) {
      this.log.error(`addTags "${key}" failed:`, (err as Error).message);
    }
  }

  /**
   * Get all keys associated with a tag.
   */
  async getTagMembers(tag: string): Promise<string[]> {
    if (!this.client || !this.connected) return [];

    try {
      return await this.client.smembers(this.prefixKey(`tag:${tag}`));
    } catch (err) {
      this.log.error(`getTagMembers "${tag}" failed:`, (err as Error).message);
      return [];
    }
  }

  /**
   * Remove the tag set itself from Redis.
   */
  async deleteTag(tag: string): Promise<void> {
    if (!this.client || !this.connected) return;

    try {
      await this.client.del(this.prefixKey(`tag:${tag}`));
    } catch (err) {
      this.log.error(`deleteTag "${tag}" failed:`, (err as Error).message);
    }
  }

  

  /**
   * Find all keys matching a glob pattern using Redis SCAN.
   * Uses SCAN (not KEYS) to avoid blocking the Redis server.
   */
  async scanPattern(pattern: string): Promise<string[]> {
    if (!this.client || !this.connected) return [];

    const results: string[] = [];
    const prefixedPattern = this.prefixKey(pattern);
    let cursor = "0";

    try {
      do {
        const [nextCursor, keys] = await this.client.scan(
          cursor,
          "MATCH",
          prefixedPattern,
          "COUNT",
          100
        );
        cursor = nextCursor;
        for (const key of keys) {
          // Strip prefix before returning
          results.push(key.slice(this.keyPrefix.length));
        }
      } while (cursor !== "0");
    } catch (err) {
      this.log.error(`scanPattern "${pattern}" failed:`, (err as Error).message);
    }

    return results;
  }

  

  /**
   * Acquire a distributed lock using Redis SET NX PX.
   * Returns true if the lock was acquired.
   */
  async acquireLock(
    lockKey: string,
    lockValue: string,
    ttlMs: number
  ): Promise<boolean> {
    if (!this.client || !this.connected) return false;

    try {
      const prefixedKey = this.prefixKey(`lock:${lockKey}`);
      const result = await this.client.set(prefixedKey, lockValue, "PX", ttlMs, "NX");
      return result === "OK";
    } catch (err) {
      this.log.error(`acquireLock "${lockKey}" failed:`, (err as Error).message);
      return false;
    }
  }

  /**
   * Release a distributed lock.
   * Only releases if the lock value matches (prevents releasing someone else's lock).
   */
  async releaseLock(lockKey: string, lockValue: string): Promise<boolean> {
    if (!this.client || !this.connected) return false;

    // Use a Lua script for atomic check-and-delete
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    try {
      const prefixedKey = this.prefixKey(`lock:${lockKey}`);
      const result = await this.client.eval(script, 1, prefixedKey, lockValue);
      return result === 1;
    } catch (err) {
      this.log.error(`releaseLock "${lockKey}" failed:`, (err as Error).message);
      return false;
    }
  }

  

  /**
   * Publish an invalidation message to all connected instances.
   */
  async publishInvalidation(message: string): Promise<void> {
    if (!this.client || !this.connected) return;

    try {
      await this.client.publish(this.pubSubChannel, message);
      this.log.debug(`Published invalidation: ${message}`);
    } catch (err) {
      this.log.error("publishInvalidation failed:", (err as Error).message);
    }
  }

  /**
   * Register a callback for invalidation messages from other instances.
   */
  onInvalidation(callback: (message: string) => void): void {
    this.invalidationCallbacks.push(callback);
  }

  

  /**
   * Measure Redis round-trip latency with PING.
   */
  async ping(): Promise<number> {
    if (!this.client || !this.connected) return -1;

    const start = Date.now();
    try {
      await this.client.ping();
      return Date.now() - start;
    } catch {
      return -1;
    }
  }

  /** Whether Redis is currently connected. */
  get isConnected(): boolean {
    return this.connected;
  }

  

  /**
   * Gracefully disconnect from Redis and clean up.
   */
  async destroy(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.quit().catch(() => {});
      this.subscriber = null;
    }
    if (this.client) {
      await this.client.quit().catch(() => {});
      this.client = null;
    }
    this.connected = false;
    this.invalidationCallbacks = [];
    this.log.debug("Redis layer destroyed");
  }

  

  /** Add the key prefix to a cache key. */
  private prefixKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  /** Set up the Pub/Sub subscriber connection. */
  private async setupPubSub(): Promise<void> {
    if (!this.client) return;

    try {
      // Duplicate the connection for Pub/Sub
      this.subscriber = this.client.duplicate();

      this.subscriber.on("error", (err: Error) => {
        this.log.error("Redis subscriber error:", err.message);
      });

      await this.subscriber.subscribe(this.pubSubChannel);

      this.subscriber.on("message", (_channel: string, message: string) => {
        this.log.debug(`Received invalidation: ${message}`);
        for (const cb of this.invalidationCallbacks) {
          try {
            cb(message);
          } catch (err) {
            this.log.error("Invalidation callback error:", (err as Error).message);
          }
        }
      });

      this.log.debug(`Subscribed to Pub/Sub channel: ${this.pubSubChannel}`);
    } catch (err) {
      this.log.warn("Failed to set up Pub/Sub:", (err as Error).message);
    }
  }
}
