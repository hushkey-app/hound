---
title: RemqAdmin
description: Client for queue administration and external clients.
---

# RemqAdmin

The `RemqAdmin` class is the client for queue management. It provides CRUD and
control for admin UIs and external clients over jobs stored in Redis.

## Minimal example

```typescript
const admin = new RemqAdmin(db);

const queues = await admin.queuesInfo();
const failedJobs = await admin.listJobs({
  queue: 'default',
  status: 'failed',
  limit: 10,
});
if (failedJobs[0]) {
  await admin.retryJob(failedJobs[0].id, 'default');
}
```

## Constructor

```typescript
new RemqAdmin(db: RedisConnection, remq?: Remq)
```

`db` is the Redis connection used for CRUD and control operations. It should be
the same connection used by Remq so queue state is consistent. Optional `remq`
enables `onJobFinished()` and proper `retryJob()` (re-queues via `remq.emit()`).

## Types

| Type          | Purpose                            | Main fields                                                                                                         |
| ------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `Job`         | Stored job record                  | `id`, `state`, `status`, timestamps (`timestamp`, `lastRun`, `delayUntil`, `lockUntil`), `logs`, `errors`, `paused` |
| `ListOptions` | List/filter options for `listJobs` | `queue`, `status`, `limit`, `offset`                                                                                |
| `QueueStats`  | Per-queue status counts            | `queue`, `waiting`, `processing`, `completed`, `failed`, `delayed`, `total`                                         |
| `QueueInfo`   | Queue name + stats bundle          | `name`, `stats`                                                                                                     |

## Job

`Job` represents a stored job record.

```typescript
interface Job {
  id: string;
  state: {
    name: string;
    queue: string;
    data?: unknown;
    options?: Record<string, unknown>;
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
  errors: Array<{ message: string; stack?: string; timestamp: number }>;
  timestamp: number;
  lastRun?: number;
  paused?: boolean;
}
```

## ListOptions

```typescript
interface ListOptions {
  queue?: string;
  status?: 'waiting' | 'processing' | 'completed' | 'failed' | 'delayed';
  limit?: number;
  offset?: number;
}
```

`queue` is required by `listJobs` and is validated at runtime.

## QueueStats and QueueInfo

```typescript
interface QueueStats {
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
  stats: QueueStats;
}
```

## Methods

### `getJob(jobId: string, queue: string): Promise<Job | null>`

Params:

- `jobId` (string) - Job id to look up.
- `queue` (string) - Queue name to search.

Returns the job data or `null` if not found. The lookup checks all
known statuses (`waiting`, `processing`, `completed`, `failed`, `delayed`).

### `listJobs(options?: ListOptions): Promise<Job[]>`

Lists jobs for a queue with optional status filtering and pagination.

`ListOptions`:

- `queue` (required) - Queue name to list.
- `status` (optional) - Status filter (`waiting`, `processing`, `completed`, `failed`, `delayed`).
- `limit` (optional) - Max number of jobs to return.
- `offset` (optional) - Pagination offset.

```typescript
const jobs = await admin.listJobs({
  queue: 'default',
  status: 'failed',
  limit: 50,
  offset: 0,
});
```

Notes:

- `queue` is required and missing it throws.
- Jobs are sorted by `timestamp` (newest first).

### `deleteJob(jobId: string, queue: string): Promise<void>`

Deletes a job and its status keys from Redis.

### `stats(queue: string): Promise<QueueStats>`

Returns a `QueueStats` object with counts by status plus a `total` for a single queue.

### `queues(): Promise<string[]>`

Scans Redis keys and returns discovered queue names.

### `queuesInfo(): Promise<QueueInfo[]>`

Returns all queues with their statistics as `QueueInfo` objects (`name` + `stats`).

### `retryJob(jobId, queue)`

Retries a failed job. When RemqAdmin is constructed with a Remq instance, it uses
`remq.emit()` so the job is re-queued and processed. Returns the job or `null`
if not found. Throws if the job status is not `failed`. Only failed jobs can be retried. Without Remq, only
Redis state is updated (job is not re-queued to the stream).

### `cancelJob(jobId, queue)`, `pause`, `resume`, `isPaused`, `pauseJob`, `resumeJob`

Cancel/pause/resume jobs and queues. See core `libs/sdk/README.md` for details.

## Next Steps

- [Remq API](/reference/task-manager)
- [Consumer API](/reference/consumer)
- [Processor API](/reference/processor)
