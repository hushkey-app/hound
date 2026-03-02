---
title: Sdk
description: Client SDK for queue administration and external clients.
---

# Sdk

The `Sdk` class is the client SDK for queue management. It provides CRUD and
control for admin UIs and external clients over jobs stored in Redis.

## Minimal example

```typescript
const sdk = new Sdk(db);

const queues = await sdk.getQueuesInfo();
const failedTasks = await sdk.listTasks({
  queue: 'default',
  status: 'failed',
  limit: 10,
});
if (failedTasks[0]) {
  await sdk.retryTask(failedTasks[0].id, 'default');
}
```

## Constructor

```typescript
new Sdk(db: RedisConnection)
```

`db` is the Redis connection used for CRUD and control operations. It should be
the same connection used by Remq so queue state is consistent.

## Types

| Type | Purpose | Main fields |
| --- | --- | --- |
| `AdminJobData` | Stored job record | `id`, `state`, `status`, timestamps (`timestamp`, `lastRun`, `delayUntil`, `lockUntil`), `logs`, `errors`, `paused` |
| `ListJobsOptions` | List/filter options for `listTasks` | `queue`, `status`, `limit`, `offset` |
| `TaskStats` | Per-queue status counts | `queue`, `waiting`, `processing`, `completed`, `failed`, `delayed`, `total` |
| `QueueInfo` | Queue name + stats bundle | `name`, `stats` |

## AdminJobData

`AdminJobData` represents a stored job record.

```typescript
interface AdminJobData {
  id: string;
  state: {
    name: string;
    queue: string;
    data?: unknown;
    options?: {
      repeat?: { pattern: string };
      [key: string]: unknown;
    };
  };
  status: 'waiting' | 'processing' | 'completed' | 'failed' | 'delayed';
  delayUntil: number;
  lockUntil: number;
  priority: number;
  retryCount: number;
  retryDelayMs: number;
  retriedAttempts: number;
  repeatCount: number;
  repeatDelayMs: number;
  logs: Array<{ message: string; timestamp: number }>;
  errors: string[];
  timestamp: number;
  lastRun?: number;
  paused?: boolean;
}
```

## ListJobsOptions

```typescript
interface ListJobsOptions {
  queue?: string;
  status?: 'waiting' | 'processing' | 'completed' | 'failed' | 'delayed';
  limit?: number;
  offset?: number;
}
```

queue is required by `listTasks` and is validated at runtime.

## TaskStats and QueueInfo

```typescript
interface TaskStats {
  queue: string;
  waiting: number;
  processing: number;
  completed: number;
  failed: number;
  delayed: number;
  total: number;
}

interface QueueInfo {
  name: string;
  stats: TaskStats;
}
```

## Methods

### `getTask(taskId: string, queue: string): Promise<AdminJobData | null>`

Params:

- `taskId` (string) - Task id to look up.
- `queue` (string) - Queue name to search.

Returns the job data or `null` if not found. The lookup checks all
known statuses (`waiting`, `processing`, `completed`, `failed`, `delayed`).

### `listTasks(options?: ListJobsOptions): Promise<AdminJobData[]>`

Lists jobs for a queue with optional status filtering and pagination.

`ListJobsOptions`:

- `queue` (required) - Queue name to list.
- `status` (optional) - Status filter (`waiting`, `processing`, `completed`, `failed`, `delayed`).
- `limit` (optional) - Max number of jobs to return.
- `offset` (optional) - Pagination offset.

```typescript
const tasks = await sdk.listTasks({
  queue: 'default',
  status: 'failed',
  limit: 50,
  offset: 0,
});
```

Notes:

- `queue` is required and missing it throws.
- Jobs are sorted by `timestamp` (newest first).

### `deleteTask(taskId: string, queue: string): Promise<void>`

Deletes a job and its logs from Redis.

### `getQueueStats(queue: string): Promise<TaskStats>`

Returns a `TaskStats` object with counts by status plus a `total` for a single queue.

### `getQueues(): Promise<string[]>`

Scans Redis keys and returns discovered queue names.

### `getQueuesInfo(): Promise<QueueInfo[]>`

Returns all queues with their statistics as `QueueInfo` objects (`name` + `stats`).

### `retryTask(taskId, queue)`

Retries a job by recreating it as `waiting`, incrementing `retriedAttempts`,
and appending a retry log entry. Returns the updated job or `null` if the job
is missing. Throws if the job status is not `failed`.

Note: this method only updates Redis state. Re-emit the job via
`Remq.emit()` to actually process it.

### `cancelTask(taskId, queue)`, `pause`, `resume`, `isPaused`, `pauseTask`, `resumeTask`

Cancel/pause/resume tasks and queues. See core SDK README for details.

## Next Steps

- [Remq API](/reference/task-manager)
- [Consumer API](/reference/consumer)
- [Processor API](/reference/processor)
