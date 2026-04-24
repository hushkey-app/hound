/**
 * Isolated benchmark: only registers the request job so the processor
 * subscribes to the default queue only. Use this instead of the main index
 * when measuring throughput — the main index also registers cron (e.g. tasks
 * queue) and other handlers, which compete for worker slots and pollute results.
 *
 * Run: deno task dev (from repo root, or run this file with appropriate imports)
 * Or from examples: deno run --allow-net --allow-env -A benchmarks/run.ts
 */
import { hound } from '../hound.plugin.ts';
import { requestJob } from './request.job.ts';
import { benchmark } from './utilities/benchmark.ts';

const TOTAL_JOBS = 1000;
const SIMULATED_WORK_MS = 0;
const CONCURRENCY = 10;

benchmark.configure({
  totalJobs: TOTAL_JOBS,
  simulatedWorkMs: SIMULATED_WORK_MS,
  concurrency: CONCURRENCY,
});

hound.on(requestJob);

await hound.start();

benchmark.start();
console.log(`\nseeded ${TOTAL_JOBS} jobs — waiting for workers to drain...\n`);
for (let i = 0; i < TOTAL_JOBS; i++) {
  hound.emit('request', {
    name: 'John Doe',
    email: 'john.doe@example.com',
  }, { id: `on-request-${i + 1}` });
}
