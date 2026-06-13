/**
 * logger.ts
 * 
 * A tiny structured logger for SuperiorCache internals.
 * 
 * All log output goes through this module so we have a single
 * place to enable/disable debug logging, add prefixes, and
 * potentially swap out the backing logger in the future.
 * 
 * Production logs use `console.warn` / `console.error`.
 * Debug logs (guarded by `enabled`) use `console.log`.
 */



export class Logger {
  /** The prefix prepended to every log line. */
  private readonly prefix: string;

  /** Whether debug-level logging is enabled. */
  private enabled: boolean;

  /**
   * Create a new Logger instance.
   * @param prefix - A short label for the component (e.g. "MemoryLayer").
   * @param debug  - Whether to emit debug-level messages (default: false).
   */
  constructor(prefix: string, debug: boolean = false) {
    this.prefix = `[SuperiorCache:${prefix}]`;
    this.enabled = debug;
  }

  /**
   * Toggle debug logging on or off at runtime.
   * Useful for enabling diagnostics in production without a restart.
   * @param on - Whether debug mode should be enabled.
   */
  setDebug(on: boolean): void {
    this.enabled = on;
  }

  /**
   * Emit a debug-level message.
   * Only prints when debug mode is enabled.
   * @param message - The message to log.
   * @param args    - Additional values to print after the message.
   */
  debug(message: string, ...args: unknown[]): void {
    if (this.enabled) {
      console.log(`${this.prefix} ${message}`, ...args);
    }
  }

  /**
   * Emit an informational message.
   * Always printed regardless of debug mode.
   * @param message - The message to log.
   * @param args    - Additional values to print after the message.
   */
  info(message: string, ...args: unknown[]): void {
    console.log(`${this.prefix} ${message}`, ...args);
  }

  /**
   * Emit a warning message.
   * Always printed. Use for non-fatal issues that operators should know about.
   * @param message - The message to log.
   * @param args    - Additional values to print after the message.
   */
  warn(message: string, ...args: unknown[]): void {
    console.warn(`${this.prefix} ⚠ ${message}`, ...args);
  }

  /**
   * Emit an error message.
   * Always printed. Use for failures that need attention.
   * @param message - The message to log.
   * @param args    - Additional values to print after the message.
   */
  error(message: string, ...args: unknown[]): void {
    console.error(`${this.prefix} ✖ ${message}`, ...args);
  }
}
