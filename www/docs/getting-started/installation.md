---
title: Installation
description: Prerequisites and install steps for REMQ and Redis.
---

# Installation

## Prerequisites

- Deno 2.5 or higher
- Redis server running

## Install

```bash
deno add npm:@leotermine/tasker
```

Or import directly:

```typescript
import { Remq } from 'npm:@leotermine/tasker';
```

## Setup Redis

Make sure you have Redis running on your system:

```bash
# Using Docker
docker run -d -p 6379:6379 redis:latest

# Or install locally
# macOS
brew install redis
brew services start redis

# Linux
sudo apt-get install redis-server
sudo systemctl start redis
```

## Next Steps

- [Introduction](/) - Overview and features
- [Quick Start](/guide/quick-start) - Run your first task
