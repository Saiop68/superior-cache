/**
 * serializer-factory.ts
 * 
 * Factory function that resolves a SerializerType (string or object)
 * into a concrete Serializer instance.
 * 
 * This allows users to specify serializers as simple strings:
 *   - "json"    → JSON serializer
 *   - "msgpack" → MessagePack serializer
 * 
 * Or pass a custom Serializer object directly.
 */

import type { Serializer, SerializerType } from "../types/serializer";
import { jsonSerializer } from "./json-serializer";
import { msgpackSerializer } from "./msgpack-serializer";



/**
 * Resolve a serializer type identifier into a concrete Serializer instance.
 * 
 * @param type - Either a built-in name ("json" | "msgpack") or a custom Serializer.
 * @returns A Serializer ready to use.
 * @throws If an unrecognised string is passed.
 * 
 * @example
 * ```ts
 * const s = resolveSerializer("json");     // jsonSerializer
 * const s = resolveSerializer("msgpack");  // msgpackSerializer
 * const s = resolveSerializer(myCustom);   // passthrough
 * ```
 */
export function resolveSerializer(type: SerializerType = "json"): Serializer {
  // If the user passed a custom Serializer object, use it directly
  if (typeof type !== "string") {
    return type;
  }

  // Otherwise resolve by name
  switch (type) {
    case "json":
      return jsonSerializer;

    case "msgpack":
      return msgpackSerializer;

    default:
      throw new Error(
        `Unknown serializer type: "${type}". ` +
        `Valid options are "json", "msgpack", or a custom Serializer object.`
      );
  }
}
