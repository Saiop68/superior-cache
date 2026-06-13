/**
 * cluster-manager.ts
 * 
 * Manages cache synchronisation across Node.js cluster workers
 * using IPC (Inter-Process Communication).
 * 
 * When running in a Node.js Cluster environment (e.g. via `cluster`
 * module, PM2, or similar process managers), each worker has its
 * own in-memory L1 cache.  This manager keeps all workers' memory
 * caches synchronised by broadcasting invalidation messages
 * through the cluster IPC channel.
 * 
 * Message flow:
 *  1. Worker A deletes "user:123" from its local cache.
 *  2. Worker A broadcasts { type: "delete", key: "user:123" } via IPC.
 *  3. The primary process relays the message to all other workers.
 *  4. Workers B, C, D receive the message and evict "user:123" from
 *     their local L1 caches.
 * 
 * This is complementary to Redis Pub/Sub invalidation:
 *  - Cluster IPC handles same-machine, multi-process sync (faster).
 *  - Redis Pub/Sub handles cross-server sync (distributed).
 * 
 * Supported environments:
 *  - Node.js `cluster` module
 *  - PM2 cluster mode
 *  - Any process manager that supports `process.send()`
 */

import cluster from "cluster";
import { randomUUID } from "crypto";
import { Logger } from "../utils/logger";
import type { ClusterOptions } from "../types/cache-options";



/** IPC message type identifier to distinguish our messages from others. */
const IPC_MESSAGE_TYPE = "superior-cache:cluster" as const;



/**
 * The shape of an IPC message sent between cluster workers.
 */
interface ClusterIPCMessage {
  /** Identifies this as a SuperiorCache message. */
  __type: typeof IPC_MESSAGE_TYPE;

  /** Unique ID of the node that sent this message (to avoid echo). */
  senderId: string;

  /** The invalidation payload. */
  payload: ClusterInvalidationPayload;
}

/**
 * Possible invalidation payloads sent via cluster IPC.
 */
type ClusterInvalidationPayload =
  | { action: "delete"; key: string }
  | { action: "tag"; tag: string }
  | { action: "pattern"; pattern: string }
  | { action: "clear" };



export class ClusterManager {
  /** Unique identifier for this node/worker. */
  private readonly nodeId: string;

  /** Whether cluster mode is active and IPC is available. */
  private readonly active: boolean;

  /** Logger instance. */
  private readonly log: Logger;

  /** Registered handler for incoming invalidation messages. */
  private handler: ((payload: ClusterInvalidationPayload) => void) | null = null;

  /** Bound reference to the message listener (for cleanup). */
  private readonly boundMessageListener: (msg: unknown) => void;

  constructor(options: ClusterOptions = {}, debug: boolean = false) {
    this.log = new Logger("ClusterManager", debug);

    // Generate or use provided node ID
    this.nodeId = options.nodeId ?? `node-${randomUUID().slice(0, 8)}`;

    // Determine if we should activate
    if (options.enabled === false) {
      this.active = false;
      this.log.debug("Cluster mode explicitly disabled");
    } else if (options.enabled === true) {
      this.active = this.isClusterEnvironment();
      if (!this.active) {
        this.log.warn("Cluster mode requested but not running in a cluster environment");
      }
    } else {
      // Auto-detect
      this.active = this.isClusterEnvironment();
    }

    // Bind the message listener
    this.boundMessageListener = this.onMessage.bind(this);

    if (this.active) {
      this.setupListener();
      this.log.info(`Cluster mode active (nodeId: ${this.nodeId})`);
    }
  }

  

  /**
   * Whether cluster synchronisation is active.
   */
  get isActive(): boolean {
    return this.active;
  }

  /**
   * Register a handler for incoming invalidation messages from other workers.
   * 
   * @param handler - Callback invoked when another worker broadcasts an invalidation.
   */
  onInvalidation(handler: (payload: ClusterInvalidationPayload) => void): void {
    this.handler = handler;
  }

  /**
   * Broadcast a key deletion to all other cluster workers.
   * 
   * @param key - The cache key that was deleted.
   */
  broadcastDelete(key: string): void {
    this.broadcast({ action: "delete", key });
  }

