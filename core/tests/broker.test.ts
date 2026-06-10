/**
 * Broker tests — generic pub/sub primitive + Hound's cross-process
 * job-finished bridge. Runs against InMemoryStorage pub/sub, no Redis needed.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { Broker, JOB_FINISHED_CHANNEL } from '../libs/broker/mod.ts';
import { Hound } from '../libs/hound/mod.ts';
import { makeDb, sleep } from './helpers.ts';

Deno.test('Broker: publish/subscribe roundtrip', async () => {
  const db = makeDb();
  const broker = new Broker({ pub: db });
  const got: unknown[] = [];

  const unsub = broker.subscribe('ch1', (p) => got.push(p));
  broker.publish('ch1', { a: 1 });
  await sleep(10);

  assertEquals(got, [{ a: 1 }]);
  unsub();
});

Deno.test('Broker: listeners only receive their own channel', async () => {
  const db = makeDb();
  const broker = new Broker({ pub: db });
  const ch1: unknown[] = [];
  const ch2: unknown[] = [];

  const u1 = broker.subscribe('ch1', (p) => ch1.push(p));
  const u2 = broker.subscribe('ch2', (p) => ch2.push(p));
  broker.publish('ch1', 'one');
  broker.publish('ch2', 'two');
  await sleep(10);

  assertEquals(ch1, ['one']);
  assertEquals(ch2, ['two']);
  u1();
  u2();
});

Deno.test('Broker: unsubscribe stops delivery; last listener tears down the channel', async () => {
  const db = makeDb();
  const broker = new Broker({ pub: db });
  const got: unknown[] = [];

  const unsub = broker.subscribe('ch1', (p) => got.push(p));
  broker.publish('ch1', 1);
  await sleep(10);
  unsub();
  broker.publish('ch1', 2);
  await sleep(10);

  assertEquals(got, [1]);
});

Deno.test('Broker: ref-counting — channel stays live while any listener remains', async () => {
  const db = makeDb();
  const broker = new Broker({ pub: db });
  const a: unknown[] = [];
  const b: unknown[] = [];

  const unsubA = broker.subscribe('ch', (p) => a.push(p));
  const unsubB = broker.subscribe('ch', (p) => b.push(p));
  unsubA();
  broker.publish('ch', 'still-on');
  await sleep(10);

  assertEquals(a, []);
  assertEquals(b, ['still-on']);
  unsubB();
});

Deno.test('Broker: publish swallows transport errors (fire-and-forget)', () => {
  const broker = new Broker({
    pub: {
      publish: () => Promise.reject(new Error('redis down')),
      subscribe: () => {},
      unsubscribe: () => {},
      on: () => {},
    },
  });
  broker.publish('ch', { x: 1 }); // must not throw
});

Deno.test('Broker: non-serializable payload is dropped silently', () => {
  const db = makeDb();
  const broker = new Broker({ pub: db });
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  broker.publish('ch', circular); // must not throw
});

Deno.test('Broker: throwing listener does not break other listeners', async () => {
  const db = makeDb();
  const broker = new Broker({ pub: db });
  const got: unknown[] = [];

  const u1 = broker.subscribe('ch', () => {
    throw new Error('listener bug');
  });
  const u2 = broker.subscribe('ch', (p) => got.push(p));
  broker.publish('ch', 'ok');
  await sleep(10);

  assertEquals(got, ['ok']);
  u1();
  u2();
});

// ─── Hound × Broker: cross-process job-finished events ────────────────────────

Deno.test('remote job-finished event resolves a local emitAndWait waiter', async () => {
  Hound._reset();
  const db = makeDb();
  const broker = new Broker({ pub: db });
  const hound = Hound.create({
    db,
    broker,
    processor: { pollIntervalMs: 50, jobStateTtlSeconds: 60 },
  } as any);

  try {
    // Never started — the job can only finish "in another process".
    const waiting = hound.emitAndWait('remote.evt', {}, {
      id: 'remote-job-1',
      timeoutMs: 3000,
    });
    await sleep(10);
    // Simulate a worker in a different process announcing completion
    broker.publish(JOB_FINISHED_CHANNEL, {
      jobId: 'remote-job-1',
      queue: 'default',
      status: 'completed',
      __origin: 'some-other-process',
    });
    assertEquals(await waiting, 'remote-job-1');
  } finally {
    await hound.stop();
    Hound._reset();
  }
});

Deno.test('completed jobs are published to the broker with an origin tag', async () => {
  Hound._reset();
  const db = makeDb();
  const broker = new Broker({ pub: db });
  const hound = Hound.create({
    db,
    broker,
    concurrency: 10,
    processor: { pollIntervalMs: 50, jobStateTtlSeconds: 60 },
  } as any);

  try {
    const received: any[] = [];
    const unsub = broker.subscribe(
      JOB_FINISHED_CHANNEL,
      (p) => received.push(p),
    );

    hound.on('pub.evt', async () => {});
    await hound.start();
    const jobId = await hound.emitAndWait('pub.evt', {}, { timeoutMs: 3000 });
    await sleep(20);

    const event = received.find((p) => p.jobId === jobId);
    assert(event, 'job-finished event should be published');
    assertEquals(event.status, 'completed');
    assert(typeof event.__origin === 'string' && event.__origin.length > 0);
    unsub();
  } finally {
    await hound.stop();
    Hound._reset();
  }
});
