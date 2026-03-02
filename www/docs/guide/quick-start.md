---
title: Quick Start
description: Install REMQ and schedule your first task.
---

# Quick Start

Get up and running with REMQ in minutes.

## Installation

First, install REMQ and a Redis client:

```bash
deno add npm:@leotermine/tasker npm:ioredis
```

## Basic Example

Here's a simple example to get you started:

```typescript
import Redis from 'npm:ioredis';
import { Remq } from 'npm:@leotermine/tasker';

const db = new Redis({
  host: '127.0.0.1',
  port: 6379,
});

const remq = Remq.create({ db });

await taskManager.registerHandler({
  event: 'send-welcome',
  handler: async (job) => {
    console.log('Sending welcome email for', job.data?.userId);
  },
});

await taskManager.start();

await taskManager.emit({
  event: 'send-welcome',
  data: { userId: 'user_123' },
});

console.log('Job queued!');
```

For full options and types, see the
[Remq API Reference](/reference/task-manager).

## What's Next?

- Learn about [Task Management](/guide/task-management)
- Explore [Message Queues](/guide/message-queues)
- Check out the [Remq API Reference](/reference/task-manager)
