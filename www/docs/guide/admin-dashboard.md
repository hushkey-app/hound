---
title: Admin Dashboard
description: Build admin dashboards with the Sdk for queue visibility and controls.
---

# Admin Dashboard

REMQ ships with the `Sdk` for building admin consoles and operational dashboards.
Use it to inspect queues, browse jobs, and perform control actions like pause,
retry, or cancel.

## When to add a dashboard

Add an admin dashboard when you need visibility into queue health, need to
inspect failed jobs, or want safe operational controls for on-call workflows.

## Connect Sdk

`Sdk` should use the same Redis connection as your Remq instance so it sees
consistent queue state.

```typescript
import Redis from 'npm:ioredis';
import { Sdk, Remq } from 'npm:@leotermine/tasker';

const db = new Redis({ host: '127.0.0.1', port: 6379 });
const remq = Remq.create({ db });
const sdk = new Sdk(db);
```

## Queue overview cards

Use `getQueuesInfo()` or `getQueueStats()` to populate queue summary tiles.
Each `TaskStats` entry includes per-status counts.

```typescript
const queues = await sdk.getQueuesInfo();
const stats = await sdk.getQueueStats('default');
```

## Job browser and detail views

List jobs with filters and display details with a task lookup.

```typescript
const failedTasks = await sdk.listTasks({
  queue: 'default',
  status: 'failed',
  limit: 25,
  offset: 0,
});

const task = await sdk.getTask(failedTasks[0]?.id ?? '', 'default');
```

## Control actions

Expose simple actions with guardrails. `retryTask()` and `deleteTask()` are the
most common controls when you need to re-run or cancel a job.

```typescript
if (failedTasks[0]) {
  await sdk.retryTask(failedTasks[0].id, 'default');
  await taskManager.emit({
    event: failedTasks[0].state.name,
    queue: failedTasks[0].state.queue,
    data: failedTasks[0].state.data,
    options: failedTasks[0].state.options,
  });
}

await sdk.deleteTask('job_123', 'default');
```

Notes:

- `retryTask()` only updates Redis state. Re-emit the job with `Remq.emit()`
  to actually process it.
- `deleteTask()` removes a job before it runs; treat it as a cancel action.

For full options and types, see the [Sdk API Reference](/reference/sdk).

## Recommended dashboard sections

- **Queue health**: `TaskStats` counts by status.
- **Job table**: filters for `status`, `queue`, and time range.
- **Job detail**: logs, errors, and retry history from `AdminJobData`.
- **Controls**: retry or delete jobs with clear guardrails.

## Next Steps

- Review the [Sdk API](/reference/sdk)
- Compare with [Task Management](/guide/task-management)
- Explore [Processor](/reference/processor) for handler policies
