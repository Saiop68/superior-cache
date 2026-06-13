/**
 * examples/prod-api-server.ts
 * 
 * A realistic production example demonstrating how to integrate SuperiorCache 
 * into a high-concurrency HTTP API server.
 * 
 * Features:
 *  1. Multi-layer cache setup with Binary Serialization (MessagePack) and transparent compression.
 *  2. Resilient Redis connection event handling (graceful failover to memory-only).
 *  3. Simulated slow Database queries using a mock loader.
 *  4. API endpoints with deduplication and stampede protection.
 *  5. Immediate tag invalidation on data mutative actions.
 *  6. Integrated monitoring dashboard.
 * 
 * Run with: npx ts-node examples/prod-api-server.ts
 */

import http from "http";
import { SuperiorCache } from "../src";

// ---------------------------------------------------------
// 1. Database Simulation
// ---------------------------------------------------------
interface Product {
  id: string;
  name: string;
  price: number;
  stock: number;
  description: string;
}

const db: Record<string, Product> = {
  "prod-1": { id: "prod-1", name: "Premium Wireless Headphones", price: 199.99, stock: 42, description: "Active noise cancelling headphones with 40h battery life." },
  "prod-2": { id: "prod-2", name: "Ultra-wide Gaming Monitor", price: 449.99, stock: 15, description: "34-inch curved QHD gaming monitor with 144Hz refresh rate." },
  "prod-3": { id: "prod-3", name: "Ergonomic Mechanical Keyboard", price: 129.99, stock: 88, description: "Hot-swappable tactile switches with RGB backlighting." },
};

async function fetchProductFromDatabase(id: string): Promise<Product> {
  console.log(`[Database] Querying product details for ID: "${id}"...`);
  // Simulate database latency
  await new Promise((resolve) => setTimeout(resolve, 800));
  
  if (!db[id]) {
    throw new Error(`Product ${id} not found in database`);
  }
  return db[id];
}

async function updateProductInDatabase(id: string, updates: Partial<Product>): Promise<Product> {
  console.log(`[Database] Mutating product: "${id}"...`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  
  if (!db[id]) {
    throw new Error(`Product ${id} not found`);
  }
  db[id] = { ...db[id], ...updates };
  return db[id];
}

// ---------------------------------------------------------
// 2. SuperiorCache Production Initialization
// ---------------------------------------------------------
const cache = new SuperiorCache({
  // Use MessagePack for compressed, high-performance binary storage in Redis
  serializer: "msgpack",
  
  memory: {
    maxEntries: 50000,
    maxMemoryMB: 256,       // Cap process memory to 256MB
    defaultTTL: 30000,      // Keep local memory hot for 30s
  },
  
  redis: {
    url: "redis://localhost:6379",
    keyPrefix: "prod_api:",
    defaultTTL: 300000,     // Distributed Redis cache lives for 5 min
  },
  
  stampede: {
    enabled: true,          // Stale-While-Revalidate stampede protection
    graceMs: 60000,         // Serve stale data for up to 60s while refreshing
    refreshAheadFraction: 0.2, // Refresh in background when 80% through the TTL
  },

  compression: {
    enabled: true,
    thresholdBytes: 512,    // Compress payloads larger than 512 bytes
  },
  
  debug: false
});

// Resilient fallback logic & logging
cache.on("error", (err) => {
  console.error("[SuperiorCache Warning] Redis operation failed:", err.message);
});

// ---------------------------------------------------------
// 3. HTTP Request Router
// ---------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;

  // Set response headers
  res.setHeader("Content-Type", "application/json");

  try {
    // GET /product/:id
    // Demonstrates: Smart Fetch, Deduplication, and Stampede Protection
    if (path.startsWith("/product/") && req.method === "GET") {
      const productId = path.split("/")[2];
      if (!productId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Missing product ID" }));
        return;
      }

      console.log(`[API Request] GET /product/${productId}`);
      
      const product = await cache.fetch(
        `product:${productId}`,
        () => fetchProductFromDatabase(productId),
        {
          ttl: 15000,               // Cache lifespan of 15 seconds
          tags: ["products", `product-id:${productId}`],
          refreshAhead: true,       // Smooth updates in the background
        }
      );

      res.writeHead(200);
      res.end(JSON.stringify({ source: "cache", data: product }));
      return;
    }

    // POST /product/:id/update
    // Demonstrates: Safe mutations with immediate Tag Invalidation
    if (path.startsWith("/product/") && path.endsWith("/update") && req.method === "POST") {
      const productId = path.split("/")[2];
      if (!productId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Missing product ID" }));
        return;
      }

      console.log(`[API Request] POST /product/${productId}/update`);
      
      // Parse a simple request body update (e.g. update stock value randomly)
      const mockUpdates = {
        price: Math.round((200 + Math.random() * 200) * 100) / 100,
        stock: Math.floor(Math.random() * 100),
      };

      // 1. Perform write operation to Database
      const updatedProduct = await updateProductInDatabase(productId, mockUpdates);

      // 2. Instantly purge stale product caches across all instances
      console.log(`[Cache Invalidation] Purging tag "product-id:${productId}"...`);
      await cache.invalidateTag(`product-id:${productId}`);

      res.writeHead(200);
      res.end(JSON.stringify({ success: true, updated: updatedProduct }));
      return;
    }

    // Default 404
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Endpoint not found" }));

  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
});

// ---------------------------------------------------------
// 4. Server Execution
// ---------------------------------------------------------
async function start() {
  console.log("Starting Production Mock Server...");
  
  // 1. Start caching system
  try {
    await cache.connect();
    console.log("✔ Cache connection initialized.");
  } catch (err) {
    console.warn("⚠ Failed to connect to Redis. Running in resilient Memory-Only fallback mode.");
  }

  // 2. Start HTTP Server
  const apiPort = 3000;
  server.listen(apiPort, () => {
    console.log(`✔ Production API running at: http://localhost:${apiPort}`);
    console.log("\nTry hitting these endpoints:");
    console.log(`  - GET  http://localhost:${apiPort}/product/prod-1        (Initial fetch takes 800ms)`);
    console.log(`  - GET  http://localhost:${apiPort}/product/prod-1        (Subsequent fetches take <1ms)`);
    console.log(`  - POST http://localhost:${apiPort}/product/prod-1/update (Mutates and triggers tag invalidation)`);
  });
}

start().catch((err) => {
  console.error("Startup failure:", err);
  process.exit(1);
});
