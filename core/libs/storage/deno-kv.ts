/**
 * DenoKvStorage — Deno KV backend for hound.
 *
 * Implements StorageClient using Deno.Kv:
 *   KV:          get / set (with EX + NX) / del
 *   Sorted sets: zadd / zrangebyscore / zrem / zcard / zscore
 *   Batch:       eval (claim Lua) / scan / pipeline
 *
 * Key schema:
 *   ["kv",   redisKey]          → string value
 *   ["zset", setKey, member]    → score (number)
 *
 * @module
 */

class DenoKvPipeline {
  readonly #store: DenoKvStorage;
  readonly #ops: Array<() => Promise<unknown>> = [];

  constructor(store: DenoKvStorage) {
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
        results.push([err instanceof Error ? err : new Error(String(err)), null]);
      }
    }
    return results;
  }
}

/**
 * Atomic transaction — backed by Deno KV's native `kv.atomic()`. All staged
 * ops commit in a single atomic operation or none commit. Mirrors Redis
 * MULTI/EXEC semantics for the Deno KV backend.
 */
class DenoKvTransaction {
  readonly #kv: Deno.Kv;
  readonly #ops: Array<{ apply: (a: Deno.AtomicOperation) => void }> = [];

  constructor(kv: Deno.Kv) {
    this.#kv = kv;
  }

  // deno-lint-ignore no-explicit-any
  set(key: string, value: string, ...args: any[]): this {
    let ttlMs: number | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === 'EX') ttlMs = Number(args[++i]) * 1000;
      else if (args[i] === 'PX') ttlMs = Number(args[++i]);
    }
    const opts: { expireIn?: number } = {};
    if (ttlMs !== undefined) opts.expireIn = ttlMs;
    this.#ops.push({ apply: (a) => a.set(['kv', key], value, opts) });
    return this;
  }

  del(...keys: string[]): this {
    for (const key of keys) {
      this.#ops.push({ apply: (a) => a.delete(['kv', key]) });
    }
    return this;
  }

  zadd(key: string, score: number, member: string): this {
    this.#ops.push({ apply: (a) => a.set(['zset', key, member], score) });
    return this;
  }

  zrem(key: string, ...members: string[]): this {
    for (const member of members) {
      this.#ops.push({ apply: (a) => a.delete(['zset', key, member]) });
    }
    return this;
  }

  async exec(): Promise<[Error | null, unknown][]> {
    const atomic = this.#kv.atomic();
    for (const op of this.#ops) op.apply(atomic);
    const result = await atomic.commit();
    if (!result.ok) {
      throw new Error('DenoKv atomic transaction failed to commit');
    }
    // All ops committed atomically — return shape compatible with ioredis multi().exec()
    return this.#ops.map(() => [null, 'OK'] as [Error | null, unknown]);
  }
}

export class DenoKvStorage {
  readonly #kv: Deno.Kv;

  constructor(kv: Deno.Kv) {
    this.#kv = kv;
  }

  /** Open a Deno KV store. Pass a file path for persistence; omit for the default location. */
  static async open(path?: string): Promise<DenoKvStorage> {
    const kv = await Deno.openKv(path);
    return new DenoKvStorage(kv);
  }

  // ─── KV ────────────────────────────────────────────────────────────────────

