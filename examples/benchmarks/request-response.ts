/**
 * Benchmark: Request/Response over hound
 *
 * Measures round-trip latency and throughput for emit → handler → finished.
 * Uses a JobWaiter (Map-based O(1) routing) instead of broadcast listeners.
 *
 * Usage:
 *   deno run -A benchmark/request-response.ts
 */

import { hound, management } from '../hound.plugin.ts';

// ─── Types ────────────────────────────────────────────────────────────────────

interface BenchmarkPayload {
  data: string;
  timestamp: number;
}

interface Stats {
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  throughput: number;
}

interface BenchmarkConfig {
  name: string;
  requests: number;
  /** Client-side parallelism — how many enqueueAndWait calls in-flight simultaneously.
   *  Independent of hound.concurrency which is fixed at 10. */
  concurrency: number;
  payloadSize: number;
}

// ─── JobWaiter ────────────────────────────────────────────────────────────────

/**
 * O(1) job completion routing via Map<jobId, resolver>.
 * Single subscription shared across all in-flight jobs.
 * Replaces the O(n²) broadcast listener pattern.
 */
class JobWaiter<T extends typeof management> {
  private readonly resolvers = new Map<string, {
    resolve: (latency: number) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    start: number;
  }>();
  private unsub: (() => void) | undefined;

  constructor(management: T) {
    this.unsub = management.events.job.finished((p) => {
      const entry = this.resolvers.get(p.jobId);
      if (!entry) return; // not our job
      this.resolvers.delete(p.jobId);
      clearTimeout(entry.timer);
      if (p.status === 'failed') {
        entry.reject(new Error(p.error ?? 'Job failed'));
      } else {
        entry.resolve(performance.now() - entry.start);
      }
    });
  }

