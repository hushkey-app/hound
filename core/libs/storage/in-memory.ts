/**
 * InMemoryStorage — drop-in replacement for ioredis when Redis is not available.
 *
 * Implements the StorageClient interface used throughout hound:
 *   KV:          get / set (with EX + NX) / del
 *   Sorted sets: zadd / zrangebyscore / zrem / zcard / zscore
 *   Batch:       eval (claim Lua) / scan / pipeline
 *
 * TTL is enforced lazily on read — no background sweep needed.
 * Sorted set ties are broken lexicographically, matching Redis behaviour.
 *
 * @module
 */

interface KvEntry {
  value: string;
  expiresAt?: number;
}

interface ZEntry {
  score: number;
  member: string;
}

class InMemoryPipeline {
  readonly #store: InMemoryStorage;
  readonly #ops: Array<() => Promise<unknown>> = [];

  constructor(store: InMemoryStorage) {
    this.#store = store;
  }

  get(key: string): this {
    this.#ops.push(() => this.#store.get(key));
    return this;
  }

  // deno-lint-ignore no-explicit-any
  set(key: string, value: string, ...args: any[]): this {
    this.#ops.push(() => this.#store.set(key, value, ...args));
    return this;
  }

  del(...keys: string[]): this {
    this.#ops.push(() => this.#store.del(...keys));
    return this;
  }

  zrem(key: string, ...members: string[]): this {
    this.#ops.push(() => this.#store.zrem(key, ...members));
    return this;
  }

  zadd(key: string, score: number, member: string): this {
    this.#ops.push(() => this.#store.zadd(key, score, member));
    return this;
  }

  async exec(): Promise<[Error | null, unknown][]> {
    const results: [Error | null, unknown][] = [];
    for (const op of this.#ops) {
      try {
        results.push([null, await op()]);
      } catch (err) {
        results.push([
          err instanceof Error ? err : new Error(String(err)),
          null,
        ]);
      }
    }
    return results;
  }
}

/**
 * Atomic transaction — all-or-nothing. Snapshots store state before exec;
 * if any op throws, restores the snapshot and re-throws. Mirrors Redis
 * MULTI/EXEC semantics for the in-memory backend.
 */
class InMemoryTransaction {
  readonly #store: InMemoryStorage;
  readonly #ops: Array<() => Promise<unknown>> = [];

  constructor(store: InMemoryStorage) {
    this.#store = store;
  }

  // deno-lint-ignore no-explicit-any
  set(key: string, value: string, ...args: any[]): this {
    this.#ops.push(() => this.#store.set(key, value, ...args));
    return this;
  }

  del(...keys: string[]): this {
    this.#ops.push(() => this.#store.del(...keys));
    return this;
  }

  zrem(key: string, ...members: string[]): this {
    this.#ops.push(() => this.#store.zrem(key, ...members));
    return this;
  }

  zadd(key: string, score: number, member: string): this {
    this.#ops.push(() => this.#store.zadd(key, score, member));
    return this;
  }

