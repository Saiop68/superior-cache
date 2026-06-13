/**
 * namespace.ts
 * 
 * Provides namespaced cache access.
 * 
 * A Namespace is a lightweight wrapper around a SuperiorCache
 * instance that automatically prefixes all keys with a namespace
 * string. This allows logical separation of cache domains
 * (e.g. "users:", "guilds:") without manually prefixing keys.
 * 
 * All operations delegate to the parent cache with the prefix applied.
 */

import type { SuperiorCache } from "./superior-cache";
import type { SetOptions, FetchOptions, BatchSetEntry } from "../types/cache-options";



export class CacheNamespace {
  /** The parent cache instance. */
  private readonly cache: SuperiorCache;

  /** The namespace prefix (e.g. "users:"). */
  private readonly prefix: string;

  /**
   * Create a new CacheNamespace.
   * 
   * @param cache     - The parent SuperiorCache instance.
   * @param namespace - The namespace name (a ":" separator is appended automatically).
   */
  constructor(cache: SuperiorCache, namespace: string) {
    this.cache = cache;
    this.prefix = `${namespace}:`;
  }

  /**
   * Get a value from the namespaced cache.
   * 
   * @param key - The key within this namespace.
   * @returns The cached value, or `null` if not found.
   */
  async get<T = unknown>(key: string): Promise<T | null> {
    return this.cache.get<T>(this.prefixKey(key));
  }

  /**
   * Set a value in the namespaced cache.
   * 
   * @param key     - The key within this namespace.
   * @param value   - The value to cache.
   * @param options - Optional set options (TTL, tags, etc.).
   */
  async set<T = unknown>(key: string, value: T, options?: SetOptions): Promise<void> {
    return this.cache.set(this.prefixKey(key), value, options);
  }

  /**
   * Delete a key from the namespaced cache.
   * 
   * @param key - The key within this namespace.
   * @returns `true` if the key existed.
   */
  async delete(key: string): Promise<boolean> {
    return this.cache.delete(this.prefixKey(key));
  }

  /**
   * Smart fetch with automatic loading.
   * 
   * @param key     - The key within this namespace.
   * @param loader  - The async function to load the value if not cached.
   * @param options - Optional fetch options.
   * @returns The cached or freshly loaded value.
   */
  async fetch<T = unknown>(
    key: string,
    loader: () => Promise<T>,
    options?: FetchOptions
  ): Promise<T> {
    return this.cache.fetch<T>(this.prefixKey(key), loader, options);
  }

  /**
   * Retrieve multiple namespaced values.
   * 
   * @param keys - Array of keys within this namespace.
   * @returns Map of key → value (without the namespace prefix).
   */
  async mget<T = unknown>(keys: string[]): Promise<Map<string, T>> {
    const prefixedKeys = keys.map((k) => this.prefixKey(k));
    const results = await this.cache.mget<T>(prefixedKeys);

    // Re-map keys back to un-prefixed form
    const unprefixed = new Map<string, T>();
    for (const [prefixedKey, value] of results) {
      unprefixed.set(this.unprefixKey(prefixedKey), value);
    }
    return unprefixed;
  }

  /**
   * Set multiple namespaced values.
   * 
   * @param entries - Array of { key, value, options } entries.
   */
  async mset<T = unknown>(entries: BatchSetEntry<T>[]): Promise<void> {
    const prefixedEntries = entries.map((e) => ({
      ...e,
      key: this.prefixKey(e.key),
    }));
    return this.cache.mset(prefixedEntries);
  }

  /**
   * Delete multiple namespaced keys.
   * 
   * @param keys - Array of keys within this namespace.
   * @returns Number of keys deleted.
   */
  async mdelete(keys: string[]): Promise<number> {
    const prefixedKeys = keys.map((k) => this.prefixKey(k));
    return this.cache.mdelete(prefixedKeys);
  }

  

  /** Prepend the namespace prefix to a key. */
  private prefixKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  /** Remove the namespace prefix from a key. */
  private unprefixKey(key: string): string {
    return key.startsWith(this.prefix) ? key.slice(this.prefix.length) : key;
  }
}
