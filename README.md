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
3. [Performance Benchmarks](#performance-benchmarks)
4. [Installation](#installation)
5. [Quick Start](#quick-start)
6. [Complete API Reference](#complete-api-reference)
   - [Constructor & Options](#constructor--options)
   - [Core Operations](#core-operations)
   - [Batch Operations](#batch-operations)
   - [Advanced Invalidation](#advanced-invalidation)
   - [Cascade Dependencies](#cascade-dependencies)
   - [Logical Namespaces](#logical-namespaces)
   - [Distributed Locks](#distributed-locks)
7. [Serialization & Compression](#serialization--compression)
8. [Advanced Heuristics](#advanced-heuristics)
   - [Hot Key Detector](#hot-key-detector)
   - [Predictive Preloader](#predictive-preloader)
9. [Extending with Plugins](#extending-with-plugins)
10. [Production Deployment Guide](#production-deployment-guide)
11. [License](#license)

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

## Performance Benchmarks

SuperiorCache is designed from the ground up for hot-path speed. By replacing traditional Least Recently Used (LRU) list mutations on read operations with the **SIEVE eviction algorithm** and pre-allocated typed arrays, read latency is significantly reduced.

Benchmarks are run under a realistic warm cache state using a Zipfian distribution (skew = 1.0) with 1,000,000 operations.

### 1. Latency & Speedup Summary
Comparing the high-performance in-memory engine powering `new SuperiorCache()` and standalone `SieveCache` against `lru-cache` (v11):

| Operation | SieveCache (Lite) | lru-cache (No TTL) | SieveCache (Full) | lru-cache (With TTL) | SuperiorCache (L1) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`get() (Zipfian)`** | **52.87 ns** | 71.23 ns | **62.58 ns** | 96.44 ns | **82.04 ns** (3.6x vs LRU L2) |
| **`has()`** | **1.79 ns** (33x) | 59.22 ns | **58.53 ns** | 84.28 ns | **72.06 ns** (1.25x vs LRU L2) |
| **`set()`** | **173.31 ns** | 207.51 ns | **194.98 ns** | 300.21 ns | **251.13 ns** (1.39x vs LRU L2) |
| **`delete()`** | **9.70 ns** | 8.27 ns | **11.55 ns** | 9.50 ns | **12.17 ns** |

---

### 2. Actual Terminal Outputs

Below are the raw console outputs produced by the `mitata` benchmarking library on an AMD Ryzen 7 6800HS processor (Node.js v20.20.0):

#### A. Orchestrator MemoryLayer vs `lru-cache` (`npm run bench:ops`)
```text
=== SuperiorCache (SIEVE) vs lru-cache Benchmark ===
Config: max=10000, pre-populated

clk: ~2.07 GHz
cpu: AMD Ryzen 7 6800HS with Radeon Graphics         
runtime: node 20.20.0 (x64-win32)

benchmark                      avg (min … max) p75 / p99    (min … top 1%)
---------------------------------------------- -------------------------------
SuperiorCache: set()            251.13 ns/iter 284.35 ns  █▆                  
                         (125.32 ns … 1.51 µs) 725.90 ns  ███▇▂               
                       (  0.16  b … 342.21  b)  42.06  b ▅█████▇▆▄▃▃▃▃▂▂▂▂▁▁▁▁

lru-cache: set()                349.00 ns/iter 391.38 ns  ▃█                  
                         (193.73 ns … 1.65 µs) 906.79 ns  ██▇▅▃▂              
                       ( 16.14  b … 303.62  b) 112.82  b ▅██████▃▅▄▃▂▂▁▁▃▁▁▁▁▁

SuperiorCache: get() (Zipfian)   82.04 ns/iter  82.98 ns  █                   
                        (53.15 ns … 319.90 ns) 241.55 ns  █▄                  
                       (  0.10  b … 156.14  b)   0.58  b ███▅▃▃▃▂▂▂▂▁▁▁▁▁▂▁▁▁▁

lru-cache: get() (Zipfian)      295.85 ns/iter 400.00 ns   █▇                 
                         (0.00 ps … 537.80 µs)   1.30 µs   ██ ▂               
                       ( 32.00  b … 166.02 kb) 120.72  b ▁▁██▁█▇▁▅▄▁▃▂▁▂▁▁▁▁▁▁

SuperiorCache: has()             72.06 ns/iter  77.05 ns  █▇                  
                        (47.05 ns … 438.23 ns) 164.48 ns  ██▆▂                
                       (  0.02  b … 128.02  b)   0.42  b ▄████▆▅▃▄▃▃▃▃▃▂▂▂▂▁▁▁

lru-cache: has()                 90.37 ns/iter  93.31 ns  █▅                  
                        (62.50 ns … 451.68 ns) 255.00 ns  ██▃                 
                       (  0.02  b … 121.87  b)  26.53  b ▇███▅▄▃▄▃▁▁▁▁▁▁▁▁▁▁▁▁

SuperiorCache: delete()          12.17 ns/iter  11.08 ns  █                   
                         (8.35 ns … 240.41 ns)  52.88 ns ▄█                   
                       (  0.02  b … 112.03  b)   0.12  b ██▃▂▂▂▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁

lru-cache: delete()               8.56 ns/iter   8.37 ns   █                  
                         (6.03 ns … 605.98 ns)  18.73 ns   █▆▃                
                       (  0.01  b … 205.08  b)   0.10  b ▃▇███▄▂▂▂▂▂▁▁▁▁▁▁▁▁▁▁

SuperiorCache: mixed (80/10/10) 519.28 ns/iter 612.72 ns  █▅▇▇                
                          (68.65 ns … 1.78 µs)   1.58 µs  █████▇▅             
                       (  0.02  b … 340.04  b)   5.77  b ████████▆▃▂▃▃▆▄▅█▃▄▄▂

lru-cache: mixed (80/10/10)     606.72 ns/iter 788.04 ns     █▆▂              
                         (116.60 ns … 1.92 µs)   1.80 µs ▅▆▇████ ▅▄           
                       (  7.20  b … 336.88  b)  14.84  b ██████████▆▂▃▃▁▅▃▃▂▃▂
```

#### B. Standalone SieveCache vs `lru-cache` (`npm run bench:sieve`)
```text
=== STANDALONE SieveCache vs lru-cache Benchmark ===
Config: max=10000, pre-populated


benchmark                            avg (min … max) p75 / p99    (min … top 1%)
---------------------------------------------------- -------------------------------
SieveCache (Lite): set()              173.31 ns/iter 200.46 ns   ▅█                 
                                (86.25 ns … 1.16 µs) 389.33 ns  ▇███▅▃▅             
                             (  0.11  b … 422.21  b)  41.77  b ▃█████████▅▄▄▄▃▂▁▂▂▁▁

lru-cache (No TTL): set()             207.51 ns/iter 226.03 ns  █                   
                               (106.98 ns … 2.09 µs) 899.54 ns  █▃                  
                             ( 49.90  b … 401.04  b)  97.96  b ▆███▆▃▂▂▁▁▁▁▁▁▁▁▁▁▁▁▁

SieveCache (Lite): get() (Zipfian)     52.87 ns/iter  50.54 ns  █                   
                              (38.16 ns … 214.65 ns) 153.76 ns  █                   
                             (  0.02  b …  96.12  b)   0.27  b ▅█▇▃▃▂▂▂▂▁▂▁▁▁▁▁▁▁▁▁▁

lru-cache (No TTL): get() (Zipfian)    71.23 ns/iter  73.05 ns  ▂█                  
                              (48.58 ns … 981.96 ns) 162.55 ns  ██                  
                             (  0.01  b … 318.16  b)   0.62  b ▃███▅▄▃▃▂▃▃▂▂▂▂▁▁▁▁▁▁

SieveCache (Lite): has()                1.79 ns/iter   1.66 ns  █                   
                                (1.20 ns … 97.53 ns)   9.45 ns  █                   
                             (  0.00  b …  48.83  b)   0.02  b ▅█▂▂▂▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁

lru-cache (No TTL): has()              59.22 ns/iter  60.40 ns  █                   
                              (43.77 ns … 326.90 ns) 155.79 ns  █▇                  
                             (  0.12  b … 172.74  b)  39.37  b ▄███▄▃▃▂▂▂▁▁▁▁▁▁▁▁▁▁▁

SieveCache (Lite): mixed (80/10/10)   492.43 ns/iter 728.08 ns   █▂▄▅               
                                (62.67 ns … 1.50 µs)   1.33 µs ▃▆████▅▅             
                             (  0.11  b … 224.13  b)   4.60  b ████████▆▇██▇█▆▇▅▅▂▂▃

lru-cache (No TTL): mixed (80/10/10)  513.23 ns/iter 744.34 ns ▃█▄█▅▅▂▄             
                                (76.78 ns … 1.50 µs)   1.40 µs ████████ ▃▃▆▃▂       
                             (  5.60  b … 233.65  b)  11.58  b ██████████████▅█▅▂▂▄▃

SieveCache (Lite): delete()             9.70 ns/iter   9.42 ns  █                   
                               (6.93 ns … 307.50 ns)  28.22 ns  █                   
                             (  0.02  b … 112.03  b)   0.08  b ▆█▇▄▂▂▂▂▂▂▂▁▁▁▁▁▁▁▁▁▁

lru-cache (No TTL): delete()            8.27 ns/iter   7.81 ns ██                   
                               (5.86 ns … 344.82 ns)  48.71 ns ██                   
                             (  0.01  b … 112.03  b)   0.08  b ██▃▂▂▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁

SieveCache (Full): set()              194.98 ns/iter 210.03 ns  █                   
                                (94.95 ns … 1.46 µs)   1.01 µs  █▅                  
                             (  0.01  b … 479.34  b)  41.88  b ▃██▇▄▃▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁

lru-cache (With TTL): set()           300.21 ns/iter 318.16 ns  █                   
                               (171.90 ns … 1.80 µs)   1.25 µs  █▆                  
                             ( 72.02  b … 317.22  b) 114.20  b ▇███▆▃▂▂▁▁▁▁▁▁▁▁▁▁▁▁▁

SieveCache (Full): get() (Zipfian)     62.58 ns/iter  64.60 ns    ▅█                
                              (43.58 ns … 185.40 ns) 122.49 ns  ▃███▄               
                             (  0.01  b …  56.02  b)   0.30  b ▃█████▆▄▄▄▃▃▃▂▂▂▂▂▂▁▁

lru-cache (With TTL): get() (Zipfian)  96.44 ns/iter 105.64 ns   █▃                 
                              (59.62 ns … 628.17 ns) 227.59 ns  ▂██▃                
                             (  0.01  b … 262.22  b)   0.64  b ▄█████▆▅▃▄▃▃▂▂▁▂▁▁▁▁▁

SieveCache (Full): has()               58.53 ns/iter  57.42 ns  █                   
                              (38.11 ns … 529.83 ns) 264.28 ns  █                   
                             (  0.01  b … 104.02  b)   0.68  b ▅█▆▄▂▂▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁

lru-cache (With TTL): has()            84.28 ns/iter  85.40 ns  █                   
                              (58.20 ns … 580.44 ns) 289.55 ns  █▄                  
                             (  0.02  b … 202.15  b)  27.28  b ███▅▄▃▂▂▁▁▁▁▁▁▁▁▁▁▁▁▁

SieveCache (Full): delete()            11.55 ns/iter  10.57 ns  █                   
                               (7.71 ns … 631.98 ns)  37.48 ns  █                   
                             (  0.02  b … 119.15  b)   0.13  b ▆██▂▂▂▂▂▂▂▁▁▁▁▁▁▁▁▁▁▁

lru-cache (With TTL): delete()          9.50 ns/iter   8.59 ns  █                   
                                 (5.98 ns … 1.17 µs)  29.05 ns  █▄                  
                             (  0.10  b … 112.13  b)   0.19  b ▇██▂▂▂▃▄▂▂▁▁▁▁▁▁▁▁▁▁▁
```

---

### 3. Eviction Policy Hit Ratio (Verifiable)
Because the **SIEVE** algorithm preserves popular ("visited") entries longer without suffering from scan-pollution, it delivers higher hit ratios than strict LRU under skewed zipfian distributions:

| Cache Size | Working Set | SuperiorCache (SIEVE) | lru-cache (Strict LRU) | Net Gain |
| :--- | :--- | :--- | :--- | :--- |
| **1,000** | 5,000 | **79.5%** | 74.9% | **+4.6%** |
| **2,000** | 10,000 | **80.2%** | 76.5% | **+3.7%** |
| **5,000** | 20,000 | **82.4%** | 80.5% | **+1.9%** |
| **10,000** | 50,000 | **80.1%** | 78.6% | **+1.5%** |

---

## Installation

Install the library using npm:

```bash
npm install superior-cache
```

Ensure you have a Redis instance running (v6.2+ recommended) if you plan to use L2 capabilities.

---

## Quick Start

### 1. Orchestrated Multi-Layer (Memory + Redis)

Ideal for distributed microservices with persistence requirements, automatic synchronization, and stampede protection.

```typescript
import { SuperiorCache } from "superior-cache";

// Initialize the orchestrator
const cache = new SuperiorCache({
  redis: {
    url: "redis://localhost:6379",
    keyPrefix: "app:"
  },
  memory: {
    maxMemoryMB: 256
  }
});

// Connect to Redis
await cache.connect();

// Perform a Smart Fetch
const user = await cache.fetch("user:123", async () => {
  return { id: 123, name: "Alice", email: "alice@example.com" };
});

console.log(user);

// Clean shutdown on app exit
await cache.destroy();
```

### 2. Standalone In-Memory SieveCache

If you only need a super-fast, zero-dependency local cache with standard eviction capability, you can use the standalone `SieveCache` class directly. It automatically optimizes itself at construction time based on your configuration options (Lite mode for simple count limit, Full mode for TTL / weighted sizes / callbacks).

```typescript
import { SieveCache } from "superior-cache";

// Automatically runs in ultra-fast "Lite" mode if no TTL/sizes/callbacks are used
const cache = new SieveCache<string, string>({ max: 10000 });

cache.set("foo", "bar");
console.log(cache.get("foo")); // "bar"
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

### Standalone SieveCache Reference

The standalone `SieveCache` class provides a high-performance in-memory cache backing the SIEVE eviction algorithm. It uses pre-allocated typed arrays for zero GC overhead during high write churn.

```typescript
import { SieveCache } from "superior-cache";
const cache = new SieveCache(options);
```

#### `SieveCacheOptions` Configuration Map

| Option | Type | Default | Description |
|---|---|---|---|
| `max` | `number` | *Required* | Maximum number of keys allowed in the cache. |
| `ttl` | `number` | `Infinity` | Default time-to-live in milliseconds. |
| `ttlResolution` | `number` | `0` | Coarsening resolution in milliseconds. |
| `ttlAutopurge` | `boolean` | `false` | Enable background interval timer to sweep expired entries. |
| `updateAgeOnGet` | `boolean` | `false` | Update the age of an entry on retrieval. |
| `maxSize` | `number` | `Infinity` | Maximum cumulative size of entries before eviction. |
| `sizeCalculation` | `function` | `undefined` | Function to estimate entry size `(value, key) => number`. |
| `dispose` | `function` | `undefined` | Callback fired *before* eviction: `(value, key, reason) => void`. |
| `disposeAfter` | `function` | `undefined` | Callback fired *after* eviction: `(value, key, reason) => void`. |
| `noDisposeOnSet` | `boolean` | `false` | Suppress dispose callbacks during overwrites. |
| `allowStale` | `boolean` | `false` | Allow serving stale (expired) data during async fetching. |
| `fetchMethod` | `function` | `undefined` | miss handler for fetching values. |

#### SieveCache Instance Methods

- **`get(key: K): V | undefined`**: Retrieve an item. In Lite mode, this is a single array store (`visited[slot] = 1`).
- **`set(key: K, value: V, options?: { ttl?: number; size?: number }): this`**: Insert or update an item.
- **`has(key: K): boolean`**: Verify key existence. In Lite mode, this delegates directly to `Map.has()` (**~1.7 ns**).
- **`delete(key: K): boolean`**: Delete a key. Returns `true` if the key existed.
- **`peek(key: K): V | undefined`**: Read a value without marking it as visited.
- **`clear(): void`**: Clear all data and reset the eviction queue.
- **`keys() / values() / entries()`**: Returns ES6 Generators for traversing active keys, values, and entries.
- **`forEach(callback: (value: V, key: K, cache: this) => void, thisArg?: any): void`**: Standard ES6 forEach traversal.
- **`dump()` / `load(entries)`**: Export/import cache state for serialization/deserialization.
- **`fetch(key: K, options?: FetchOptions): Promise<V>`**: miss handler calling `fetchMethod` with request deduplication.

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
