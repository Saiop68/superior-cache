/**
 * lock-manager.ts
 * 
 * Provides distributed atomic locks using Redis.
 * 
 * Locks are useful for coordinating exclusive access to a
 * resource across multiple Node.js processes or servers.
 * For example, ensuring only one process runs a payment
 * operation at a time.
 * 
 * Implementation:
 *  - Uses Redis SET NX PX for atomic lock acquisition.
 *  - Each lock has a unique owner value (UUID) to prevent
 *    one process from releasing another's lock.
 *  - Locks auto-expire after a configurable TTL to prevent
 *    deadlocks if the holder crashes.
 *  - Release uses a Lua script for atomic check-and-delete.
 */

import { randomUUID } from "crypto";
import type { RedisLayer } from "../layers/redis-layer";
import { Logger } from "../utils/logger";
import { delay } from "../utils/time";



const DEFAULTS = {
  lockTTLMs: 30_000,        // 30 seconds
  retryDelayMs: 100,        // 100ms between retries
  maxRetries: 50,           // max retry attempts
} as const;



/**
 * A handle representing a held lock.
 * Must be passed to `release()` to give up the lock.
 */
export interface LockHandle {
  /** The resource key that is locked. */
  key: string;

  /** The unique lock owner value (used for safe release). */
  value: string;

  /** When this lock was acquired. */
  acquiredAt: number;
}



export class LockManager {
  /** Reference to the Redis layer for lock operations. */
  private readonly redis: RedisLayer | null;

  /** Set of lock keys currently held by this instance. */
  private readonly heldLocks: Map<string, LockHandle>;

  /** Logger instance. */
  private readonly log: Logger;

  constructor(redis: RedisLayer | null, debug: boolean = false) {
    this.redis = redis;
    this.heldLocks = new Map();
    this.log = new Logger("LockManager", debug);
  }

  /**
   * Acquire a distributed lock on a resource.
   * 
   * If the lock is already held, this method will retry
   * up to `maxRetries` times with a delay between attempts.
   * 
   * @param key         - The resource to lock (e.g. "payment:user:1").
   * @param ttlMs       - How long the lock is valid (default: 30s).
   * @param maxRetries  - Maximum retry attempts (default: 50).
   * @param retryDelay  - Delay between retries in ms (default: 100ms).
   * @returns A LockHandle on success, or `null` if the lock could not be acquired.
   * 
   * @example
   * ```ts
   * const lock = await lockManager.acquire("payment:user:1");
   * if (lock) {
   *   try {
   *     await processPayment(userId);
   *   } finally {
   *     await lockManager.release(lock);
   *   }
   * }
   * ```
   */
  async acquire(
    key: string,
    ttlMs: number = DEFAULTS.lockTTLMs,
    maxRetries: number = DEFAULTS.maxRetries,
    retryDelay: number = DEFAULTS.retryDelayMs,
  ): Promise<LockHandle | null> {
    if (!this.redis) {
      this.log.warn("No Redis connection – locks are not available");
      return null;
    }

    const lockValue = randomUUID();

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const acquired = await this.redis.acquireLock(key, lockValue, ttlMs);

      if (acquired) {
        const handle: LockHandle = {
          key,
          value: lockValue,
          acquiredAt: Date.now(),
        };

        this.heldLocks.set(key, handle);
        this.log.debug(`Lock acquired: "${key}" (attempt ${attempt + 1})`);
        return handle;
      }

      if (attempt < maxRetries) {
        await delay(retryDelay);
      }
    }

    this.log.warn(`Failed to acquire lock "${key}" after ${maxRetries + 1} attempts`);
    return null;
  }

  /**
   * Release a previously acquired lock.
   * 
   * Only the holder of the lock (matching lock value) can release it.
   * 
   * @param handle - The LockHandle returned by `acquire()`.
   * @returns `true` if the lock was released successfully.
   */
  async release(handle: LockHandle): Promise<boolean> {
    if (!this.redis) return false;

    const released = await this.redis.releaseLock(handle.key, handle.value);

    if (released) {
      this.heldLocks.delete(handle.key);
      this.log.debug(`Lock released: "${handle.key}"`);
    } else {
      this.log.warn(`Failed to release lock "${handle.key}" (expired or stolen)`);
    }

    return released;
  }

  /**
   * Check if a resource is currently locked by this instance.
   * 
   * @param key - The resource key to check.
   * @returns `true` if this instance holds the lock.
   */
  isLocked(key: string): boolean {
    return this.heldLocks.has(key);
  }

  /**
   * Get the number of locks currently held by this instance.
   */
  get activeLockCount(): number {
    return this.heldLocks.size;
  }

  /**
   * Release all locks held by this instance.
   * Called during shutdown.
   */
  async releaseAll(): Promise<void> {
    const handles = Array.from(this.heldLocks.values());

    for (const handle of handles) {
      await this.release(handle);
    }

    this.log.debug("All locks released");
  }

  /**
   * Clean up resources.
   */
  async destroy(): Promise<void> {
    await this.releaseAll();
    this.log.debug("Lock manager destroyed");
  }
}