  waitForId(jobId: string, timeoutMs: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const start = performance.now();
      const timer = setTimeout(() => {
        this.resolvers.delete(jobId);
        reject(new Error(`Job ${jobId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.resolvers.set(jobId, { resolve, reject, timer, start });
    });
  }

  get pending(): number {
    return this.resolvers.size;
  }

  destroy(): void {
    this.unsub?.();
    for (const { timer } of this.resolvers.values()) {
      clearTimeout(timer);
    }
    this.resolvers.clear();
  }
}

// ─── enqueueAndWait ───────────────────────────────────────────────────────────

/**
 * hound equivalent of enqueueAndWait.
 * Subscribes before emitting to avoid race where fast handler finishes
 * before the waiter is registered.
 */
async function enqueueAndWait(
  hound: any,
  waiter: JobWaiter<typeof management>,
  event: string,
  payload: BenchmarkPayload,
  options: { queue: string; timeoutMs?: number },
): Promise<number> {
  const id = `bench-${crypto.randomUUID()}`;
  // Pre-register waiter BEFORE emit — avoids race where fast handler
  // completes before waiter is registered
  const waitPromise = waiter.waitForId(id, options.timeoutMs ?? 30_000);
  // Fire and forget — no await, workers stay parallel
  hound.emit(event, payload, { queue: options.queue, id });
  return waitPromise;
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function calculateStats(latencies: number[], durationMs: number): Stats {
  const sorted = [...latencies].sort((a, b) => a - b);
  const count = sorted.length;
  const totalMs = sorted.reduce((sum, l) => sum + l, 0);

  return {
    count,
    totalMs,
    minMs: sorted[0] ?? 0,
    maxMs: sorted[count - 1] ?? 0,
    p50Ms: sorted[Math.floor(count * 0.5)] ?? 0,
    p95Ms: sorted[Math.floor(count * 0.95)] ?? 0,
    p99Ms: sorted[Math.floor(count * 0.99)] ?? 0,
    throughput: count / (durationMs / 1000),
  };
}

function formatStats(name: string, stats: Stats): string {
  return `
${name}
${'─'.repeat(50)}
  Requests:    ${stats.count}
  Throughput:  ${stats.throughput.toFixed(2)} req/s
  Latency:
    min:       ${stats.minMs.toFixed(2)} ms
    p50:       ${stats.p50Ms.toFixed(2)} ms
    p95:       ${stats.p95Ms.toFixed(2)} ms
    p99:       ${stats.p99Ms.toFixed(2)} ms
    max:       ${stats.maxMs.toFixed(2)} ms
    avg:       ${(stats.totalMs / stats.count).toFixed(2)} ms
`;
}

// ─── Benchmark runner ─────────────────────────────────────────────────────────

async function runBenchmark(
  hound: any,
  waiter: JobWaiter<typeof management>,
  config: BenchmarkConfig,
): Promise<Stats> {
  const { requests, concurrency, payloadSize } = config;
  const payload = 'x'.repeat(payloadSize);
  const latencies: number[] = [];
  let timedOut = 0;

  let jobIndex = 0;
  const startTime = performance.now();

  const workers: Promise<void>[] = [];

  for (let i = 0; i < concurrency; i++) {
    workers.push(
      (async () => {
        while (true) {
          const myIndex = jobIndex++;
          if (myIndex >= requests) break;

          try {
            const latency = await enqueueAndWait(
              hound,
              waiter,
              'bench.job',
              { data: payload, timestamp: Date.now() },
              { queue: 'bench', timeoutMs: 30_000 },
            );
            latencies.push(latency);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('timed out')) {
              timedOut++;
            } else {
              console.error(`Job ${myIndex} failed:`, err);
            }
          }
        }
      })(),
    );
  }

  await Promise.all(workers);

  const durationMs = performance.now() - startTime;
  if (timedOut > 0) {
    console.warn(`  ⚠ ${timedOut} job(s) timed out and excluded from stats`);
  }
  return calculateStats(latencies, durationMs);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const redisUrl = Deno.env.get('REDIS_URL') ?? 'redis://localhost:6379';

  console.log(`
╔══════════════════════════════════════════════════╗
║     Request/Response Benchmark — hound            ║
╚══════════════════════════════════════════════════╝

Redis URL: ${redisUrl}
`);

  // ── Redis connections ──────────────────────────────────────────────────────

  hound.on('bench.job', async (_ctx) => {
    // 0ms work — pure infrastructure latency measurement
  }, { queue: 'bench' });

  // JobWaiter — single subscription, O(1) routing per completion
  const waiter = new JobWaiter<typeof management>(management);

  await hound.start();

  // ── Warmup ─────────────────────────────────────────────────────────────────
  console.log('Warming up (100 requests)...');
  const warmupLatencies: number[] = [];

  for (let i = 0; i < 100; i++) {
    try {
      const payload = { data: 'warmup', timestamp: Date.now() };

      // Diagnostic timing on first job only
      if (i === 0) {
        const t0 = performance.now();
        const diagId = `warmup-diag-${crypto.randomUUID()}`;
        const diagWait = waiter.waitForId(diagId, 30_000);
        hound.emit('bench.job', payload, { queue: 'bench', id: diagId });
        const t1 = performance.now();
        console.log(`[diag] emit: ${(t1 - t0).toFixed(2)}ms, jobId: ${diagId}`);
        const latency = await diagWait;
        const t2 = performance.now();
        console.log(
          `[diag] wait (handler + notify): ${(t2 - t1).toFixed(2)}ms`,
        );
        console.log(`[diag] total round-trip: ${(t2 - t0).toFixed(2)}ms`);
        warmupLatencies.push(latency);
        continue;
      }

      const latency = await enqueueAndWait(
        hound,
        waiter,
        'bench.job',
        payload,
        { queue: 'bench', timeoutMs: 30_000 },
      );
      warmupLatencies.push(latency);
    } catch (err) {
      console.error('Warmup job failed:', err);
    }
  }

  const warmupAvg = warmupLatencies.reduce((s, l) => s + l, 0) /
    warmupLatencies.length;
  console.log(`Warmup complete. avg latency: ${warmupAvg.toFixed(2)}ms\n`);

  // ── Benchmarks ─────────────────────────────────────────────────────────────
  console.log('Running benchmarks...\n');

  const benchmarks: BenchmarkConfig[] = [
    { name: 'baseline', requests: 100, concurrency: 1, payloadSize: 100 },
    { name: 'low-volume', requests: 500, concurrency: 10, payloadSize: 100 },
    { name: 'high-volume', requests: 1000, concurrency: 10, payloadSize: 100 },
    {
      name: 'large-payload',
      requests: 200,
      concurrency: 10,
      payloadSize: 10000,
    },
    { name: 'sustained', requests: 2000, concurrency: 10, payloadSize: 100 },
  ];

  const labels = [
    'Baseline (100 requests, concurrency=1)',
    'Low Volume (500 requests, concurrency=10)',
    'High Volume (1000 requests, concurrency=10)',
    'Large Payload (200 requests, 10KB payload, concurrency=10)',
    'Sustained Load (2000 requests, concurrency=10)',
  ];

  for (let i = 0; i < benchmarks.length; i++) {
    const stats = await runBenchmark(hound, waiter, benchmarks[i]);
    console.log(formatStats(labels[i], stats));
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  waiter.destroy();
  await hound.stop();
  await management.api.queues.reset('bench');

  console.log('Benchmark complete.');
  Deno.exit(0);
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  Deno.exit(1);
});
