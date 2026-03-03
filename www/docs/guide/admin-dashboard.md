---
title: Admin Dashboard
description: Build admin dashboards with RemqAdmin for queue visibility and controls.
---

# Admin Dashboard

REMQ ships with `RemqAdmin` for building admin consoles and operational dashboards.
Use it to inspect queues, browse jobs, and perform control actions like pause,
retry, or cancel.

## When to add a dashboard

Add an admin dashboard when you need visibility into queue health, need to
inspect failed jobs, or want safe operational controls for on-call workflows.

## Connect RemqAdmin

`RemqAdmin` should use the same Redis connection as your Remq instance so it sees
consistent queue state.

```typescript
import Redis from 'npm:ioredis';
import { Remq, RemqAdmin } from 'npm:@leotermine/tasker';

const db = new Redis({ host: '127.0.0.1', port: 6379 });
const remq = Remq.create({ db });
const admin = new RemqAdmin(db);
```

## Queue overview cards

Use `queuesInfo()` or `stats()` to populate queue summary tiles.
Each `QueueStats` entry includes per-status counts.

```typescript
const queues = await admin.queuesInfo();
const stats = await admin.stats('default');
```

## Job browser and detail views

List jobs with filters and display details with a job lookup.

```typescript
const failedJobs = await admin.listJobs({
  queue: 'default',
  status: 'failed',
  limit: 25,
  offset: 0,
});

const job = await admin.getJob(failedJobs[0]?.id ?? '', 'default');
```

## Control actions

Expose simple actions with guardrails. `retryJob()` and `deleteJob()` are the
most common controls when you need to re-run or remove a job.

```typescript
if (failedJobs[0]) {
  await admin.retryJob(failedJobs[0].id, 'default');
}

await admin.deleteJob('job_123', 'default');
```

Notes:

- When RemqAdmin is constructed with a Remq instance (`new RemqAdmin(db, remq)`), `retryJob()` uses `remq.emit()` so the job is re-queued and processed. Without Remq, only Redis state is updated.
- `deleteJob()` removes a job and its status keys; use it to cancel or clean up.

For full options and types, see the [RemqAdmin API Reference](/reference/sdk).

## Recommended dashboard sections

- **Queue health**: `TaskStats` counts by status.
- **Job table**: filters for `status`, `queue`, and time range.
- **Job detail**: logs, errors, and retry history from `AdminJobData`.
- **Controls**: retry or delete jobs with clear guardrails.

## Next Steps

- Review the [RemqAdmin API](/reference/sdk)
- Compare with [Task Management](/guide/task-management)
- Explore [Processor](/reference/processor) for handler policies
