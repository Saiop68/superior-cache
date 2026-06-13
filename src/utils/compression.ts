/**
 * compression.ts
 * 
 * Provides transparent compression and decompression for cached values.
 * 
 * Large values (above a configurable threshold) are compressed with
 * gzip before being stored in Redis, reducing network bandwidth and
 * storage costs.  The memory layer stores uncompressed values for speed.
 * 
 * Compressed buffers are prefixed with a magic byte (0x1F) so the
 * deserializer can detect whether decompression is needed.
 */

import { gzipSync, gunzipSync } from "zlib";
import { Logger } from "./logger";



/** Default minimum size (bytes) before compression is applied. */
const DEFAULT_THRESHOLD = 1024;

/** Gzip magic bytes – used to detect compressed data. */
const GZIP_MAGIC_BYTE_1 = 0x1f;
const GZIP_MAGIC_BYTE_2 = 0x8b;



/**
 * Handles conditional compression and decompression of Buffer data.
 * 
 * Usage:
 * ```ts
 * const compressor = new Compressor({ enabled: true, thresholdBytes: 1024 });
 * const compressed = compressor.compress(largeBuffer);
 * const original   = compressor.decompress(compressed);
 * ```
 */
export class Compressor {
  /** Whether compression is enabled. */
  private readonly enabled: boolean;

  /** Minimum buffer size (bytes) before compression kicks in. */
  private readonly threshold: number;

  /** Logger instance for diagnostics. */
  private readonly log: Logger;

  /**
   * Create a new Compressor.
   * @param options.enabled        - Whether to enable compression.
   * @param options.thresholdBytes - Minimum size before compressing.
   * @param options.debug          - Enable debug logging.
   */
  constructor(options: {
    enabled?: boolean;
    thresholdBytes?: number;
    debug?: boolean;
  } = {}) {
    this.enabled = options.enabled ?? false;
    this.threshold = options.thresholdBytes ?? DEFAULT_THRESHOLD;
    this.log = new Logger("Compressor", options.debug);
  }

  /**
   * Optionally compress a buffer.
   * 
   * If compression is disabled or the buffer is smaller than the
   * threshold, the buffer is returned unchanged.
   * 
   * @param data - The raw serialized buffer.
   * @returns The (possibly compressed) buffer.
   */
  compress(data: Buffer): Buffer {
    if (!this.enabled) {
      return data;
    }

    if (data.length < this.threshold) {
      this.log.debug(`Skipping compression (${data.length}B < ${this.threshold}B threshold)`);
      return data;
    }

    const compressed = gzipSync(data);

    this.log.debug(
      `Compressed ${data.length}B → ${compressed.length}B ` +
      `(${((1 - compressed.length / data.length) * 100).toFixed(1)}% reduction)`
    );

    return compressed;
  }

  /**
   * Decompress a buffer if it appears to be gzip-compressed.
   * 
   * Detection is based on the gzip magic bytes (0x1F 0x8B).
   * If the buffer is not compressed, it is returned unchanged.
   * 
   * @param data - The (possibly compressed) buffer.
   * @returns The decompressed buffer.
   */
  decompress(data: Buffer): Buffer {
    if (!this.isCompressed(data)) {
      return data;
    }

    const decompressed = gunzipSync(data);

    this.log.debug(
      `Decompressed ${data.length}B → ${decompressed.length}B`
    );

    return decompressed;
  }

  /**
   * Check whether a buffer starts with the gzip magic bytes,
   * indicating it was compressed by this module.
   * 
   * @param data - Buffer to inspect.
   * @returns `true` if the buffer appears gzip-compressed.
   */
  private isCompressed(data: Buffer): boolean {
    return (
      data.length >= 2 &&
      data[0] === GZIP_MAGIC_BYTE_1 &&
      data[1] === GZIP_MAGIC_BYTE_2
    );
  }
}
