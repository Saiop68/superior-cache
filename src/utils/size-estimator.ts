/**
 * size-estimator.ts
 * 
 * Estimates the in-memory byte size of JavaScript values.
 * 
 * This is used by the LRU memory cache to enforce memory limits.
 * The estimates are intentionally approximate – we trade accuracy
 * for speed because this runs on every cache write.
 * 
 * Size heuristics:
 *  - number:    8 bytes
 *  - boolean:   4 bytes
 *  - string:    2 bytes per character (UTF-16)
 *  - null/undef: 0 bytes
 *  - Buffer:    buffer.length
 *  - Array:     sum of element sizes + 8 bytes overhead per slot
 *  - Object:    sum of key sizes + value sizes + 16 bytes overhead per property
 */



/**
 * Estimate the in-memory byte size of a JavaScript value.
 * 
 * @param value - Any JavaScript value.
 * @returns Estimated size in bytes.
 * 
 * @example
 * ```ts
 * estimateSize("hello");         // 10  (5 chars × 2 bytes)
 * estimateSize({ a: 1, b: 2 }); // ~52 bytes
 * ```
 */
export function estimateSize(value: unknown): number {
  return _estimate(value, new WeakSet());
}



/**
 * Recursive implementation with a `seen` set to avoid infinite
 * loops on circular references.
 * 
 * @param value - The value to estimate.
 * @param seen  - WeakSet of already-visited objects.
 * @returns Estimated byte size.
 */
function _estimate(value: unknown, seen: WeakSet<object>): number {
  if (value === null || value === undefined) {
    return 0;
  }

  const type = typeof value;

  // Primitive types ------------------------------------------------
  if (type === "number") {
    // IEEE 754 double = 8 bytes
    return 8;
  }

  if (type === "boolean") {
    return 4;
  }

  if (type === "string") {
    // JavaScript strings are internally UTF-16 → 2 bytes per char
    return (value as string).length * 2;
  }

  if (type === "bigint") {
    // Rough: 8 bytes per 64-bit word
    return 8;
  }

  if (type === "symbol" || type === "function") {
    return 0;
  }

  // Object types ---------------------------------------------------
  const obj = value as object;

  // Guard against circular references
  if (seen.has(obj)) {
    return 0;
  }
  seen.add(obj);

  // Buffer / Uint8Array – actual byte length
  if (Buffer.isBuffer(obj)) {
    return (obj as Buffer).length;
  }

  if (ArrayBuffer.isView(obj)) {
    return (obj as Uint8Array).byteLength;
  }

  // Array – 8 bytes overhead per slot + element sizes
  if (Array.isArray(obj)) {
    let total = 8; // array header overhead
    for (const item of obj) {
      total += 8 + _estimate(item, seen); // 8-byte pointer + value
    }
    return total;
  }

  // Map
  if (obj instanceof Map) {
    let total = 16;
    for (const [k, v] of obj) {
      total += _estimate(k, seen) + _estimate(v, seen) + 16;
    }
    return total;
  }

  // Set
  if (obj instanceof Set) {
    let total = 16;
    for (const v of obj) {
      total += _estimate(v, seen) + 8;
    }
    return total;
  }

  // Date
  if (obj instanceof Date) {
    return 8;
  }

  // Plain object – iterate own enumerable properties
  let total = 16; // object header
  const keys = Object.keys(obj);
  for (const key of keys) {
    total += key.length * 2 + 16; // key string + property overhead
    total += _estimate((obj as Record<string, unknown>)[key], seen);
  }

  return total;
}
