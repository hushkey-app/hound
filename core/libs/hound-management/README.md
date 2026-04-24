# RemqAdmin

Client for queue administration: list jobs, retry, cancel, pause queues. Use from admin UIs or external clients.

## Features

- **Get Job by ID** - Retrieve a specific job
- **List Jobs** - List jobs with filtering (queue, status, pagination)
- **Delete Job** - Remove a job from the system
- **Get Queue Stats** - Get statistics for a queue (counts by status)
- **Get Queues** - List all queues
- **Retry Job** - Retry a failed job
- **Cancel Job** - Cancel a waiting/delayed job
- **Promote Job** - Promote a delayed or waiting job to run now (manual "run now")

## Usage

### Basic Setup

```typescript
import { RemqAdmin } from '@core/mod.ts';
import { Redis } from 'ioredis';

const db = new Redis({
  port: 6379,
  host: 'localhost',
  db: 1,
});

const admin = new RemqAdmin(db);

// Optional: pass Remq to enable onJobFinished()
// const admin = new RemqAdmin(db, remq);
```

### Constructor

- `new RemqAdmin(db: RedisConnection, remq?: Remq)` — `remq` is optional. When provided, `admin.onJobFinished(cb)` and `admin.retryJob()` use Remq's emit path.

### Get Job by ID

```typescript
const job = await admin.getJob('job-id-123', 'default');

if (job) {
  console.log('Job status:', job.status);
  console.log('Job data:', job.state.data);
  console.log('Job logs:', job.logs);
}
```

### List Jobs

```typescript
const jobs = await admin.listJobs({
  queue: 'default',
  limit: 50,
  offset: 0,
});

const failedJobs = await admin.listJobs({
  queue: 'default',
  status: 'failed',
  limit: 20,
});
```

### Delete Job

```typescript
await admin.deleteJob('job-id-123', 'default');
```

### Get Queue Statistics

```typescript
const stats = await admin.stats('default');
console.log('Total:', stats.total, 'Failed:', stats.failed);
```

### Get All Queues

```typescript
const queues = await admin.queues();
const queuesInfo = await admin.queuesInfo();
```

### Retry / Cancel / Promote

```typescript
const retried = await admin.retryJob('job-id-123', 'default');
const cancelled = await admin.cancelJob('job-id-123', 'default');

// Promote a delayed or waiting job to run now (requires Remq — uses enqueueJobToStream)
const promoted = await admin.promoteJob('job-id-123', 'default');
if (promoted) {
  console.log('Job promoted, processor will pick it up immediately');
}
```

### Pause / Resume

```typescript
await admin.pause('default'); // or admin.pause() to pause all queues
await admin.resume('default'); // or admin.resume() to resume all queues
const isPaused = await admin.isPaused('default');
```

### Job finished (requires Remq)

When RemqAdmin is constructed with a Remq instance, you can subscribe to job completion:

```typescript
const admin = new RemqAdmin(db, remq);
const unsubscribe = admin.onJobFinished((payload) => {
  console.log('Job finished:', payload.jobId, payload.status);
});
// later: unsubscribe();
```

## Integration with Remq

Use `RemqAdmin` alongside Remq for admin or external clients:

```typescript
import { Remq, RemqAdmin } from '@core/mod.ts';

const remq = Remq.create({ db, streamdb, ctx: {}, concurrency: 4 });
const admin = new RemqAdmin(db);

// e.g. in HTTP handlers
const jobs = await admin.listJobs({ queue: 'default', limit: 50 });
const job = await admin.getJob(id, queue);
await admin.deleteJob(id, queue);
```

## Types

Exported from `@core/mod.ts`: `Job`, `Job` (alias of `Job`), `ListOptions`, `QueueStats`, `QueueInfo`.
