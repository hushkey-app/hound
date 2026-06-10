import { assert, assertEquals } from 'jsr:@std/assert@1';
import { InMemoryStorage } from '../libs/storage/in-memory.ts';
import { sleep } from './helpers.ts';

// ─── KV ──────────────────────────────────────────────────────────────────────

Deno.test('InMemoryStorage: get returns null for missing key', async () => {
  const db = new InMemoryStorage();
  assertEquals(await db.get('missing'), null);
});

Deno.test('InMemoryStorage: set and get roundtrip', async () => {
  const db = new InMemoryStorage();
  await db.set('k', 'hello');
  assertEquals(await db.get('k'), 'hello');
  await db.set('k', 'world');
  assertEquals(await db.get('k'), 'world');
});

Deno.test('InMemoryStorage: set EX expires after TTL', async () => {
  const db = new InMemoryStorage();
  await db.set('k', 'v', 'PX', 20);
  assertEquals(await db.get('k'), 'v');
  await sleep(30);
  assertEquals(await db.get('k'), null);
});

Deno.test('InMemoryStorage: set EX using seconds', async () => {
  const db = new InMemoryStorage();
  await db.set('k', 'v', 'EX', 60);
  assertEquals(await db.get('k'), 'v'); // not expired yet
});

Deno.test('InMemoryStorage: set NX does not overwrite existing key', async () => {
  const db = new InMemoryStorage();
  await db.set('k', 'original');
  assertEquals(await db.set('k', 'new', 'NX'), null);
  assertEquals(await db.get('k'), 'original');
});

Deno.test('InMemoryStorage: set NX succeeds when key absent', async () => {
  const db = new InMemoryStorage();
  assertEquals(await db.set('k', 'v', 'NX'), 'OK');
  assertEquals(await db.get('k'), 'v');
});

Deno.test('InMemoryStorage: del removes kv key', async () => {
  const db = new InMemoryStorage();
  await db.set('a', '1');
  await db.set('b', '2');
  assertEquals(await db.del('a', 'b', 'gone'), 2);
  assertEquals(await db.get('a'), null);
  assertEquals(await db.get('b'), null);
});

// ─── Sorted sets ──────────────────────────────────────────────────────────────

Deno.test('InMemoryStorage: zadd / zscore', async () => {
  const db = new InMemoryStorage();
  await db.zadd('z', 10, 'a');
  assertEquals(await db.zscore('z', 'a'), '10');
  assertEquals(await db.zscore('z', 'missing'), null);
});

Deno.test('InMemoryStorage: zadd updates score on duplicate member', async () => {
  const db = new InMemoryStorage();
  await db.zadd('z', 1, 'a');
  await db.zadd('z', 5, 'a');
  assertEquals(await db.zscore('z', 'a'), '5');
  assertEquals(await db.zcard('z'), 1);
});

Deno.test('InMemoryStorage: zrangebyscore returns members in range, sorted', async () => {
  const db = new InMemoryStorage();
  await db.zadd('z', 3, 'c');
  await db.zadd('z', 1, 'a');
  await db.zadd('z', 5, 'b');
  assertEquals(await db.zrangebyscore('z', 1, 3), ['a', 'c']);
  assertEquals(await db.zrangebyscore('z', '-inf', '+inf'), ['a', 'c', 'b']);
  assertEquals(await db.zrangebyscore('z', 10, 20), []);
});

Deno.test('InMemoryStorage: zrem removes member', async () => {
  const db = new InMemoryStorage();
  await db.zadd('z', 1, 'a');
  await db.zadd('z', 2, 'b');
  assertEquals(await db.zrem('z', 'a'), 1);
  assertEquals(await db.zcard('z'), 1);
  assertEquals(await db.zscore('z', 'a'), null);
});

Deno.test('InMemoryStorage: zcard returns count', async () => {
  const db = new InMemoryStorage();
  assertEquals(await db.zcard('z'), 0);
  await db.zadd('z', 1, 'a');
  await db.zadd('z', 2, 'b');
  assertEquals(await db.zcard('z'), 2);
});

// ─── Eval (claim) ─────────────────────────────────────────────────────────────

