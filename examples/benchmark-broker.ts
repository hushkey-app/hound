/**
 * Broker throughput benchmark — pub/sub fan-out speed, the counterpart to
 * benchmark.ts (durable jobs). No sorted sets, no state keys, no claim
 * cycle: publish → transport → callback.
 *
 * Backends: REDIS_URL set → real Redis pub/sub (pub + duplicated sub
 * connection); unset → InMemoryStorage in-process delivery.
 *
 * Config: BROKER_BENCH_MESSAGES (default 100_000).
 */
import { Broker, InMemoryStorage } from '@hushkey/hound/mod.ts';
import type { BrokerConnection } from '@hushkey/hound/mod.ts';

const REDIS_URL = Deno.env.get('REDIS_URL');
const TOTAL = Number(Deno.env.get('BROKER_BENCH_MESSAGES') ?? 500_000);

let pub: BrokerConnection;
let backend: string;

if (REDIS_URL) {
  const { Redis } = await import('npm:ioredis');
  pub = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  }) as unknown as BrokerConnection;
  backend = 'Redis';
} else {
  pub = new InMemoryStorage();
  backend = 'InMemory';
}

console.log(`[benchmark-broker] Backend: ${backend}, messages: ${TOTAL}`);

const broker = new Broker({ pub });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Subscribe + warm-up ────────────────────────────────────────────────────
// SUBSCRIBE is async on Redis — publishing before it lands loses messages.
// Subscribe the bench channel FIRST, then a warm channel on the same
// connection: commands are ordered, so once the warm ping arrives the bench
// subscription is guaranteed active too.

let received = 0;
const latencies: number[] = [];
const SAMPLE_MASK = 255; // sample every 256th message for percentiles

broker.subscribe<{ i: number; t: number }>('bench', (m) => {
  received++;
  if ((m.i & SAMPLE_MASK) === 0) latencies.push(performance.now() - m.t);
});

let warm = false;
const unsubWarm = broker.subscribe('bench:warm', () => {
  warm = true;
});
while (!warm) {
  broker.publish('bench:warm', 1);
  await sleep(20);
}
unsubWarm();

// ─── Publish phase ──────────────────────────────────────────────────────────
// publish() is fire-and-forget: it never blocks, which also means it never
// pushes back. Yield every few thousand messages so the microtask queue can
// drain — an unyielding loop just piles allocations up (see: the OOM).

const start = performance.now();
for (let i = 0; i < TOTAL; i++) {
  broker.publish('bench', { i, t: performance.now() });
  if ((i & 4095) === 4095) await sleep(0);
}
const publishDone = performance.now();

// ─── Drain phase ────────────────────────────────────────────────────────────

const deadline = Date.now() + 30_000;
while (received < TOTAL && Date.now() < deadline) await sleep(5);
const end = performance.now();

// ─── Report ─────────────────────────────────────────────────────────────────

const publishSecs = (publishDone - start) / 1000;
const totalSecs = (end - start) / 1000;
const lost = TOTAL - received;
const sorted = [...latencies].sort((a, b) => a - b);
const pct = (p: number) => sorted[Math.floor(sorted.length * p)] ?? 0;

console.log(`
Broker Benchmark Results
${'─'.repeat(40)}
  Messages:    ${TOTAL}
  Delivered:   ${received}${
  lost ? `  (lost: ${lost} — fire-and-forget, by design)` : ''
}
  Publish:     ${(TOTAL / publishSecs).toFixed(0)} msg/s (${
  publishSecs.toFixed(3)
}s)
  End-to-end:  ${(received / totalSecs).toFixed(0)} msg/s (${
  totalSecs.toFixed(3)
}s)
  Delivery latency (publish → callback, sampled):
    min: ${(sorted[0] ?? 0).toFixed(2)}ms
    p50: ${pct(0.5).toFixed(2)}ms
    p95: ${pct(0.95).toFixed(2)}ms
    p99: ${pct(0.99).toFixed(2)}ms
    max: ${(sorted[sorted.length - 1] ?? 0).toFixed(2)}ms
`);

Deno.exit(0);
