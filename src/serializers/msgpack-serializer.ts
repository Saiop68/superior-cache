/**
 * msgpack-serializer.ts
 * 
 * A high-performance binary serializer using MessagePack.
 * 
 * MessagePack produces smaller payloads and serializes/deserializes
 * faster than JSON for most data shapes.  It's the recommended
 * serializer for production use when human readability of Redis
 * keys is not required.
 * 
 * Uses the `msgpackr` library which is one of the fastest
 * MessagePack implementations for Node.js.
 * 
 * Pros:
 *  - Smaller payloads (typically 20-50% smaller than JSON)
 *  - Faster serialization / deserialization
 *  - Native Buffer support
 * 
 * Cons:
 *  - Binary format – not human-readable in Redis CLI
 *  - Requires the `msgpackr` dependency
 */

import { pack, unpack } from "msgpackr";
import type { Serializer } from "../types/serializer";



/**
 * Serializer implementation using MessagePack via `msgpackr`.
 */
export const msgpackSerializer: Serializer = {
  name: "msgpack",

  /**
   * Serialize a JavaScript value to a MessagePack-encoded Buffer.
   * 
   * @param value - Any value that msgpackr can encode.
   * @returns A Buffer containing the MessagePack representation.
   */
  serialize(value: unknown): Buffer {
    return pack(value);
  },

  /**
   * Deserialize a MessagePack-encoded Buffer back into a JavaScript value.
   * 
   * @param data - A Buffer containing MessagePack data.
   * @returns The decoded JavaScript value.
   */
  deserialize(data: Buffer): unknown {
    return unpack(data);
  },
};
