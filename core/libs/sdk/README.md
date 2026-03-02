# Sdk

Client SDK for queue management: list jobs, retry, cancel, pause queues. Use from admin UIs or external clients.

## Features

- **Get Task by ID** - Retrieve a specific job
- **List Tasks** - List jobs with filtering (queue, status, pagination)
- **Delete Task** - Remove a job from the system
- **Get Queue Stats** - Get statistics for a queue (counts by status)
- **Get Queues** - List all queues
- **Retry Task** - Retry a failed job
- **Cancel Task** - Cancel a waiting/delayed job

## Usage

### Basic Setup

```typescript
import { Sdk } from '@core/mod.ts';
import { Redis } from 'ioredis';

const db = new Redis({
  port: 6379,
  host: 'localhost',
  db: 1,
});

const sdk = new Sdk(db);
```

### Get Task by ID

```typescript
const task = await sdk.getTask('job-id-123', 'default');

if (task) {
  console.log('Job status:', task.status);
  console.log('Job data:', task.state.data);
  console.log('Job logs:', task.logs);
}
```

### List Tasks

```typescript
const tasks = await sdk.listTasks({
  queue: 'default',
  limit: 50,
  offset: 0,
});

const failedTasks = await sdk.listTasks({
  queue: 'default',
  status: 'failed',
  limit: 20,
});
```

### Delete Task

```typescript
await sdk.deleteTask('job-id-123', 'default');
```

### Get Queue Statistics

```typescript
const stats = await sdk.getQueueStats('default');
console.log('Total:', stats.total, 'Failed:', stats.failed);
```

### Get All Queues

```typescript
const queues = await sdk.getQueues();
const queuesInfo = await sdk.getQueuesInfo();
```

### Retry / Cancel

```typescript
const retried = await sdk.retryTask('job-id-123', 'default');
const cancelled = await sdk.cancelTask('job-id-123', 'default');
```

### Pause / Resume

```typescript
await sdk.pause('default');  // or sdk.pause() to pause all queues
await sdk.resume('default'); // or sdk.resume() to resume all queues
const isPaused = await sdk.isPaused('default');
```

## Integration with TaskManager

Use `Sdk` alongside `TaskManager` for admin or external clients:

```typescript
import { Sdk, Remq } from '@core/mod.ts';

const remq = Remq.create({ db, streamdb, ctx: {}, concurrency: 4 });
const sdk = new Sdk(db);

// e.g. in HTTP handlers
const jobs = await sdk.listTasks({ queue: 'default', limit: 50 });
const job = await sdk.getTask(id, queue);
await sdk.deleteTask(id, queue);
```

## Types

Exported from `@core/mod.ts`: `AdminJobData`, `ListJobsOptions`, `TaskStats`, `QueueInfo`.
