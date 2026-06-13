/**
 * demo.ts
 * 
 * Comprehensive demonstration of SuperiorCache features.
 * 
 * This script walks through every major feature of the cache system:
 *  1. Smart Fetch & Multi-layer Cache
 *  2. Request Deduplication
 *  3. Tag-based Invalidation
 *  4. Cache Dependencies (cascade delete)
 *  5. Predictive Preloading
 *  6. Atomic Distributed Locking
 *  7. Pattern Invalidation
 *  8. Namespaces
 *  9. Batch Operations
 * 10. Statistics & Metrics
 * 
 * Requirements:
 *  - Redis running on localhost:6379
 * 
 * Run with: npm run example
 */

import { SuperiorCache } from "../src";

/* ------------------------------------------------------------------ */
/*  Simulated Database                                                */
/* ------------------------------------------------------------------ */

/** Simulates a slow database call with a configurable delay. */
async function simulateDbCall<T>(label: string, data: T, delayMs: number = 500): Promise<T> {
  console.log(`[DB] ${label}...`);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return data;
}

/* ------------------------------------------------------------------ */
/*  Loader Execution Counter (for deduplication test)                 */
/* ------------------------------------------------------------------ */

let loaderExecutionCount = 0;

/* ------------------------------------------------------------------ */
/*  Main Demo                                                         */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log("=== Initializing SuperiorCache Demo ===");

  // Create cache instance with sensible defaults
  const cache = new SuperiorCache({
    memory: {
      maxEntries: 10_000,
      maxMemoryMB: 128,
      defaultTTL: 60_000,
    },
    redis: {
      keyPrefix: "demo:",
      defaultTTL: 300_000,
    },
    stampede: {
      enabled: true,
      graceMs: 30_000,
    },
    debug: false,
  });

  // Register event listeners for visibility
  cache.on("hit", (e) => {
    console.log(`[Event] Cache HIT for key "${e.key}" on layer: ${e.layer}`);
  });
  cache.on("miss", (e) => {
    console.log(`[Event] Cache MISS for key "${e.key}"`);
  });
  cache.on("set", (e) => {
    console.log(`[Event] Cache SET for key "${e.key}"`);
  });
  cache.on("delete", (e) => {
    console.log(`[Event] Cache DELETE for key "${e.key}"`);
  });
  cache.on("tagInvalidation", (e) => {
    console.log(`[Event] Tag Invalidation for tag "${e.tag}"`);
  });

  // Connect to Redis
  console.log("Connecting to Redis...");
  try {
    await cache.connect();
    console.log("Redis connected successfully!\n");
  } catch (err) {
    console.error("Failed to connect to Redis:", (err as Error).message);
    console.log("Continuing with memory-only mode...\n");
  }


  /* ================================================================ */
  /*  1. Smart Fetch & Multi-layer Cache                              */
  /* ================================================================ */

  console.log("--- Testing Smart Fetch & Multi-layer Cache ---");

  // First fetch: should miss, execute loader, cache result
  console.log("Fetching user 101...");
  const user1 = await cache.fetch("user:101", () =>
    simulateDbCall("Loading user 101 from database", {
      id: 101,
      name: "User 101",
      email: "user101@example.com",
    })
  );
  console.log("Fetched user:", user1);
  console.log();

  // Second fetch: should hit L1 (memory)
  console.log("Fetching user 101 again...");
  const user1Again = await cache.fetch("user:101", () =>
    simulateDbCall("This should NOT execute", { id: 101 })
  );
  console.log("Fetched user (cached):", user1Again);
  console.log();

  /* ================================================================ */
  /*  2. Request Deduplication                                        */
  /* ================================================================ */

  console.log("--- Testing Request Deduplication ---");

  loaderExecutionCount = 0;

  console.log("Triggering 5 concurrent requests for user:102...");
  const concurrentResults = await Promise.all(
    Array.from({ length: 5 }, () =>
      cache.fetch("user:102", async () => {
        loaderExecutionCount++;
        return simulateDbCall("Loading user 102 (deduplicated)", {
          id: 102,
          name: "User 102",
        }, 700);
      })
    )
  );

  console.log("Concurrency results count:", concurrentResults.length);
  console.log(`Loader executions count: ${loaderExecutionCount} (Should be 1!)`);
  console.log();

  /* ================================================================ */
  /*  3. Tag-based Invalidation                                       */
  /* ================================================================ */

  console.log("--- Testing Tag-based Invalidation ---");

  await cache.set("user:1", { id: 1, name: "Alice" }, { tags: ["users"] });
  await cache.set("user:2", { id: 2, name: "Bob" }, { tags: ["users"] });
  await cache.set("admin:1", { id: 1, name: "Admin" }, { tags: ["admins"] });

  console.log("Verifying tags exist...");
  console.log("user:1 exists?", (await cache.get("user:1")) !== null);
  console.log("user:2 exists?", (await cache.get("user:2")) !== null);
  console.log("admin:1 exists?", (await cache.get("admin:1")) !== null);
  console.log();

  console.log("Invalidating tag 'users'...");
  await cache.invalidateTag("users");

  console.log("Verifying after tag invalidation...");
  console.log("user:1 exists?", (await cache.get("user:1")) !== null);
  console.log("user:2 exists?", (await cache.get("user:2")) !== null);
  console.log("admin:1 exists?", (await cache.get("admin:1")) !== null);
  console.log();

  /* ================================================================ */
  /*  4. Cache Dependencies (Cascade Delete)                          */
  /* ================================================================ */

  console.log("--- Testing Cache Dependencies ---");

  await cache.set("guild:123", { id: 123, name: "My Guild" });
  await cache.set("guild:123:members", [{ userId: 1 }, { userId: 2 }]);
  await cache.set("guild:123:roles", [{ roleId: 1, name: "Admin" }]);

  // Register dependencies
  cache.depends("guild:123", ["guild:123:members", "guild:123:roles"]);

  console.log("Deleting parent key 'guild:123'...");
  await cache.delete("guild:123");

  console.log("Checking dependent child keys (should be cascadingly deleted):");
  console.log("guild:123 exists?", (await cache.get("guild:123")) !== null);
  console.log("guild:123:members exists?", (await cache.get("guild:123:members")) !== null);
  console.log("guild:123:roles exists?", (await cache.get("guild:123:roles")) !== null);
  console.log();

  /* ================================================================ */
  /*  5. Predictive Preloading                                        */
  /* ================================================================ */

  console.log("--- Testing Predictive Preloading ---");

  console.log("Simulating access sequence (fetching product detail, then product reviews)...");

  // Simulate repeated access pattern: product → reviews
  for (let i = 0; i < 5; i++) {
    await cache.fetch("product:abc", () =>
      simulateDbCall("Loading product", { id: "abc", name: "Widget" }, 10)
    );
    await cache.fetch("product:abc:reviews", () =>
      simulateDbCall("Loading reviews", [{ rating: 5 }], 10)
    );

    // Clear from memory to simulate next "cold" request
    await cache.delete("product:abc");
    await cache.delete("product:abc:reviews");
  }

  // Now access product:abc - reviews should be preloaded
  console.log("Removing product reviews from memory...");
  await cache.delete("product:abc:reviews");

  console.log("Accessing product:abc...");
  await cache.fetch("product:abc", () =>
    simulateDbCall("Loading product for preload test", { id: "abc" }, 10)
  );

  // Small delay to let preloading happen
  await new Promise((r) => setTimeout(r, 200));

  const reviews = await cache.get("product:abc:reviews");
  console.log("Was reviews preloaded in background?", reviews !== null);
  console.log("Reviews cache content:", reviews);
  console.log();

  /* ================================================================ */
  /*  6. Atomic Distributed Locking                                   */
  /* ================================================================ */

  console.log("--- Testing Atomic Locking ---");

  console.log("Acquiring lock on resource 'payment:user:1'...");
  const lock = await cache.lock("payment:user:1", 10_000, 0);

  if (lock) {
    console.log("Lock acquired!");

    console.log("Attempting to acquire lock again concurrently (should fail)...");
    const secondLock = await cache.lock("payment:user:1", 10_000, 0);

    if (secondLock) {
      console.error("Error: Managed to acquire locked resource!");
      await cache.unlock(secondLock);
    } else {
      console.log("Correctly failed to acquire lock (resource is locked).");
    }

    console.log("Releasing lock...");
    await cache.unlock(lock);
    console.log("Lock released!");
  } else {
    console.log("Failed to acquire lock (Redis may not be available).");
  }
  console.log();

  /* ================================================================ */
  /*  7. Pattern Invalidation                                         */
  /* ================================================================ */

  console.log("--- Testing Pattern Invalidation ---");

  await cache.set("session:user:1", { token: "abc" });
  await cache.set("session:user:2", { token: "def" });
  await cache.set("session:user:3", { token: "ghi" });
  await cache.set("settings:user:1", { theme: "dark" });

  console.log("Invalidating pattern 'session:*'...");
  await cache.invalidatePattern("session:*");

  console.log("session:user:1 exists?", (await cache.get("session:user:1")) !== null);
  console.log("session:user:2 exists?", (await cache.get("session:user:2")) !== null);
  console.log("settings:user:1 exists?", (await cache.get("settings:user:1")) !== null);
  console.log();

  /* ================================================================ */
  /*  8. Namespaces                                                   */
  /* ================================================================ */

  console.log("--- Testing Namespaces ---");

  const usersNs = cache.namespace("users");
  const guildsNs = cache.namespace("guilds");

  await usersNs.set("1", { id: 1, name: "NamespaceUser" });
  await guildsNs.set("1", { id: 1, name: "NamespaceGuild" });

  const nsUser = await usersNs.get("1");
  const nsGuild = await guildsNs.get("1");

  console.log("users:1 =", nsUser);
  console.log("guilds:1 =", nsGuild);
  console.log("Keys don't collide:", JSON.stringify(nsUser) !== JSON.stringify(nsGuild));
  console.log();

  /* ================================================================ */
  /*  9. Batch Operations                                             */
  /* ================================================================ */

  console.log("--- Testing Batch Operations ---");

  await cache.mset([
    { key: "batch:1", value: "one" },
    { key: "batch:2", value: "two" },
    { key: "batch:3", value: "three" },
  ]);

  const batchResults = await cache.mget(["batch:1", "batch:2", "batch:3", "batch:missing"]);
  console.log("Batch get results:");
  for (const [key, value] of batchResults) {
    console.log(`  ${key} = ${JSON.stringify(value)}`);
  }
  console.log("Missing key included?", batchResults.has("batch:missing"));

  const deleted = await cache.mdelete(["batch:1", "batch:2", "batch:3"]);
  console.log(`Batch deleted ${deleted} keys`);
  console.log();

  /* ================================================================ */
  /*  10. Statistics & Metrics                                        */
  /* ================================================================ */

  console.log("--- Printing Cache Operational Statistics ---");
  const stats = await cache.stats();
  console.log(JSON.stringify(stats, null, 2));
  console.log();

  /* ================================================================ */
  /*  Done                                                            */
  /* ================================================================ */

  console.log("Demo run completed successfully!");
}

// Run the demo
main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