  async exec(): Promise<[Error | null, unknown][]> {
    const snapshot = this.#store._snapshot();
    const results: [Error | null, unknown][] = [];
    try {
      for (const op of this.#ops) {
        results.push([null, await op()]);
      }
      return results;
    } catch (err) {
      this.#store._restore(snapshot);
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
}

interface ZSet {
  map: Map<string, number>;
  /** Lazily materialized score-sorted view — invalidated on every write. */
  sorted: ZEntry[] | null;
}

export class InMemoryStorage {
  readonly #kv = new Map<string, KvEntry>();
  readonly #zsets = new Map<string, ZSet>();

  // ─── KV ────────────────────────────────────────────────────────────────────

  async get(key: string): Promise<string | null> {
    const entry = this.#kv.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
      this.#kv.delete(key);
      return null;
    }
    return entry.value;
  }

  // deno-lint-ignore no-explicit-any
  async set(key: string, value: string, ...args: any[]): Promise<'OK' | null> {
    let ttlMs: number | undefined;
    let nx = false;

    for (let i = 0; i < args.length; i++) {
      if (args[i] === 'EX') ttlMs = Number(args[++i]) * 1000;
      if (args[i] === 'PX') ttlMs = Number(args[++i]);
      if (args[i] === 'NX') nx = true;
    }

    if (nx && (await this.get(key)) !== null) return null;

    this.#kv.set(key, {
      value,
      expiresAt: ttlMs !== undefined ? Date.now() + ttlMs : undefined,
    });
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) {
      if (this.#kv.delete(k)) n++;
      if (this.#zsets.delete(k)) n++;
    }
    return n;
  }

  // ─── Sorted sets ───────────────────────────────────────────────────────────

  async zadd(key: string, score: number, member: string): Promise<number> {
    const z = this.#z(key);
    const existed = z.map.has(member);
    z.map.set(member, score);
    z.sorted = null;
    return existed ? 0 : 1;
  }

  async zrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
    withScores?: 'WITHSCORES',
  ): Promise<string[]> {
    const z = this.#zsets.get(key);
    if (!z) return [];
    const lo = min === '-inf' ? -Infinity : Number(min);
    const hi = max === '+inf' ? Infinity : Number(max);
    const hits = this.#sortedView(z).filter((e) =>
      e.score >= lo && e.score <= hi
    );
    if (withScores === 'WITHSCORES') {
      return hits.flatMap((e) => [e.member, String(e.score)]);
    }
    return hits.map((e) => e.member);
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    const z = this.#zsets.get(key);
    if (!z) return 0;
    let n = 0;
    for (const m of members) {
      if (z.map.delete(m)) n++;
    }
    if (n) z.sorted = null;
    return n;
  }

  async zremrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
  ): Promise<number> {
    const z = this.#zsets.get(key);
    if (!z) return 0;
    const lo = min === '-inf' ? -Infinity : Number(min);
    const hi = max === '+inf' ? Infinity : Number(max);
    let n = 0;
    for (const [member, score] of z.map) {
      if (score >= lo && score <= hi) {
        z.map.delete(member);
        n++;
      }
    }
    if (n) z.sorted = null;
    return n;
  }

  async zcard(key: string): Promise<number> {
    return this.#zsets.get(key)?.map.size ?? 0;
  }

  async zscore(key: string, member: string): Promise<string | null> {
    const score = this.#zsets.get(key)?.map.get(member);
    return score !== undefined ? String(score) : null;
  }

  // ─── Eval — implements only the QueueStore claim Lua pattern ───────────────

  // deno-lint-ignore no-explicit-any
  async eval(
    _script: string,
    _numkeys: number,
    ...args: any[]
  ): Promise<unknown> {
    // Matches CLAIM_SCRIPT args: qKey, pKey, now, count, claimedAt
    const qKey = String(args[0]);
    const pKey = String(args[1]);
    const now = Number(args[2]);
    const count = Number(args[3]);
    const claimedAt = Number(args[4]);

    const q = this.#zsets.get(qKey);
    if (!q) return [];
    const p = this.#z(pKey);

    // Sorted view so the oldest-scored jobs are claimed first, like the Lua script.
    const ready = this.#sortedView(q)
      .filter((e) => e.score <= now)
      .slice(0, count);
    if (!ready.length) return [];

    const claimed: string[] = [];
    for (const entry of ready) {
      q.map.delete(entry.member);
      p.map.set(entry.member, claimedAt);
      claimed.push(entry.member);
    }
    q.sorted = null;
    p.sorted = null;
    return claimed;
  }

  // ─── Scan — returns all matching keys in one pass (cursor always '0') ──────

  async scan(
    _cursor: string | number,
    _matchFlag: 'MATCH',
    pattern: string,
    _countFlag: 'COUNT',
    _count: number,
  ): Promise<[string, string[]]> {
    const re = this.#glob(pattern);
    const kvKeys = [...this.#kv.keys()].filter((k) => re.test(k));
    const zKeys = [...this.#zsets.keys()].filter((k) => re.test(k));
    return ['0', [...new Set([...kvKeys, ...zKeys])]];
  }

  // ─── Pub/Sub — in-process delivery, used by Broker in tests ────────────────

  readonly #subscribedChannels = new Set<string>();
  readonly #messageListeners = new Set<
    (channel: string, message: string) => void
  >();

  async publish(channel: string, message: string): Promise<number> {
    if (!this.#subscribedChannels.has(channel)) return 0;
    const listeners = [...this.#messageListeners];
    // Deliver async like a real transport would — callers must not rely on
    // synchronous delivery.
    queueMicrotask(() => {
      for (const cb of listeners) cb(channel, message);
    });
    return listeners.length;
  }

  async subscribe(...channels: string[]): Promise<void> {
    for (const ch of channels) this.#subscribedChannels.add(ch);
  }

  async unsubscribe(...channels: string[]): Promise<void> {
    for (const ch of channels) this.#subscribedChannels.delete(ch);
  }

  on(event: 'message', cb: (channel: string, message: string) => void): this {
    if (event === 'message') this.#messageListeners.add(cb);
    return this;
  }

  /** Pub and sub share the same in-process registry — return self. */
  duplicate(): this {
    return this;
  }

  // ─── Pipeline / Multi ──────────────────────────────────────────────────────

  pipeline(): InMemoryPipeline {
    return new InMemoryPipeline(this);
  }

  multi(): InMemoryTransaction {
    return new InMemoryTransaction(this);
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  disconnect(): void {
    // no-op — nothing to close
  }

  /** Flush all data. Useful between tests. */
  flushAll(): void {
    this.#kv.clear();
    this.#zsets.clear();
  }

  // ─── Snapshot / restore — used by InMemoryTransaction for atomic exec ──────

  /** @internal */
  _snapshot(): {
    kv: Map<string, KvEntry>;
    zsets: Map<string, Map<string, number>>;
  } {
    const kv = new Map<string, KvEntry>();
    for (const [k, v] of this.#kv) kv.set(k, { ...v });
    const zsets = new Map<string, Map<string, number>>();
    for (const [k, v] of this.#zsets) zsets.set(k, new Map(v.map));
    return { kv, zsets };
  }

  /** @internal */
  _restore(
    snapshot: {
      kv: Map<string, KvEntry>;
      zsets: Map<string, Map<string, number>>;
    },
  ): void {
    this.#kv.clear();
    for (const [k, v] of snapshot.kv) this.#kv.set(k, v);
    this.#zsets.clear();
    for (const [k, v] of snapshot.zsets) {
      this.#zsets.set(k, { map: v, sorted: null });
    }
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  #z(key: string): ZSet {
    let z = this.#zsets.get(key);
    if (!z) {
      z = { map: new Map(), sorted: null };
      this.#zsets.set(key, z);
    }
    return z;
  }

  /**
   * Score-sorted view, materialized lazily. Writes are O(1) map ops; the
   * O(n log n) sort happens once per read-after-write instead of per zadd —
   * the difference between ~7k and ~40k jobs/s under benchmark load.
   */
  #sortedView(z: ZSet): ZEntry[] {
    if (!z.sorted) {
      z.sorted = [...z.map]
        .map(([member, score]) => ({ member, score }))
        .sort((a, b) => a.score - b.score || (a.member < b.member ? -1 : 1));
    }
    return z.sorted;
  }

  // Convert Redis glob (* / ?) to RegExp. Anchored to full key.
  #glob(pattern: string): RegExp {
    const re = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${re}$`);
  }
}
