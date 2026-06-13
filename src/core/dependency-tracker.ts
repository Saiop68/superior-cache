/**
 * dependency-tracker.ts
 * 
 * Tracks parent → child dependencies between cache keys.
 * 
 * When a parent key is deleted, all its dependent (child) keys
 * are automatically cascade-deleted.  This is useful for data
 * models where invalidating a "guild" should also invalidate
 * "guild:members", "guild:roles", etc.
 * 
 * Implementation:
 *  - A Map stores parent → Set<child> relationships.
 *  - On delete of a parent, all children are collected and returned
 *    so the caller can delete them from the cache layers.
 *  - Relationships are one-level deep (no transitive cascades)
 *    to keep the logic simple and predictable.
 */

import { Logger } from "../utils/logger";



export class DependencyTracker {
  /**
   * Maps parent keys to their dependent child keys.
   * parent → Set<child>
   */
  private readonly dependencies: Map<string, Set<string>>;

  /** Logger for diagnostics. */
  private readonly log: Logger;

  constructor(debug: boolean = false) {
    this.dependencies = new Map();
    this.log = new Logger("DependencyTracker", debug);
  }

  /**
   * Register a dependency: when `parentKey` is deleted,
   * all `childKeys` should also be deleted.
   * 
   * @param parentKey - The parent cache key.
   * @param childKeys - One or more dependent child keys.
   * 
   * @example
   * ```ts
   * tracker.depends("guild:123", [
   *   "guild:123:members",
   *   "guild:123:roles",
   * ]);
   * ```
   */
  depends(parentKey: string, childKeys: string[]): void {
    let children = this.dependencies.get(parentKey);

    if (!children) {
      children = new Set();
      this.dependencies.set(parentKey, children);
    }

    for (const child of childKeys) {
      children.add(child);
    }

    this.log.debug(
      `Registered ${childKeys.length} dependencies for "${parentKey}": ` +
      `[${childKeys.join(", ")}]`
    );
  }

  /**
   * Get all child keys that depend on a parent key.
   * 
   * @param parentKey - The parent cache key.
   * @returns Array of child keys (empty if no dependencies registered).
   */
  getDependents(parentKey: string): string[] {
    const children = this.dependencies.get(parentKey);
    return children ? Array.from(children) : [];
  }

  /**
   * Remove a parent and all its dependency registrations.
   * Returns the child keys that were registered (for cascade deletion).
   * 
   * @param parentKey - The parent cache key being deleted.
   * @returns Array of child keys that should be cascade-deleted.
   */
  removeDependencies(parentKey: string): string[] {
    const children = this.dependencies.get(parentKey);
    this.dependencies.delete(parentKey);

    if (children && children.size > 0) {
      const childArray = Array.from(children);
      this.log.debug(
        `Cascade delete for "${parentKey}": ` +
        `[${childArray.join(", ")}]`
      );
      return childArray;
    }

    return [];
  }

  /**
   * Remove a specific child from all parent registrations.
   * Used when a child key is deleted independently.
   * 
   * @param childKey - The child key to unregister.
   */
  removeChild(childKey: string): void {
    for (const [parent, children] of this.dependencies) {
      children.delete(childKey);
      // Clean up empty parent entries
      if (children.size === 0) {
        this.dependencies.delete(parent);
      }
    }
  }

  /**
   * Check whether a key has any registered dependencies.
   * 
   * @param parentKey - The key to check.
   * @returns `true` if the key has at least one dependent.
   */
  hasDependents(parentKey: string): boolean {
    const children = this.dependencies.get(parentKey);
    return children !== undefined && children.size > 0;
  }

  /**
   * Get the total number of parent keys with registered dependencies.
   */
  get size(): number {
    return this.dependencies.size;
  }

  /**
   * Clear all registered dependencies.
   */
  clear(): void {
    this.dependencies.clear();
    this.log.debug("All dependencies cleared");
  }
}
