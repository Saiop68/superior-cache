import { describe, it, expect, vi, beforeEach } from "vitest";
import { SuperiorCache } from "./superior-cache";
import { delay } from "../utils/time";

describe("SuperiorCache Production Suite", () => {
  let cache: SuperiorCache;

  beforeEach(() => {
    // Instantiate in memory-only mode for tests
    cache = new SuperiorCache({
      memory: {
        maxEntries: 1000,
        defaultTTL: 1000,
      },
      redis: false, // Disables Redis for pure unit testing
      stampede: {
        enabled: true,
        graceMs: 500,
      },
      debug: false,
    });
  });

  it("should set and get values correctly", async () => {
    await cache.set("test-key", "test-value");
    const val = await cache.get("test-key");
    expect(val).toBe("test-value");
  });

  it("should return null for expired keys", async () => {
    await cache.set("temp-key", "temp-val", { ttl: 10 });
    await delay(20);
    const val = await cache.get("temp-key");
    expect(val).toBeNull();
  });

  it("should deduplicate concurrent fetches", async () => {
    let callCount = 0;
    const loader = async () => {
      callCount++;
      await delay(50);
      return { data: "success" };
    };

    // Fire 5 concurrent requests
    const results = await Promise.all([
      cache.fetch("dedupe-key", loader),
      cache.fetch("dedupe-key", loader),
      cache.fetch("dedupe-key", loader),
      cache.fetch("dedupe-key", loader),
      cache.fetch("dedupe-key", loader),
    ]);

    expect(results).toHaveLength(5);
    expect(results[0]).toEqual({ data: "success" });
    expect(results[4]).toEqual({ data: "success" });
    expect(callCount).toBe(1); // The loader was executed exactly once!
  });

  it("should support cascade dependency deletion", async () => {
    await cache.set("parent", "parentData");
    await cache.set("child1", "child1Data");
    await cache.set("child2", "child2Data");

    cache.depends("parent", ["child1", "child2"]);

    // Delete parent
    await cache.delete("parent");

    // Children should be cascadingly deleted
    expect(await cache.get("parent")).toBeNull();
    expect(await cache.get("child1")).toBeNull();
    expect(await cache.get("child2")).toBeNull();
  });
});
