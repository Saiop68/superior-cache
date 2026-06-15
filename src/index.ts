/**
 * index.ts
 * 
 * Main entry point for the SuperiorCache package.
 * 
 * Re-exports all public types and classes so consumers can import
 * everything from the package root:
 * 
 * ```ts
 * import { SuperiorCache } from "superior-cache";
 * ```
 */

export { SuperiorCache } from "./core/superior-cache";
export { SieveCache } from "./core/sieve-cache";
export type { SieveCacheOptions } from "./core/sieve-cache";
export { CacheNamespace } from "./core/namespace";
export { CacheEventBus } from "./core/event-bus";
export { setupClusterPrimary } from "./core/cluster-manager";

export { MemoryLayer } from "./layers/memory-layer";
export { RedisLayer } from "./layers/redis-layer";

export { jsonSerializer } from "./serializers/json-serializer";
export { msgpackSerializer } from "./serializers/msgpack-serializer";
export { resolveSerializer } from "./serializers/serializer-factory";

export type {
  SuperiorCacheOptions,
  MemoryLayerOptions,
  RedisLayerOptions,
  StampedeOptions,
  CompressionOptions,
  ClusterOptions,
  HotKeyOptions,
  SetOptions,
  FetchOptions,
  BatchSetEntry,
} from "./types/cache-options";

export type {
  Serializer,
  SerializerType,
} from "./types/serializer";

export type {
  CacheHitEvent,
  CacheMissEvent,
  CacheSetEvent,
  CacheDeleteEvent,
  CacheExpireEvent,
  TagInvalidationEvent,
  LoaderExecutionEvent,
  CacheErrorEvent,
  CacheEventMap,
  CacheEventName,
} from "./types/events";

export type {
  CachePlugin,
} from "./types/plugin";

export type {
  CacheStats,
  HotKeyEntry,
} from "./types/stats";

export type {
  LockHandle,
} from "./core/lock-manager";