  async get(key: string): Promise<string | null> {
    const entry = await this.#kv.get<string>(['kv', key]);
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

    const kvKey: Deno.KvKey = ['kv', key];
    const opts: { expireIn?: number } = {};
    if (ttlMs !== undefined) opts.expireIn = ttlMs;

    if (nx) {
      const existing = await this.#kv.get<string>(kvKey);
      if (existing.value !== null) return null;
      const res = await this.#kv.atomic()
        .check({ key: kvKey, versionstamp: existing.versionstamp })
        .set(kvKey, value, opts)
        .commit();
      return res.ok ? 'OK' : null;
    }

    await this.#kv.set(kvKey, value, opts);
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const key of keys) {
      const kvEntry = await this.#kv.get(['kv', key]);
      if (kvEntry.value !== null) {
        await this.#kv.delete(['kv', key]);
        n++;
      }
      let hadMembers = false;
      for await (const entry of this.#kv.list({ prefix: ['zset', key] })) {
        await this.#kv.delete(entry.key);
        hadMembers = true;
      }
      if (hadMembers) n++;
    }
    return n;
  }

  // ─── Sorted sets ───────────────────────────────────────────────────────────

  async zadd(key: string, score: number, member: string): Promise<number> {
    const kvKey: Deno.KvKey = ['zset', key, member];
    const existing = await this.#kv.get<number>(kvKey);
    await this.#kv.set(kvKey, score);
    return existing.value !== null ? 0 : 1;
  }

  async zrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
  ): Promise<string[]> {
    const lo = min === '-inf' ? -Infinity : Number(min);
    const hi = max === '+inf' ? Infinity : Number(max);
    const results: { score: number; member: string }[] = [];

    for await (const entry of this.#kv.list<number>({ prefix: ['zset', key] })) {
      const score = entry.value;
      if (score >= lo && score <= hi) {
        results.push({ score, member: entry.key[2] as string });
      }
    }

    results.sort((a, b) => a.score - b.score || (a.member < b.member ? -1 : 1));
    return results.map((e) => e.member);
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    let n = 0;
    for (const member of members) {
      const existing = await this.#kv.get(['zset', key, member]);
      if (existing.value !== null) {
        await this.#kv.delete(['zset', key, member]);
        n++;
      }
    }
    return n;
  }

  async zcard(key: string): Promise<number> {
    let n = 0;
    for await (const _ of this.#kv.list({ prefix: ['zset', key] })) n++;
    return n;
  }

  async zscore(key: string, member: string): Promise<string | null> {
    const entry = await this.#kv.get<number>(['zset', key, member]);
    return entry.value !== null ? String(entry.value) : null;
  }

  // ─── Eval — implements only the QueueStore claim Lua pattern ───────────────

  // deno-lint-ignore no-explicit-any
  async eval(_script: string, _numkeys: number, ...args: any[]): Promise<unknown> {
    // Matches CLAIM_SCRIPT args: qKey, pKey, now, count, claimedAt
    const qKey = String(args[0]);
    const pKey = String(args[1]);
    const now = Number(args[2]);
    const count = Number(args[3]);
    const claimedAt = Number(args[4]);

    const ready: { score: number; member: string }[] = [];
    for await (const entry of this.#kv.list<number>({ prefix: ['zset', qKey] })) {
      if (entry.value <= now) {
        ready.push({ score: entry.value, member: entry.key[2] as string });
      }
    }

    if (!ready.length) return [];

    ready.sort((a, b) => a.score - b.score);

    const claimed: string[] = [];
    for (const { member } of ready.slice(0, count)) {
      await this.#kv.delete(['zset', qKey, member]);
      await this.#kv.set(['zset', pKey, member], claimedAt);
      claimed.push(member);
    }

    return claimed;
  }

  // ─── Scan — full pass, cursor always '0' (Deno KV has no cursor API) ───────

  async scan(
    _cursor: string | number,
    _matchFlag: 'MATCH',
    pattern: string,
    _countFlag: 'COUNT',
    _count: number,
  ): Promise<[string, string[]]> {
    const re = this.#glob(pattern);
    const keys = new Set<string>();

    for await (const entry of this.#kv.list<unknown>({ prefix: ['kv'] })) {
      const key = entry.key[1] as string;
      if (re.test(key)) keys.add(key);
    }

    for await (const entry of this.#kv.list<unknown>({ prefix: ['zset'] })) {
      const key = entry.key[1] as string;
      if (re.test(key)) keys.add(key);
    }

    return ['0', [...keys]];
  }

  // ─── Pipeline / Multi ──────────────────────────────────────────────────────

  pipeline(): DenoKvPipeline {
    return new DenoKvPipeline(this);
  }

  multi(): DenoKvTransaction {
    return new DenoKvTransaction(this.#kv);
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  disconnect(): void {
    this.#kv.close();
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  #glob(pattern: string): RegExp {
    const re = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${re}$`);
  }
}
