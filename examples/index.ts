import { broker, hound } from './plugins/hound.plugin.ts';
import { JOB_FINISHED_CHANNEL } from '@hushkey/hound/mod.ts';
import type { JobFinishedPayload } from '@hushkey/hound/mod.ts';

await hound.start();

// ─── Broker: fire-and-forget pub/sub ──────────────────────────────────────────
// Live events for whoever is listening right now — no persistence, no retry.
// A missed message is irrelevant by design; durable work belongs to hound.
if (broker) {
  // Domain channel — subscribe returns an unsubscribe fn (ref-counted:
  // last listener leaving tears down the Redis subscription).
  const unsubGreetings = broker.subscribe<{ user: string }>(
    'greetings',
    (p) => console.log('[broker] greeting for', p.user),
  );

  // Job-finished events flow through the same broker — this is what makes
  // emitAndWait and the gateway's /events stream work across processes.
  const unsubJobs = broker.subscribe<JobFinishedPayload>(
    JOB_FINISHED_CHANNEL,
    (e) => console.log(`[broker] job ${e.jobId} → ${e.status}`),
  );

  for (let i = 0; i < 5; i++) {
    broker.publish('greetings', { user: 'lucio' });
  } // never throws, never blocks

  // Keep the subscriptions for the life of the process; call to detach:
  void unsubGreetings;
  void unsubJobs;
}

hound.emit('user.read', {
  email: 'leo@gmail.com',
  name: 'lucio',
}, { id: 'user.read-1' });

hound.emit('user.read', {
  email: 'leo@gmail.com',
  name: 'lucio',
}, { id: 'user.read-2' });

await hound.emitBatch([
  { event: 'user.read', data: { email: 'a@gmail.com', name: 'alice' } },
  { event: 'user.read', data: { email: 'b@gmail.com', name: 'bob' } },
  { event: 'user.read', data: { email: 'c@gmail.com', name: 'carol' } },
]);

await hound.emitAsync('user.read', { email: 'd@gmail.com', name: 'dave' });

// hound.on('user.read', async (ctx) => {
//   ctx.data.email;
//   ctx.data.name;
// });
