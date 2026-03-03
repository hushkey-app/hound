/**
 * Shared benchmark state and reporting for examples/benchmarks.
 * Configure from index, use from job handler; call start() before emitting, print() when done.
 */
export interface BenchmarkConfig {
  totalJobs: number;
  simulatedWorkMs: number;
  concurrency: number;
}

const state = {
  processingStart: 0,
  processed: 0,
  currentConcurrent: 0,
  maxConcurrent: 0,
  printed: false,
};

let config: BenchmarkConfig = {
  totalJobs: 1000,
  simulatedWorkMs: 0,
  concurrency: 1,
};

export const benchmark = {
  get processed() {
    return state.processed;
  },
  get currentConcurrent() {
    return state.currentConcurrent;
  },
  get maxConcurrent() {
    return state.maxConcurrent;
  },

  configure(c: Partial<BenchmarkConfig>) {
    config = { ...config, ...c };
  },

  start() {
    state.processingStart = Date.now();
    state.processed = 0;
    state.currentConcurrent = 0;
    state.maxConcurrent = 0;
    state.printed = false;
  },

  enter() {
    state.currentConcurrent++;
    state.maxConcurrent = Math.max(state.maxConcurrent, state.currentConcurrent);
  },

  exit() {
    state.currentConcurrent--;
  },

  incrementProcessed() {
    state.processed++;
  },

  isDone(): boolean {
    return state.processed >= config.totalJobs;
  },

  getConfig(): Readonly<BenchmarkConfig> {
    return config;
  },

  print() {
    if (state.printed) return;
    state.printed = true;

    const duration = Date.now() - state.processingStart;
    const expectedMin =
      config.concurrency > 0
        ? Math.ceil(
            (config.totalJobs * config.simulatedWorkMs) / config.concurrency,
          )
        : 0;
    console.log('\n── Processing Benchmark ──────────────────────');
    console.log(`jobs:            ${config.totalJobs}`);
    console.log(`simulated work:  ${config.simulatedWorkMs}ms per job`);
    console.log(`duration:        ${duration}ms`);
    console.log(
      `throughput:      ${((config.totalJobs / duration) * 1000).toFixed(0)} jobs/sec`,
    );
    console.log(
      `avg latency:     ${(duration / config.totalJobs).toFixed(2)}ms per job`,
    );
    console.log(
      `max concurrency: ${state.maxConcurrent} / ${config.concurrency}`,
    );
    console.log(`expected min:    ${expectedMin}ms`);
    console.log('──────────────────────────────────────────────\n');
  },
};
