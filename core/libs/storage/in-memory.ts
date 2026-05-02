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
        results.push([err instanceof Error ? err : new Error(String(err)), null]);
      }
    }
    return results;
  }
}

export class InMemoryStorage {
  readonly #kv = new Map<string, KvEntry>();
  readonly #zsets = new Map<string, ZEntry[]>();

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
    if (!this.#zsets.has(key)) this.#zsets.set(key, []);
    const z = this.#zsets.get(key)!;
    const idx = z.findIndex((e) => e.member === member);
    if (idx !== -1) {
      z[idx].score = score;
      this.#sort(z);
      return 0;
    }
    z.push({ score, member });
    this.#sort(z);
    return 1;
  }

  async zrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
  ): Promise<string[]> {
    const z = this.#zsets.get(key) ?? [];
    const lo = min === '-inf' ? -Infinity : Number(min);
    const hi = max === '+inf' ? Infinity : Number(max);
    return z.filter((e) => e.score >= lo && e.score <= hi).map((e) => e.member);
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    const z = this.#zsets.get(key);
    if (!z) return 0;
    let n = 0;
    for (const m of members) {
      const idx = z.findIndex((e) => e.member === m);
      if (idx !== -1) { z.splice(idx, 1); n++; }
    }
    return n;
  }

  async zcard(key: string): Promise<number> {
    return this.#zsets.get(key)?.length ?? 0;
  }

  async zscore(key: string, member: string): Promise<string | null> {
    const entry = this.#zsets.get(key)?.find((e) => e.member === member);
    return entry !== undefined ? String(entry.score) : null;
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

    if (!this.#zsets.has(pKey)) this.#zsets.set(pKey, []);
    const q = this.#zsets.get(qKey) ?? [];
    const p = this.#zsets.get(pKey)!;

    const ready = q.filter((e) => e.score <= now).slice(0, count);
    if (!ready.length) return [];

    const claimed: string[] = [];
    for (const entry of ready) {
      const idx = q.findIndex((e) => e.member === entry.member);
      if (idx !== -1) q.splice(idx, 1);
      p.push({ score: claimedAt, member: entry.member });
      claimed.push(entry.member);
    }
    this.#sort(p);
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

  // ─── Pipeline / Multi ──────────────────────────────────────────────────────

  pipeline(): InMemoryPipeline {
    return new InMemoryPipeline(this);
  }

  multi(): InMemoryPipeline {
    return new InMemoryPipeline(this);
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

  // ─── Internals ─────────────────────────────────────────────────────────────

  #sort(z: ZEntry[]): void {
    z.sort((a, b) => a.score - b.score || (a.member < b.member ? -1 : 1));
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
