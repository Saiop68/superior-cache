/**
 * event-bus.ts
 * 
 * A strongly-typed event emitter for SuperiorCache.
 * 
 * Wraps Node's EventEmitter with generics so that `.on()` and
 * `.emit()` are fully type-safe.  All cache events (hit, miss,
 * set, delete, expire, etc.) flow through this bus.
 * 
 * This is also the foundation for the plugin system – plugins
 * can listen to events to react to cache operations.
 */

import { EventEmitter } from "events";
import type { CacheEventMap, CacheEventName } from "../types/events";



/**
 * Type-safe event bus for cache events.
 * 
 * Usage:
 * ```ts
 * const bus = new CacheEventBus();
 * bus.on("hit", (event) => console.log(event.key, event.layer));
 * bus.emit("hit", { key: "foo", layer: "l1", latencyMs: 0.3 });
 * ```
 */
export class CacheEventBus {
  /** The underlying Node.js EventEmitter. */
  private readonly emitter: EventEmitter;

  constructor() {
    this.emitter = new EventEmitter();
    // Increase the default listener limit for plugins
    this.emitter.setMaxListeners(100);
  }

  /**
   * Register a listener for a specific cache event.
   * 
   * @param event    - The event name (e.g. "hit", "miss", "set").
   * @param listener - The callback function.
   * @returns `this` for chaining.
   */
  on<E extends CacheEventName>(
    event: E,
    listener: (payload: CacheEventMap[E]) => void
  ): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  /**
   * Register a one-time listener that automatically removes itself
   * after the first invocation.
   * 
   * @param event    - The event name.
   * @param listener - The callback function.
   * @returns `this` for chaining.
   */
  once<E extends CacheEventName>(
    event: E,
    listener: (payload: CacheEventMap[E]) => void
  ): this {
    this.emitter.once(event, listener as (...args: unknown[]) => void);
    return this;
  }

  /**
   * Remove a previously registered listener.
   * 
   * @param event    - The event name.
   * @param listener - The exact function reference to remove.
   * @returns `this` for chaining.
   */
  off<E extends CacheEventName>(
    event: E,
    listener: (payload: CacheEventMap[E]) => void
  ): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  /**
   * Emit a cache event, notifying all registered listeners.
   * 
   * @param event   - The event name.
   * @param payload - The event data.
   * @returns `true` if there were any listeners.
   */
  emit<E extends CacheEventName>(event: E, payload: CacheEventMap[E]): boolean {
    return this.emitter.emit(event, payload);
  }

  /**
   * Remove all listeners, optionally for a specific event.
   * 
   * @param event - If provided, only remove listeners for this event.
   */
  removeAllListeners(event?: CacheEventName): void {
    if (event) {
      this.emitter.removeAllListeners(event);
    } else {
      this.emitter.removeAllListeners();
    }
  }

  /**
   * Get the count of listeners registered for a given event.
   * 
   * @param event - The event name.
   * @returns Number of registered listeners.
   */
  listenerCount(event: CacheEventName): number {
    return this.emitter.listenerCount(event);
  }
}
