import { remq } from './remq.plugin.ts';

const TOTAL_JOBS = 1000;
const SIMULATED_WORK_MS = 600; // change to 50 or 100 to simulate heavier I/O

let processed = 0;
let maxConcurrent = 0;
let currentConcurrent = 0;
let processingStart: number;

// Handler with full benchmark instrumentation
remq.on('on.request', async (ctx) => {
  // Track concurrency saturation
  currentConcurrent++;
  maxConcurrent = Math.max(maxConcurrent, currentConcurrent);

  // Simulate real async I/O (adjust SIMULATED_WORK_MS to test different loads)
  await new Promise((r) => setTimeout(r, SIMULATED_WORK_MS));

  currentConcurrent--;
  processed++;

  if (processed === TOTAL_JOBS) {
    const duration = Date.now() - processingStart;
    console.log('\n── Processing Benchmark ──────────────────────');
    console.log(`jobs:            ${TOTAL_JOBS}`);
    console.log(`simulated work:  ${SIMULATED_WORK_MS}ms per job`);
    console.log(`duration:        ${duration}ms`);
    console.log(
      `throughput:      ${(TOTAL_JOBS / duration * 1000).toFixed(0)} jobs/sec`,
    );
    console.log(
      `avg latency:     ${(duration / TOTAL_JOBS).toFixed(2)}ms per job`,
    );
    console.log(
      `max concurrency: ${maxConcurrent} / ${(remq as any).concurrency}`,
    );
    console.log(
      `expected min:    ${
        Math.ceil(TOTAL_JOBS * SIMULATED_WORK_MS / (remq as any).concurrency)
      }ms`,
    );
    console.log('──────────────────────────────────────────────\n');
  }
});

// Start processor
await remq.start();
console.log(`queue paused: ${await remq.isPaused('default')}`);

// Benchmark 1: emit throughput (fire-and-forget, no Promise.all needed)
console.log(`\n── Emit Benchmark ────────────────────────────`);
console.time('emit-1000-jobs');
for (let i = 0; i < TOTAL_JOBS; i++) {
  remq.emit('on.request', {
    name: 'John Doe',
    email: 'john.doe@example.com',
  }, { id: `on-request-${i + 1}` });
}
console.timeEnd('emit-1000-jobs');
console.log('──────────────────────────────────────────────');

// Mark when processing starts (first job picked up)
processingStart = Date.now();
console.log(`\nseeded ${TOTAL_JOBS} jobs — waiting for workers to drain...\n`);
