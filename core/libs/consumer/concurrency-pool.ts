/**
 * Simple concurrency pool to limit concurrent message processing
 */
export class ConcurrencyPool {
  readonly maxConcurrency: number;
  private activeTasks = new Set<Promise<void>>();

  constructor(maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency;
  }

  /**
   * Executes a job if concurrency allows, otherwise waits
   */
  async execute<T>(job: () => Promise<T>): Promise<T> {
    // Wait if we've hit concurrency limit
    while (this.activeTasks.size >= this.maxConcurrency) {
      await Promise.race(this.activeTasks);
    }

    // Create promise for this job
    const taskPromise = job();

    // Create a void wrapper promise for tracking
    const voidPromise = taskPromise.then(
      () => void 0,
      () => void 0,
    ) as Promise<void>;

    // Track the void promise in active tasks
    this.activeTasks.add(voidPromise);

    // Remove from tracking when done (whether success or failure)
    voidPromise.finally(() => {
      this.activeTasks.delete(voidPromise);
    });

    return taskPromise;
  }

  /**
   * Gets the number of active tasks
   */
  get activeCount(): number {
    return this.activeTasks.size;
  }

  /**
   * Gets all active job promises
   */
  get activeTasksSet(): ReadonlySet<Promise<void>> {
    return this.activeTasks;
  }

  /**
   * Waits for all active tasks to complete
   */
  async waitForAll(): Promise<void> {
    if (this.activeTasks.size === 0) {
      return;
    }
    await Promise.all(this.activeTasks);
  }
}
