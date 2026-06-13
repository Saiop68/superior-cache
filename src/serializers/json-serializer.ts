/**
 * json-serializer.ts
 * 
 * The default serializer for SuperiorCache.
 * Uses standard JSON.stringify / JSON.parse for maximum compatibility.
 * 
 * Pros:
 *  - Human-readable when inspecting Redis keys
 *  - No additional dependencies
 *  - Wide compatibility
 * 
 * Cons:
 *  - Larger payload sizes compared to binary formats
 *  - Slower than MessagePack for large objects
 *  - Cannot serialize Buffers, Dates, Maps, Sets natively
 */

import type { Serializer } from "../types/serializer";



/**
 * Serializer implementation using JSON.
 * 
 * Values are converted to JSON strings and then to UTF-8 buffers.
 * This is the safest choice for most applications.
 */
export const jsonSerializer: Serializer = {
  name: "json",

  /**
   * Serialize a JavaScript value to a JSON-encoded UTF-8 Buffer.
   * 
   * @param value - Any JSON-serializable value.
   * @returns A Buffer containing the JSON representation.
   * @throws If the value contains circular references or non-serializable types.
   */
  serialize(value: unknown): Buffer {
    const json = JSON.stringify(value);
    return Buffer.from(json, "utf-8");
  },

  /**
   * Deserialize a JSON-encoded UTF-8 Buffer back into a JavaScript value.
   * 
   * @param data - A Buffer containing JSON data.
   * @returns The parsed JavaScript value.
   * @throws If the buffer does not contain valid JSON.
   */
  deserialize(data: Buffer): unknown {
    const json = data.toString("utf-8");
    return JSON.parse(json);
  },
};
