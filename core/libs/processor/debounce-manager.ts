/**
 * Debounce manager for job/message processing (used by Remq handler options).
 *
 * @module
 */
/**
 * Manages debouncing of message processing. Tracks recently processed messages to prevent duplicates.
 */
export class DebounceManager {
  private readonly windowMs: number;
  private readonly keyFn: (
    message: { id: string; data?: unknown; [key: string]: unknown },
  ) => string;
  private readonly processedKeys = new Map<string, number>();

  /**
   * Create a debounce manager with a time window and optional key function.
   * @param windowSeconds - Debounce window in seconds; same key within this window is skipped
   * @param keyFn - Optional function to derive a debounce key from the message (default: message.id)
   */
  constructor(
    windowSeconds: number,
    keyFn?: (
      message: { id: string; data?: unknown; [key: string]: unknown },
    ) => string,
  ) {
    this.windowMs = windowSeconds * 1000;
    this.keyFn = keyFn || ((msg) => msg.id);
  }

  /**
   * Checks if message should be processed (not debounced)
   * Returns true if message should be processed, false if debounced
   */
  shouldProcess(
    message: { id: string; data?: unknown; [key: string]: unknown },
  ): boolean {
    const key = this.keyFn(message);
    const lastProcessed = this.processedKeys.get(key);

    if (lastProcessed === undefined) {
      // Never processed, allow it
      return true;
    }

    const now = Date.now();
    const elapsed = now - lastProcessed;

    if (elapsed >= this.windowMs) {
      // Window expired, allow processing and update timestamp
      this.processedKeys.set(key, now);
      return true;
    }

    // Still within debounce window
    return false;
  }

  /**
   * Marks a message as processed (updates debounce timestamp)
   */
  markProcessed(
    message: { id: string; data?: unknown; [key: string]: unknown },
  ): void {
    const key = this.keyFn(message);
    this.processedKeys.set(key, Date.now());
  }

  /**
   * Cleans up old entries (entries older than 2x window)
   */
  cleanup(): void {
    const now = Date.now();
    const maxAge = this.windowMs * 2;

    for (const [key, timestamp] of this.processedKeys.entries()) {
      if (now - timestamp > maxAge) {
        this.processedKeys.delete(key);
      }
    }
  }

  /**
   * Gets the number of tracked keys
   */
  get size(): number {
    return this.processedKeys.size;
  }
}
