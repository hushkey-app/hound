import type { RedisConnection } from '../../types/index.ts';
import type { AdminJobData, ListJobsOptions, TaskStats, QueueInfo } from '../../types/admin.ts';

/**
 * Sdk - Client SDK for queue management
 *
 * Provides simple CRUD operations for task management in admin interfaces
 * and external clients.
 */
export class Sdk {
  private readonly db: RedisConnection;

  constructor(db: RedisConnection) {
    this.db = db;
  }

  /**
   * Get a task by ID and queue
   */
  async getTask(taskId: string, queue: string): Promise<AdminJobData | null> {
    // Try to find task by checking all possible statuses
    const statuses: AdminJobData['status'][] = ['waiting', 'processing', 'completed', 'failed', 'delayed'];

    for (const status of statuses) {
      const key = `queues:${queue}:${taskId}:${status}`;
      const data = await this.db.get(key);

      if (data) {
        try {
          const taskData = JSON.parse(data) as AdminJobData;
          // Ensure status is set correctly
          taskData.status = status;
          return taskData;
        } catch (error) {
          console.error(`Error parsing task data for ${key}:`, error);
          return null;
        }
      }
    }

    return null;
  }

  /**
   * List tasks with optional filtering
   */
  async listTasks(options: ListJobsOptions = {}): Promise<AdminJobData[]> {
    const {
      queue,
      status,
      limit = 100,
      offset = 0,
    } = options;

    const tasks: AdminJobData[] = [];

    // If queue is specified, search only that queue
    // Otherwise, we'd need to scan all queues (more expensive)
    if (!queue) {
      throw new Error('queue is required for listTasks');
    }

    const statuses: AdminJobData['status'][] = status
      ? [status]
      : ['waiting', 'processing', 'completed', 'failed', 'delayed'];

    // For each status, scan keys matching pattern
    for (const statusType of statuses) {
      const pattern = `queues:${queue}:*:${statusType}`;

      // Use SCAN to find matching keys (more efficient than KEYS for production)
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.db.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          100,
        ) as [string, string[]];

        cursor = nextCursor;

        // Fetch task data for each key
        for (const key of keys) {
          try {
            const data = await this.db.get(key);
            if (data) {
              const taskData = JSON.parse(data) as AdminJobData;
              taskData.status = statusType; // Ensure status is set correctly
              tasks.push(taskData);
            }
          } catch (error) {
            console.error(`Error parsing task data for ${key}:`, error);
          }
        }
      } while (cursor !== '0');
    }

    // Sort by timestamp (newest first)
    tasks.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    // Apply offset and limit
    return tasks.slice(offset, offset + limit);
  }

  /**
   * Delete a task (removes from Redis)
   */
  async deleteTask(taskId: string, queue: string): Promise<void> {
    const statuses: AdminJobData['status'][] = ['waiting', 'processing', 'completed', 'failed', 'delayed'];

    // Delete all status keys for this task
    const keysToDelete: string[] = [];

    for (const status of statuses) {
      keysToDelete.push(`queues:${queue}:${taskId}:${status}`);
    }

    // Also delete log keys (pattern: queues:queue:taskId:logs:*)
    const logPattern = `queues:${queue}:${taskId}:logs:*`;
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.db.scan(
        cursor,
        'MATCH',
        logPattern,
        'COUNT',
        100,
      ) as [string, string[]];
      
      cursor = nextCursor;
      keysToDelete.push(...keys);
    } while (cursor !== '0');
    
    // Delete all keys
    if (keysToDelete.length > 0) {
      await this.db.del(...keysToDelete);
    }
  }

  /**
   * Get task statistics for a queue
   */
  async getQueueStats(queue: string): Promise<TaskStats> {
    const statuses: AdminJobData['status'][] = ['waiting', 'processing', 'completed', 'failed', 'delayed'];
    const stats: TaskStats = {
      queue,
      waiting: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      total: 0,
    };

    for (const status of statuses) {
      const pattern = `queues:${queue}:*:${status}`;
      let count = 0;
      let cursor = '0';
      
      do {
        const [nextCursor, keys] = await this.db.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          100,
        ) as [string, string[]];
        
        cursor = nextCursor;
        count += keys.length;
      } while (cursor !== '0');
      
      stats[status] = count;
      stats.total += count;
    }

    return stats;
  }

  /**
   * Get all queues (discovered by scanning keys)
   */
  async getQueues(): Promise<string[]> {
    const queues = new Set<string>();
    let cursor = '0';
    
    // Scan for all queue:* keys
    do {
      const [nextCursor, keys] = await this.db.scan(
        cursor,
        'MATCH',
        'queues:*:*:*',
        'COUNT',
        100,
      ) as [string, string[]];
      
      cursor = nextCursor;
      
      // Extract queue names from keys (queues:queueName:taskId:status)
      for (const key of keys) {
        const parts = key.split(':');
        if (parts.length >= 2 && parts[0] === 'queues') {
          queues.add(parts[1]);
        }
      }
    } while (cursor !== '0');
    
    return Array.from(queues).sort();
  }

  /**
   * Get queue info with statistics
   */
  async getQueuesInfo(): Promise<QueueInfo[]> {
    const queueNames = await this.getQueues();
    const queues: QueueInfo[] = [];
    
    for (const queueName of queueNames) {
      const stats = await this.getQueueStats(queueName);
      queues.push({
        name: queueName,
        stats,
      });
    }
    
    return queues;
  }

  /**
   * Retry a failed task
   */
  async retryTask(taskId: string, queue: string): Promise<AdminJobData | null> {
    const task = await this.getTask(taskId, queue);

    if (!task) {
      return null;
    }

    if (task.status !== 'failed') {
      throw new Error(`Cannot retry task with status: ${task.status}. Only failed tasks can be retried.`);
    }

    // Create a new task with same data but reset status
    const newTaskData: AdminJobData = {
      ...task,
      status: 'waiting',
      retriedAttempts: task.retriedAttempts + 1,
      timestamp: Date.now(),
      delayUntil: Date.now(),
      lockUntil: Date.now(),
      logs: [
        ...task.logs,
        {
          message: `Task retried (attempt ${task.retriedAttempts + 1})`,
          timestamp: Date.now(),
        },
      ],
    };

    // Delete old failed status
    await this.db.del(`queues:${queue}:${taskId}:failed`);

    // Store as waiting
    const waitingKey = `queues:${queue}:${taskId}:waiting`;
    await this.db.set(waitingKey, JSON.stringify(newTaskData));

    // Also add to stream so it gets processed
    // Note: This requires access to streamdb, which we don't have here
    // For now, just update the status. The task will need to be re-emitted via TaskManager

    return newTaskData;
  }

  /**
   * Cancel a task (delete if waiting/delayed, or mark for cancellation if processing)
   */
  async cancelTask(taskId: string, queue: string): Promise<boolean> {
    const task = await this.getTask(taskId, queue);

    if (!task) {
      return false;
    }

    // Can only cancel waiting or delayed tasks
    if (task.status !== 'waiting' && task.status !== 'delayed') {
      throw new Error(`Cannot cancel task with status: ${task.status}. Only waiting or delayed tasks can be cancelled.`);
    }

    // Simply delete the task
    await this.deleteTask(taskId, queue);

    return true;
  }

  /**
   * Pause one or all queues. With no arg, pauses all discovered queues.
   */
  async pause(queue?: string): Promise<void> {
    const queues = queue != null ? [queue] : await this.getQueues();
    for (const q of queues) {
      await this.db.set(`queues:${q}:paused`, 'true');
    }
  }

  /**
   * Resume one or all queues. With no arg, resumes all discovered queues.
   */
  async resume(queue?: string): Promise<void> {
    const queues = queue != null ? [queue] : await this.getQueues();
    for (const q of queues) {
      await this.db.del(`queues:${q}:paused`);
    }
  }

  /**
   * Check if a queue is paused.
   */
  async isPaused(queue: string): Promise<boolean> {
    const pausedKey = `queues:${queue}:paused`;
    const isPaused = await this.db.get(pausedKey);
    return isPaused === 'true';
  }

  /**
   * Pause an individual task (only works for waiting/delayed tasks)
   */
  async pauseTask(taskId: string, queue: string): Promise<AdminJobData | null> {
    const task = await this.getTask(taskId, queue);

    if (!task) {
      return null;
    }

    // Can only pause waiting or delayed tasks
    if (task.status !== 'waiting' && task.status !== 'delayed') {
      throw new Error(`Cannot pause task with status: ${task.status}. Only waiting or delayed tasks can be paused.`);
    }

    // Update task with paused flag
    const pausedTask = {
      ...task,
      paused: true,
    } as AdminJobData;

    const statusKey = `queues:${queue}:${taskId}:${task.status}`;
    await this.db.set(statusKey, JSON.stringify(pausedTask));

    return pausedTask;
  }

  /**
   * Resume an individual task (unpause)
   */
  async resumeTask(taskId: string, queue: string): Promise<AdminJobData | null> {
    const task = await this.getTask(taskId, queue);

    if (!task) {
      return null;
    }

    // Update task to remove paused flag
    const resumedTask = {
      ...task,
      paused: false,
    } as AdminJobData;

    const statusKey = `queues:${queue}:${taskId}:${task.status}`;
    await this.db.set(statusKey, JSON.stringify(resumedTask));

    return resumedTask;
  }
}
