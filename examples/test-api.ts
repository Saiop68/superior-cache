/**
 * examples/test-api.ts
 * 
 * Verifies SuperiorCache operations against the active prod-api-server.
 */

import http from "http";

function request(url: string, method: string): Promise<{ data: string; elapsed: number }> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const req = http.request(url, { method }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        resolve({
          data: body,
          elapsed: Date.now() - start,
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function test() {
  console.log("=== Testing Production API Cache Behavior ===\n");

  // 1. First GET: Cold Cache
  console.log("1. Fetching product (Cold Cache)...");
  const r1 = await request("http://localhost:3000/product/prod-1", "GET");
  console.log(`   Response: ${r1.data}`);
  console.log(`   Elapsed:  ${r1.elapsed}ms (Should be ~800ms due to simulated DB latency)\n`);

  // 2. Second GET: Hot Cache
  console.log("2. Fetching product again (Hot Cache - L1 Memory)...");
  const r2 = await request("http://localhost:3000/product/prod-1", "GET");
  console.log(`   Response: ${r2.data}`);
  console.log(`   Elapsed:  ${r2.elapsed}ms (Should be <5ms)\n`);

  // 3. POST Update: Mutate and Invalidate Tag
  console.log("3. Triggering product update & invalidation tag...");
  const r3 = await request("http://localhost:3000/product/prod-1/update", "POST");
  console.log(`   Response: ${r3.data}`);
  console.log(`   Elapsed:  ${r3.elapsed}ms\n`);

  // 4. Third GET: Cold Cache again (due to tag purge)
  console.log("4. Fetching product post-mutation (Should Miss Cache)...");
  const r4 = await request("http://localhost:3000/product/prod-1", "GET");
  console.log(`   Response: ${r4.data}`);
  console.log(`   Elapsed:  ${r4.elapsed}ms (Should be ~800ms and show mutated data)\n`);
}

test().catch(console.error);
