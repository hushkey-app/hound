import { Remq } from '../mod.ts';
import type { RedisConnection } from '../types/redis-client.ts';

Deno.test('Remq applies documented defaults and on() queue default', () => {
  const RemqAny = Remq as unknown as { instance?: unknown };
  RemqAny.instance = undefined;

  const fakeRedis = {} as unknown as RedisConnection;
  const manager = Remq.create({ db: fakeRedis, streamdb: fakeRedis });
  const internal = manager as unknown as {
    concurrency: number;
    streamdb: unknown;
    ctx: { emit?: unknown };
    processorOptions?: Record<string, unknown>;
    queueStreams: Set<string>;
    handlers: Map<string, unknown>;
  };

  if (internal.concurrency !== 1) {
    throw new Error(
      `Expected concurrency default 1, got ${internal.concurrency}`,
    );
  }

  if (internal.streamdb !== fakeRedis) {
    throw new Error('Expected streamdb to be the provided connection');
  }

  if (typeof internal.ctx?.emit !== 'function') {
    throw new Error('Expected ctx.emit to be injected');
  }

  if (Object.keys(internal.processorOptions ?? {}).length !== 0) {
    throw new Error('Expected processorOptions to default to {}');
  }

  manager.on('default-queue-check', () => {});

  if (!internal.queueStreams.has('default-stream')) {
    throw new Error('Expected default queue stream to be registered');
  }

  if (!internal.handlers.has('default:default-queue-check')) {
    throw new Error('Expected default queue handler key to be registered');
  }

  RemqAny.instance = undefined;
});