Deno.test('InMemoryStorage: eval claim moves ready jobs to processing set', async () => {
  const db = new InMemoryStorage();
  const now = Date.now();
  await db.zadd('queues:q:q', now - 2000, 'job-a');
  await db.zadd('queues:q:q', now - 1000, 'job-b');
  await db.zadd('queues:q:q', now + 99999, 'future');

  const claimed = await db.eval(
    '',
    2,
    'queues:q:q',
    'queues:q:processing',
    now,
    10,
    now,
  ) as string[];
  assertEquals(new Set(claimed), new Set(['job-a', 'job-b']));
  assertEquals(await db.zcard('queues:q:q'), 1); // future remains
  assertEquals(await db.zcard('queues:q:processing'), 2);
});

Deno.test('InMemoryStorage: eval claim respects count limit', async () => {
  const db = new InMemoryStorage();
  const now = Date.now();
  for (let i = 0; i < 5; i++) await db.zadd('queues:q:q', now - i, `job${i}`);

  const claimed = await db.eval(
    '',
    2,
    'queues:q:q',
    'queues:q:processing',
    now,
    3,
    now,
  ) as string[];
  assertEquals(claimed.length, 3);
  assertEquals(await db.zcard('queues:q:q'), 2);
});

Deno.test('InMemoryStorage: eval claim returns empty when no ready jobs', async () => {
  const db = new InMemoryStorage();
  const now = Date.now();
  await db.zadd('queues:q:q', now + 99999, 'future');

  const claimed = await db.eval(
    '',
    2,
    'queues:q:q',
    'queues:q:processing',
    now,
    10,
    now,
  ) as string[];
  assertEquals(claimed, []);
  assertEquals(await db.zcard('queues:q:processing'), 0);
});

// ─── Pipeline ─────────────────────────────────────────────────────────────────

Deno.test('InMemoryStorage: pipeline executes all ops', async () => {
  const db = new InMemoryStorage();
  const pipe = db.pipeline();
  pipe.set('k1', 'v1');
  pipe.set('k2', 'v2');
  await pipe.exec();
  assertEquals(await db.get('k1'), 'v1');
  assertEquals(await db.get('k2'), 'v2');
});

Deno.test('InMemoryStorage: pipeline returns result per op', async () => {
  const db = new InMemoryStorage();
  await db.set('k', 'v');
  const pipe = db.pipeline();
  pipe.get('k');
  pipe.get('missing');
  const results = await pipe.exec();
  assertEquals(results[0][1], 'v');
  assertEquals(results[1][1], null);
});

Deno.test('InMemoryStorage: pipeline del + set transitions state key', async () => {
  const db = new InMemoryStorage();
  await db.set('old', 'data');
  const pipe = db.pipeline();
  pipe.del('old');
  pipe.set('new', 'data');
  await pipe.exec();
  assertEquals(await db.get('old'), null);
  assertEquals(await db.get('new'), 'data');
});

// ─── Scan ─────────────────────────────────────────────────────────────────────

Deno.test('InMemoryStorage: scan glob matches kv and zset keys', async () => {
  const db = new InMemoryStorage();
  await db.set('queues:a:state', '1');
  await db.zadd('queues:b:q', 1, 'x');
  await db.set('other:key', '2');

  const [cursor, keys] = await db.scan(0, 'MATCH', 'queues:*', 'COUNT', 100);
  assertEquals(cursor, '0');
  assertEquals(keys.length, 2);
  assert(keys.includes('queues:a:state'));
  assert(keys.includes('queues:b:q'));
});

Deno.test('InMemoryStorage: scan with no matches returns empty', async () => {
  const db = new InMemoryStorage();
  await db.set('other', '1');
  const [, keys] = await db.scan(0, 'MATCH', 'queues:*', 'COUNT', 100);
  assertEquals(keys, []);
});

// ─── flushAll ─────────────────────────────────────────────────────────────────

Deno.test('InMemoryStorage: flushAll clears all data', async () => {
  const db = new InMemoryStorage();
  await db.set('k', 'v');
  await db.zadd('z', 1, 'a');
  db.flushAll();
  assertEquals(await db.get('k'), null);
  assertEquals(await db.zcard('z'), 0);
});
