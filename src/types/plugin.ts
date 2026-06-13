/**
 * plugin.ts
 * 
 * Defines the Plugin interface that third-party or built-in plugins
 * must implement to hook into the SuperiorCache lifecycle.
 * 
 * Plugins can intercept cache operations, add custom storage adapters,
 * or extend the cache with new functionality (e.g. a Prisma integration).
 */

import type { SuperiorCache } from "../core/superior-cache";



/**
 * A Plugin is any object with a `name` and an `install` method.
 * 
 * When `cache.use(plugin)` is called, SuperiorCache invokes
 * `plugin.install(cache)` which gives the plugin full access
 * to the cache instance so it can register event listeners,
 * wrap methods, or set up background tasks.
 * 
 * Plugins may optionally implement a `destroy` method that will
 * be called when the cache shuts down, allowing clean-up.
 * 
 * Example skeleton:
 * ```ts
 * const myPlugin: CachePlugin = {
 *   name: "my-plugin",
 *   install(cache) {
 *     cache.on("set", (event) => { ... });
 *   },
 *   destroy() { ... }
 * };
 * ```
 */
export interface CachePlugin {
  /** Unique name for this plugin (used in logs and error messages). */
  readonly name: string;

  /**
   * Called once when the plugin is registered via `cache.use(plugin)`.
   * @param cache - The SuperiorCache instance.
   */
  install(cache: SuperiorCache): void | Promise<void>;

  /**
   * Optional cleanup method called when the cache is being destroyed.
   * Use this to cancel timers, close connections, etc.
   */
  destroy?(): void | Promise<void>;
}
