import { defineJob } from '@core/mod.ts';
import { benchmark } from './utilities/benchmark.ts';

interface OnRequestData {
  name: string;
  email: string;
}

export const requestJob = defineJob<Record<string, unknown>, OnRequestData>(
  'request',
  async (ctx) => {
    benchmark.enter();
    benchmark.configure({
      totalJobs: 1000,
      simulatedWorkMs: 0,
    });
    const delayMs = benchmark.getConfig().simulatedWorkMs;
    await new Promise((r) => setTimeout(r, delayMs));
    benchmark.exit();
    benchmark.incrementProcessed();
    if (benchmark.isDone()) {
      benchmark.print();
    }
  },
  { queue: 'default' },
);
