import { assertEquals } from 'jsr:@std/assert@1';
import { InMemoryStorage } from '../libs/storage/in-memory.ts';
import { QueueStore } from '../libs/consumer/queue-store.ts';

function makeStore() {
  const db = new InMemoryStorage();
  return { db, store: new QueueStore(db) };
}

Deno.test('QueueStore: enqueue adds job to queue sorted set', async () => {
  const { store, db } = makeStore();
  await store.enqueue('default', 'job1', Date.now());
  assertEquals(await db.zcard('queues:default:q'), 1);
});

Deno.test('QueueStore: claim moves ready jobs to processing', async () => {
  const { store, db } = makeStore();
  const past = Date.now() - 1000;
  await store.enqueue('default', 'job-a', past);
  await store.enqueue('default', 'job-b', past);

  const claimed = await store.claim('default', 10);
  assertEquals(new Set(claimed), new Set(['job-a', 'job-b']));
  assertEquals(await db.zcard('queues:default:q'), 0);
  assertEquals(await db.zcard('queues:default:processing'), 2);
});

Deno.test('QueueStore: claim skips future-scored jobs (delayed)', async () => {
  const { store } = makeStore();
  await store.enqueue('default', 'ready', Date.now() - 100);
  await store.enqueue('default', 'delayed', Date.now() + 99_999);

  const claimed = await store.claim('default', 10);
  assertEquals(claimed, ['ready']);
});

Deno.test('QueueStore: claim respects count argument', async () => {
  const { store } = makeStore();
  const past = Date.now() - 1;
  for (let i = 0; i < 5; i++) await store.enqueue('default', `job${i}`, past);

  const claimed = await store.claim('default', 3);
  assertEquals(claimed.length, 3);
});

Deno.test('QueueStore: claim returns empty when queue is empty', async () => {
  const { store } = makeStore();
  assertEquals(await store.claim('default', 10), []);
});

Deno.test('QueueStore: ack removes job from processing', async () => {
  const { store, db } = makeStore();
  await store.enqueue('default', 'job1', Date.now() - 1);
  await store.claim('default', 1);
  assertEquals(await db.zcard('queues:default:processing'), 1);

  await store.ack('default', 'job1');
  assertEquals(await db.zcard('queues:default:processing'), 0);
});

Deno.test('QueueStore: nack removes job from processing', async () => {
  const { store, db } = makeStore();
  await store.enqueue('default', 'job1', Date.now() - 1);
  await store.claim('default', 1);

  await store.nack('default', 'job1');
  assertEquals(await db.zcard('queues:default:processing'), 0);
});

Deno.test('QueueStore: requeue moves job from processing back to queue', async () => {
  const { store, db } = makeStore();
  await store.enqueue('default', 'job1', Date.now() - 1);
  await store.claim('default', 1);
  assertEquals(await db.zcard('queues:default:processing'), 1);

  await store.requeue('default', 'job1', Date.now() + 5000);
  assertEquals(await db.zcard('queues:default:processing'), 0);
  assertEquals(await db.zcard('queues:default:q'), 1);
});

Deno.test('QueueStore: queueLength reflects waiting + delayed jobs', async () => {
  const { store } = makeStore();
  assertEquals(await store.queueLength('default'), 0);
  await store.enqueue('default', 'a', Date.now() - 1);
  await store.enqueue('default', 'b', Date.now() + 9999);
  assertEquals(await store.queueLength('default'), 2);
});

Deno.test('QueueStore: stalledJobs returns jobs older than threshold', async () => {
  const { store, db } = makeStore();
  // Manually insert into processing set with different ages
  await db.zadd('queues:default:processing', Date.now() - 60_000, 'stalled');
  await db.zadd('queues:default:processing', Date.now() - 100, 'fresh');

  const stalled = await store.stalledJobs('default', 30_000);
  assertEquals(stalled, ['stalled']);
});

Deno.test('QueueStore: stalledJobs returns empty when none are stalled', async () => {
  const { store, db } = makeStore();
  await db.zadd('queues:default:processing', Date.now(), 'fresh');
  assertEquals(await store.stalledJobs('default', 30_000), []);
});

Deno.test('QueueStore: getJobData reads waiting and delayed state keys', async () => {
  const { store, db } = makeStore();
  const raw = JSON.stringify({
    id: 'j1',
    state: { name: 'evt', queue: 'default' },
  });
  await db.set('queues:default:j1:waiting', raw);

  const result = await store.getJobData('default', ['j1', 'missing']);
  assertEquals(result.get('j1'), raw);
  assertEquals(result.get('missing'), undefined);
});

Deno.test('QueueStore: getJobData prefers delayed state key', async () => {
  const { store, db } = makeStore();
  await db.set('queues:default:j1:waiting', 'waiting-data');
  await db.set('queues:default:j1:delayed', 'delayed-data');

  const result = await store.getJobData('default', ['j1']);
  // waiting is checked first, so it wins
  assertEquals(result.get('j1'), 'waiting-data');
});

Deno.test('QueueStore: getJobData falls back to processing state key (crash recovery)', async () => {
  const { store, db } = makeStore();
  // Worker crashed mid-job: state key already transitioned to :processing,
  // then the Reaper re-enqueued the jobId. The data must still be found.
  const raw = JSON.stringify({
    id: 'j1',
    state: { name: 'evt', queue: 'default' },
    status: 'processing',
  });
  await db.set('queues:default:j1:processing', raw);

  const result = await store.getJobData('default', ['j1']);
  assertEquals(result.get('j1'), raw);
});

Deno.test('QueueStore: deleteQueue removes both sorted sets', async () => {
  const { store, db } = makeStore();
  await store.enqueue('default', 'job1', Date.now() - 1);
  await store.claim('default', 1);
  assertEquals(await db.zcard('queues:default:q'), 0);
  assertEquals(await db.zcard('queues:default:processing'), 1);

  await store.deleteQueue('default');
  assertEquals(await db.zcard('queues:default:q'), 0);
  assertEquals(await db.zcard('queues:default:processing'), 0);
});
