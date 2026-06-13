# SuperiorCache

SuperiorCache is a production-grade, highly resilient distributed caching library for Node.js. It merges low-latency in-memory cache operations with Redis persistent caching, request deduplication, stampede protection, tag-based invalidation, and sequential preloading.

---

## Table of Contents

1. [High-Level Architecture](#high-level-architecture)
2. [Core Features & Mechanisms](#core-features--mechanisms)
   - [Multi-Layer Cache Lifecycle](#multi-layer-cache-lifecycle)
   - [Request Deduplication](#request-deduplication)
   - [Stampede Protection & Background Refresh](#stampede-protection--background-refresh)
   - [Multi-Process Synchronization (Cluster IPC + Pub/Sub)](#multi-process-synchronization-cluster-ipc--pubsub)
3. [Installation](#installation)
4. [Quick Start](#quick-start)
5. [Complete API Reference](#complete-api-reference)
   - [Constructor & Options](#constructor--options)
   - [Core Operations](#core-operations)
   - [Batch Operations](#batch-operations)
   - [Advanced Invalidation](#advanced-invalidation)
   - [Cascade Dependencies](#cascade-dependencies)
   - [Logical Namespaces](#logical-namespaces)
   - [Distributed Locks](#distributed-locks)
6. [Serialization & Compression](#serialization--compression)
7. [Advanced Heuristics](#advanced-heuristics)
   - [Hot Key Detector](#hot-key-detector)
   - [Predictive Preloader](#predictive-preloader)
8. [Extending with Plugins](#extending-with-plugins)
9. [Production Deployment Guide](#production-deployment-guide)
10. [License](#license)

---

## High-Level Architecture

```
                  ┌──────────────────────────────────────────────┐
                  │                 Application                  │
                  └──────┬────────────────────────────────┬──────┘
                         │ (Read Cache Miss)              │ (Write / Evict)
                         ▼                                ▼
              ┌─────────────────────┐          ┌─────────────────────┐
              │ Memory Cache (L1)   │          │ Memory Cache (L1)   │
              └──────┬──────────────┘          └──────────┬──────────┘
                     │ (L1 Miss)                          │
                     ▼                                    ▼
              ┌─────────────────────┐          ┌─────────────────────┐
              │ Redis Cache (L2)    │          │ Redis Cache (L2)    │
              └──────┬──────────────┘          └──────────┬──────────┘
                     │ (L2 Miss)                          │ (Pub/Sub Broadcast)
                     ▼                                    ▼
              ┌─────────────────────┐          ┌─────────────────────┐
              │ Data Loader (L3 DB) │          │ External Instances  │
              └─────────────────────┘          └─────────────────────┘
```

SuperiorCache coordinates three primary layers:
*   **Memory Layer (L1)**: In-process LRU (Least Recently Used) cache with byte-size limits, keeping access time sub-millisecond.
*   **Redis Layer (L2)**: Distributed secondary cache layer keeping state persistent, accessible across multiple nodes.
*   **Data Source (L3)**: Your primary database, API, or service.

---

## Core Features & Mechanisms

### Multi-Layer Cache Lifecycle

When you fetch a key:
1. **L1 Check**: If the value is present and unexpired in memory, it is returned immediately.
2. **L2 Check**: If it misses L1, the system queries Redis. If found, the value is promoted to L1 for faster subsequent reads and returned.
3. **L3 Execution (Loader)**: If it misses both L1 and L2, the system executes your loader function to query the database, populates both L2 and L1, and returns the result.

### Request Deduplication

Under heavy load, multiple concurrent processes may request the exact same key at the same time. Without protection, this results in a cache miss for all requests, causing a stampede to your database. 

SuperiorCache intercepts concurrent reads using an in-flight Promise map:
*   Only **one** database request is executed.
*   All other concurrent requests wait for that single promise to resolve and receive the identical result.

### Stampede Protection & Background Refresh

When a key is near its expiration time or is fetched after expiration, SuperiorCache can serve **stale** data for a configurable grace period (`graceMs`) while initiating a background fetch for the fresh value. This keeps your application's response times low and guarantees that the database is never hit by a sudden peak of concurrent requests when a cache key expires.

### Multi-Process Synchronization (Cluster IPC + Pub/Sub)

To prevent split-brain issues across Node.js processes:
1. **Cluster IPC**: When running in Node.js `cluster` mode or PM2 cluster mode, SuperiorCache communicates invalidations via standard process IPC. This keeps local L1 caches on the same server instantly synchronized.
2. **Redis Pub/Sub**: In multi-server deployments, invalidations (deletes, tag purges, pattern invalidations) are published to a Redis channel to evict corresponding keys from the memory layers of other servers.

---

## Installation

Install the library using npm:

```bash
npm install superior-cache
```

Ensure you have a Redis instance running (v6.2+ recommended) if you plan to use L2 capabilities.

---

## Quick Start

```typescript
import { SuperiorCache } from "superior-cache";

// Initialize the orchestrator
const cache = new SuperiorCache({
  redis: {
    url: "redis://localhost:6379",
    keyPrefix: "app:"
  },
  memory: {
    maxMemoryMB: 256 // limit local memory to 256MB
  }
});

// Connect to Redis
await cache.connect();

// Perform a Smart Fetch
const user = await cache.fetch("user:123", async () => {
  // Loaded only on cache miss
  return { id: 123, name: "Alice", email: "alice@example.com" };
});

console.log(user);

// Clean shutdown on app exit
await cache.destroy();
```

---

## Complete API Reference

### Constructor & Options

```typescript
const cache = new SuperiorCache(options?: SuperiorCacheOptions);
```

#### `SuperiorCacheOptions` Configuration Map

| Category | Option | Type | Default | Description |
|---|---|---|---|---|
| **Global** | `defaultTTL` | `number` | `60000` | Fallback time-to-live in milliseconds if not specified per write. |
| | `serializer` | `"json" \| "msgpack" \| Serializer` | `"json"` | Serialization technique used for Redis storage. |
| | `debug` | `boolean` | `false` | Enables verbose diagnostics logging. |
| **Memory (L1)** | `memory.maxEntries` | `number` | `10000` | Maximum number of keys allowed in L1. |
| | `memory.maxMemoryMB` | `number` | `128` | Max estimated heap size for L1 before eviction. |
| | `memory.defaultTTL` | `number` | Same as global | TTL for L1 entries. |
| | `memory.sweepIntervalMs`| `number` | `10000` | Interval to scan and purge expired items in L1. |
| **Redis (L2)** | `redis` | `RedisOptions \| false` | `{}` | Connection options. Set to `false` for memory-only mode. |
| | `redis.url` | `string` | `undefined` | Redis connection URL (e.g. `redis://localhost:6379`). |
| | `redis.connection` | `object` | `undefined` | Host/Port configuration object if URL is not used. |
| | `redis.keyPrefix` | `string` | `"superior:"` | Prefix prepended to all Redis keys. |
| | `redis.enablePubSub` | `boolean` | `true` | Enable Redis Pub/Sub for distributed invalidation. |
| **Stampede** | `stampede.enabled` | `boolean` | `true` | Enables stale-while-revalidate protection. |
| | `stampede.graceMs` | `number` | `30000` | How long stale values can be served during refresh. |
| | `stampede.refreshAheadFraction` | `number` | `0.2` | Point at which background refresh is triggered (e.g., `0.2` means when 80% of TTL has elapsed). |
| **Compression** | `compression.enabled`| `boolean` | `false` | Compresses large payloads before sending to Redis. |
| | `compression.thresholdBytes`| `number` | `1024` | Minimum payload size in bytes to trigger gzip. |
| **Cluster** | `cluster.enabled` | `boolean` | `true` (auto) | Enables node cross-worker IPC invalidations. |
| | `cluster.nodeId` | `string` | Random UUID | Unique identifier for this process node. |
| **Hot Keys** | `hotKeys.topN` | `number` | `10` | Number of most active keys tracked in stats. |

---

### Core Operations

#### `get<T>(key: string): Promise<T | null>`
Fetches a value from L1 or L2. Returns `null` if missing or expired.
```typescript
const user = await cache.get<User>("user:123");
```

#### `set<T>(key: string, value: T, options?: SetOptions): Promise<void>`
Saves a value to the L1 and L2 caches.
```typescript
await cache.set("user:123", { name: "Bob" }, {
  ttl: 30000,
  tags: ["users", "admin"]
});
```

#### `delete(key: string): Promise<boolean>`
Deletes a key from memory and Redis, broadcasting evictions via IPC and Pub/Sub.
```typescript
const deleted = await cache.delete("user:123");
```

#### `fetch<T>(key: string, loader: () => Promise<T>, options?: FetchOptions): Promise<T>`
Checks L1 and L2, executes the loader on cache miss, caches the output, and returns it. Handles deduplication and stampede protection.
```typescript
const data = await cache.fetch("stats:daily", async () => {
  return queryExpensiveDbMetrics();
}, {
  ttl: 60000,
  refreshAhead: true // trigger early background refresh
});
```

#### `clear(): Promise<void>`
Wipes all local L1 entries, invalidates active locks, and clears related prefixed L2 keys. Broadcasts a clear event to other cluster workers.
```typescript
await cache.clear();
```

---

### Batch Operations

Batch calls reduce latency by batching operations locally (L1) and executing pipelined commands to Redis (L2).

#### `mget<T>(keys: string[]): Promise<Map<string, T>>`
```typescript
const users = await cache.mget<User>(["user:1", "user:2", "user:3"]);
```

#### `mset(entries: BatchSetEntry[]): Promise<void>`
```typescript
await cache.mset([
  { key: "user:1", value: { name: "Alice" }, options: { ttl: 60000 } },
  { key: "user:2", value: { name: "Bob" } }
]);
```

#### `mdelete(keys: string[]): Promise<number>`
```typescript
const deletedCount = await cache.mdelete(["user:1", "user:2"]);
```

---

### Advanced Invalidation

#### Tag-Based Invalidation
Assign tags to cached items, then invalidate them in a single call. This is highly useful for cleaning up related resources when updates occur.

```typescript
// Associate keys with the tag 'products'
await cache.set("prod:1", prod1Data, { tags: ["products"] });
await cache.set("prod:2", prod2Data, { tags: ["products"] });

// Invalidate all keys tagged 'products'
await cache.invalidateTag("products");
```

#### Pattern Invalidation (Glob matching)
Invalidate keys matching standard glob patterns. 

```typescript
// Invalidates 'session:user:1', 'session:user:2', etc.
await cache.invalidatePattern("session:user:*");
```
*Note: Pattern invalidation uses a non-blocking scan command (`SCAN`) in Redis to prevent blocking the Redis event thread.*

---

### Cascade Dependencies

You can configure child keys to depend on a parent key. When the parent key is updated or deleted, all children are automatically evicted to prevent stale related data.

```typescript
await cache.set("project:100", projectInfo);
await cache.set("project:100:tasks", taskList);
await cache.set("project:100:members", memberList);

// Define cascade dependencies
cache.depends("project:100", ["project:100:tasks", "project:100:members"]);

// Evicts project:100, project:100:tasks, and project:100:members
await cache.delete("project:100");
```

---

### Logical Namespaces

Namespaces allow logical separation of key spaces with safe prefixes, returning a dedicated interface targeting that prefix.

```typescript
const usersNamespace = cache.namespace("users");

// Writes to 'users:123'
await usersNamespace.set("123", { name: "Alice" });

// Reads from 'users:123'
const user = await usersNamespace.get("123");
```

---

### Distributed Locks

Acquire mutually exclusive, distributed locks backed by Redis. Utilizes atomic `SET NX PX` and unique token validations for safety.

```typescript
// Acquire lock with 30s expiry. Retries for up to 5s if locked.
const lock = await cache.lock("process:invoice:9", 30000, 5000);

if (lock) {
  try {
    // Perform critical process
    await processInvoice(9);
  } finally {
    // Safely unlock using the unique lock handle
    await cache.unlock(lock);
  }
}
```

---

## Serialization & Compression

### Built-in Serializers
*   `"json"`: Standard readable representation. Natively supported, ideal for direct CLI inspectability.
*   `"msgpack"`: High-performance binary serialization using MessagePack (`msgpackr`). Up to 50% smaller size and faster parsing for deeply nested objects.

### Custom Serializer Integration
Implement the `Serializer` interface:
```typescript
const customSerializer = {
  name: "custom-proto",
  serialize: (val: unknown) => MyProtocol.encode(val),
  deserialize: (buf: Buffer) => MyProtocol.decode(buf)
};

const cache = new SuperiorCache({ serializer: customSerializer });
```

### Transparent Compression
Avoid outbound bandwidth spikes by enabling gzip compression on large keys (such as full tables or configurations):
```typescript
const cache = new SuperiorCache({
  compression: {
    enabled: true,
    thresholdBytes: 1024 // Compress values > 1KB
  }
});
```
*Note: A compressed entry starts with a magic header byte (`0x1F`) allowing decompression to run transparently on read.*

---

## Advanced Heuristics

### Hot Key Detector
Keeps a local frequency tracking counter using a time decay function to identify keys causing disproportionate hit/miss frequencies. Used for profiling and visual stats reporting.

### Predictive Preloader
Learns sequence patterns. If your application routinely reads `product:id` and immediately queries `product:id:reviews`, the preloader registers this sequential correlation. On subsequent hits to `product:id`, it pre-emptively warms the cache with `product:id:reviews` in the background.

---

## Extending with Plugins

Modify or monitor runtime lifecycle events:

```typescript
import { CachePlugin, SuperiorCache } from "superior-cache";

const datadogMetricsPlugin: CachePlugin = {
  name: "datadog-metrics",
  
  install(cacheInstance: SuperiorCache) {
    cacheInstance.on("hit", (e) => {
      dogstatsd.increment("cache.hits", 1, [`layer:${e.layer}`]);
    });
    
    cacheInstance.on("loaderExecution", (e) => {
      dogstatsd.timing("cache.loader.time", e.durationMs);
    });
  },

  async destroy() {
    // Close metrics connections
  }
};

await cache.use(datadogMetricsPlugin);
```

---

## Production Deployment Guide

1. **Memory Allocation**: Ensure your Node.js heap limit (`--max-old-space-size`) accounts for `memory.maxMemoryMB`. If L1 is configured for `512MB`, ensure the server has at least `1GB` physical RAM.
2. **Redis Failover**: In production, configure Redis with Sentinel or Cluster. The `redis` connection object accepts standard `ioredis` configuration shapes (including Sentinels).
3. **PM2 / Cluster Mode Setup**: Call `setupClusterPrimary()` in the master process before worker forks to ensure IPC relays function:
   ```typescript
   import cluster from "cluster";
   import { setupClusterPrimary } from "superior-cache";

   if (cluster.isPrimary) {
     setupClusterPrimary();
     for (let i = 0; i < os.cpus().length; i++) cluster.fork();
   } else {
     // Run cache instances
   }
   ```
4. **NPM Exclusions**: The `.npmignore` file excludes development assets (`src`, `tests`, `tsconfig.json`) to keep the node_module payload under `200KB`.

---

## License

MIT © 2026. All rights reserved.