  /**
   * Broadcast a tag invalidation to all other cluster workers.
   * 
   * @param tag - The tag that was invalidated.
   */
  broadcastTagInvalidation(tag: string): void {
    this.broadcast({ action: "tag", tag });
  }

  /**
   * Broadcast a pattern invalidation to all other cluster workers.
   * 
   * @param pattern - The glob pattern that was invalidated.
   */
  broadcastPatternInvalidation(pattern: string): void {
    this.broadcast({ action: "pattern", pattern });
  }

  /**
   * Broadcast a full cache clear to all other cluster workers.
   */
  broadcastClear(): void {
    this.broadcast({ action: "clear" });
  }

  /**
   * Clean up the IPC listener.
   */
  destroy(): void {
    if (this.active) {
      process.removeListener("message", this.boundMessageListener);
      this.handler = null;
      this.log.debug("Cluster manager destroyed");
    }
  }

  

  /**
   * Detect whether we're running in a cluster environment.
   */
  private isClusterEnvironment(): boolean {
    // Check Node.js cluster module
    if (cluster.isWorker) return true;

    // Check PM2 (sets PM2_HOME or pm_id env variables)
    if (process.env.PM2_HOME || process.env.pm_id !== undefined) return true;

    // Check if process.send exists (indicates IPC channel is available)
    if (typeof process.send === "function") return true;

    return false;
  }

  /**
   * Set up the IPC message listener.
   */
  private setupListener(): void {
    process.on("message", this.boundMessageListener);
  }

  /**
   * Handle an incoming IPC message.
   */
  private onMessage(msg: unknown): void {
    // Validate message shape
    if (!this.isOurMessage(msg)) return;

    // Ignore our own messages
    if (msg.senderId === this.nodeId) return;

    this.log.debug(
      `Received cluster invalidation from ${msg.senderId}: ` +
      `${JSON.stringify(msg.payload)}`
    );

    if (this.handler) {
      try {
        this.handler(msg.payload);
      } catch (err) {
        this.log.error("Cluster invalidation handler error:", (err as Error).message);
      }
    }
  }

  /**
   * Broadcast an invalidation payload to all other workers via IPC.
   */
  private broadcast(payload: ClusterInvalidationPayload): void {
    if (!this.active || typeof process.send !== "function") return;

    const message: ClusterIPCMessage = {
      __type: IPC_MESSAGE_TYPE,
      senderId: this.nodeId,
      payload,
    };

    try {
      process.send(message);
      this.log.debug(`Broadcast cluster invalidation: ${JSON.stringify(payload)}`);
    } catch (err) {
      this.log.error("Failed to broadcast cluster message:", (err as Error).message);
    }
  }

  /**
   * Type guard to verify a message is one of ours.
   */
  private isOurMessage(msg: unknown): msg is ClusterIPCMessage {
    return (
      typeof msg === "object" &&
      msg !== null &&
      (msg as ClusterIPCMessage).__type === IPC_MESSAGE_TYPE &&
      typeof (msg as ClusterIPCMessage).senderId === "string" &&
      typeof (msg as ClusterIPCMessage).payload === "object"
    );
  }
}

/**
 * Setup script for the cluster primary process.
 * 
 * When running as the primary/master, this relays invalidation
 * messages from any worker to all OTHER workers. Call this once
 * in your primary process setup.
 * 
 * ```ts
 * import cluster from "cluster";
 * import { setupClusterPrimary } from "superior-cache";
 * 
 * if (cluster.isPrimary) {
 *   setupClusterPrimary();
 *   // Fork workers...
 * }
 * ```
 */
export function setupClusterPrimary(): void {
  if (!cluster.isPrimary && !cluster.isMaster) {
    console.warn("[SuperiorCache] setupClusterPrimary() called from a worker – ignoring");
    return;
  }

  cluster.on("message", (senderWorker, msg: unknown) => {
    // Only relay our messages
    if (
      typeof msg !== "object" ||
      msg === null ||
      (msg as ClusterIPCMessage).__type !== IPC_MESSAGE_TYPE
    ) {
      return;
    }

    // Relay to all OTHER workers
    for (const id in cluster.workers) {
      const worker = cluster.workers[id];
      if (worker && worker !== senderWorker && !worker.isDead()) {
        try {
          worker.send(msg);
        } catch {
          // Worker may have died between the check and send
        }
      }
    }
  });
}
