/**
 * Simple concurrency pool to limit concurrent message processing
 */
export class ConcurrencyPool {
  readonly maxConcurrency: number;
  private activeJobs = new Set<Promise<void>>();

  constructor(maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency;
  }

  /**
   * Executes a job if concurrency allows, otherwise waits
   */
  async execute<T>(job: () => Promise<T>): Promise<T> {
    // Wait if we've hit concurrency limit
    while (this.activeJobs.size >= this.maxConcurrency) {
      await Promise.race(this.activeJobs);
    }

    // Create promise for this job
    const taskPromise = job();

    // Create a void wrapper promise for tracking
    const voidPromise = taskPromise.then(
      () => void 0,
      () => void 0,
    ) as Promise<void>;

    // Track the void promise in active tasks
    this.activeJobs.add(voidPromise);

    // Remove from tracking when done (whether success or failure)
    voidPromise.finally(() => {
      this.activeJobs.delete(voidPromise);
    });

    return taskPromise;
  }

  /**
   * Gets the number of active tasks
   */
  get activeCount(): number {
    return this.activeJobs.size;
  }

  /**
   * Gets all active job promises
   */
  get activeJobsSet(): ReadonlySet<Promise<void>> {
    return this.activeJobs;
  }

  /**
   * Waits for all active tasks to complete
   */
  async waitForAll(): Promise<void> {
    if (this.activeJobs.size === 0) {
      return;
    }
    await Promise.all(this.activeJobs);
  }
}
