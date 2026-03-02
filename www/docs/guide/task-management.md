---
title: Task Management
description: Define jobs, schedules, and retries with Remq.
---

# Task Management

Use Remq to register handlers, emit jobs, and control scheduling
and retries.

## Core Concepts

- **Handlers** map an `event` name to your async job logic.
- **Events** are job names that producers emit and handlers consume.
- **Queues** isolate workloads (defaults to `default`).

## Register a Handler

Define how a job should be processed. Handler options can add repeats,
attempt limits, and debounce windows.

For full options and types, see the
[Remq API Reference](/reference/task-manager).

```typescript
import Redis from 'npm:ioredis';
import { Remq } from 'npm:@leotermine/tasker';

const db = new Redis({ host: '127.0.0.1', port: 6379 });
const remq = Remq.create({ db });

await taskManager.registerHandler({
  event: 'send-email',
  queue: 'emails',
  handler: async (job) => {
    console.log('Email job', job.id, job.data?.to);
  },
  options: {
    repeat: { pattern: '0 9 * * *' },
    attempts: 3,
    debounce: 60_000,
  },
});
```

## Emit Jobs

Use `emit()` to enqueue work and control when it runs.

```typescript
await taskManager.emit({
  event: 'send-email',
  queue: 'emails',
  data: { to: 'user@example.com', subject: 'Welcome' },
  options: {
    id: 'welcome-user-123',
    priority: 5,
    delayUntil: new Date(Date.now() + 60_000),
    retryCount: 2,
    retryDelayMs: 2_000,
    repeat: { pattern: '0 9 * * 1' },
    attempts: 3,
    debounce: 30_000,
  },
});
```

## Next Steps

- Explore all options in the [Remq API](/reference/task-manager)
- Learn about [Message Queues](/guide/message-queues)
- Understand [Consumers](/guide/consumers)
