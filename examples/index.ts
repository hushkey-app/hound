import { remq } from './remq.plugin.ts';
import { requestJob } from './benchmarks/request.job.ts';
import { benchmark } from './benchmarks/utilities/benchmark.ts';
import { helloWorldJob } from './_scheduled/hello-world.ts';
import { byeWorldJob } from './_scheduled/multi-jobs.ts';

const TOTAL_JOBS = 1000;
const SIMULATED_WORK_MS = 0; // e.g. 600 for heavier I/O
const CONCURRENCY = 10; // match remq.plugin.ts concurrency

benchmark.configure({
  totalJobs: TOTAL_JOBS,
  simulatedWorkMs: SIMULATED_WORK_MS,
  concurrency: CONCURRENCY,
});

remq.on(requestJob);
remq.on(helloWorldJob);
remq.on(byeWorldJob);

await remq.start();

benchmark.start();
console.log(`\nseeded ${TOTAL_JOBS} jobs — waiting for workers to drain...\n`);
for (let i = 0; i < TOTAL_JOBS; i++) {
  remq.emit('request', {
    name: 'John Doe',
    email: 'john.doe@example.com',
  }, { id: `on-request-${i + 1}` });
}
