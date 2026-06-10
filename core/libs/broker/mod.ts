/**
 * Broker — generic Redis pub/sub primitive. Fire-and-forget fan-out,
 * deliberately separate from Hound's durable job execution:
 *
 *   Broker — real-time events to whoever is listening right now. No
 *            persistence, no retry, no replay. A crashed subscriber simply
 *            misses messages. Raw speed, zero state.
 *   Hound  — durable jobs. Survives crashes, retries, reaps.
 *
 * The two do not overlap; pick per use case, not per project.
 *
 * Owns the single subscriber dispatcher (registered once), the
 * channel → listeners registry, and the ref-counted subscribe/unsubscribe
 * lifecycle: the first listener on a channel subscribes it on Redis, the
 * last one leaving unsubscribes it.
 *
 * Works with ioredis (pass the main connection as `pub`; the subscriber is
 * created via `duplicate()` since a Redis connection in subscriber mode
 * cannot run normal commands) and with InMemoryStorage for tests.
 *
 * @example
 * const broker = new Broker({ pub: redis });
 * const unsub = broker.subscribe<Booking>('bookings:org:42', (b) => render(b));
 * broker.publish('bookings:org:42', booking); // fire-and-forget
 *
 * @module
 */

/** Channel Hound publishes job-finished events on when given a broker. */
export const JOB_FINISHED_CHANNEL = 'hound:job.finished';

/**
 * Connection surface the Broker needs — satisfied by ioredis Redis and
 * InMemoryStorage. `duplicate` is used to derive the subscriber connection
 * when `sub` is not passed explicitly.
 */
export interface BrokerConnection {
  publish(channel: string, message: string): Promise<unknown> | unknown;
  subscribe(...channels: string[]): Promise<unknown> | unknown;
  unsubscribe(...channels: string[]): Promise<unknown> | unknown;
  on(
    event: 'message',
    cb: (channel: string, message: string) => void,
  ): unknown;
  duplicate?(): BrokerConnection;
}

export class Broker {
  readonly #pub: BrokerConnection;
  readonly #sub: BrokerConnection;
  readonly #listeners = new Map<string, Set<(payload: unknown) => void>>();
  #dispatcherRegistered = false;

  constructor(options: { pub: BrokerConnection; sub?: BrokerConnection }) {
    this.#pub = options.pub;
    this.#sub = options.sub ?? options.pub.duplicate?.() ?? options.pub;
  }

  /**
   * Fire-and-forget publish. Payload is JSON-serialized. Serialization and
   * transport errors are swallowed — the broker must never poison the write
   * path that called it. Durable delivery belongs to Hound, not here.
   */
  publish(channel: string, payload: unknown): void {
    let message: string;
    try {
      message = JSON.stringify(payload);
    } catch {
      return; // non-serializable payload — drop
    }
    try {
      Promise.resolve(this.#pub.publish(channel, message)).catch(() => {});
    } catch { /* transport threw synchronously — drop */ }
  }

  /**
   * Subscribe to a channel. Returns an unsubscribe function. The Redis
   * subscription is ref-counted: created on the first listener for the
   * channel, torn down when the last one leaves.
   */
  subscribe<T = unknown>(
    channel: string,
    cb: (payload: T) => void,
  ): () => void {
    this.#ensureDispatcher();

    let set = this.#listeners.get(channel);
    if (!set) {
      set = new Set();
      this.#listeners.set(channel, set);
      try {
        Promise.resolve(this.#sub.subscribe(channel)).catch(() => {});
      } catch {
        /* transport threw synchronously — listeners stay registered */
      }
    }
    const listener = cb as (payload: unknown) => void;
    set.add(listener);

    return () => {
      const listeners = this.#listeners.get(channel);
      if (!listeners) return;
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.#listeners.delete(channel);
        try {
          Promise.resolve(this.#sub.unsubscribe(channel)).catch(() => {});
        } catch { /* ignore */ }
      }
    };
  }

  /** Register the single 'message' dispatcher on the subscriber connection. */
  #ensureDispatcher(): void {
    if (this.#dispatcherRegistered) return;
    this.#dispatcherRegistered = true;
    this.#sub.on('message', (channel, message) => {
      const listeners = this.#listeners.get(channel);
      if (!listeners?.size) return;
      let payload: unknown;
      try {
        payload = JSON.parse(message);
      } catch {
        return; // foreign / malformed message on the channel — ignore
      }
      for (const cb of [...listeners]) {
        try {
          cb(payload);
        } catch (err) {
          console.error('[hound] broker listener error:', err);
        }
      }
    });
  }
}
