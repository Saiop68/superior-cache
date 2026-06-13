/**
 * serializer.ts
 * 
 * Type definitions for the pluggable serialization system.
 * SuperiorCache supports JSON, MessagePack, and custom serializers
 * so users can choose the best format for their data.
 */



/**
 * A serializer is responsible for converting JavaScript values to
 * a storable binary/string format and back again.
 * 
 * Built-in implementations:
 *  - "json"      – Standard JSON.stringify / JSON.parse (default)
 *  - "msgpack"   – MessagePack via the `msgpackr` package (faster, smaller)
 *  - custom      – Any object implementing this interface
 */
export interface Serializer {
  /** Human-readable name for logging / debugging. */
  readonly name: string;

  /**
   * Serialize a value into a Buffer suitable for storage.
   * @param value - The JavaScript value to serialize.
   * @returns A Buffer containing the serialized representation.
   */
  serialize(value: unknown): Buffer;

  /**
   * Deserialize a Buffer back into a JavaScript value.
   * @param data - The Buffer previously produced by `serialize`.
   * @returns The reconstructed JavaScript value.
   */
  deserialize(data: Buffer): unknown;
}



/**
 * Union type representing the valid serializer choices.
 * - "json"    – Built-in JSON serializer
 * - "msgpack" – Built-in MessagePack serializer
 * - Serializer – A custom implementation of the Serializer interface
 */
export type SerializerType = "json" | "msgpack" | Serializer;
