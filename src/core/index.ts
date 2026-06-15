/**
 * core/index.ts
 * 
 * Barrel export for core modules.
 */

export { SuperiorCache } from "./superior-cache";
export { SieveCache } from "./sieve-cache";
export { CacheEventBus } from "./event-bus";
export { Deduplicator } from "./deduplicator";
export { DependencyTracker } from "./dependency-tracker";
export { HotKeyDetector } from "./hot-key-detector";
export { LockManager } from "./lock-manager";
export type { LockHandle } from "./lock-manager";
export { PredictivePreloader } from "./predictive-preloader";
export { MetricsCollector } from "./metrics-collector";
export { CacheNamespace } from "./namespace";
export { ClusterManager, setupClusterPrimary } from "./cluster-manager";
