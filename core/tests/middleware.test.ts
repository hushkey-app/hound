/**
 * Middleware tests — hound.use() integration, run against InMemoryStorage.
 */
import { assertEquals, assertRejects } from 'jsr:@std/assert';
import { withHound } from './helpers.ts';

Deno.test('middleware runs before and after the handler', () =>
  withHound(async (h) => {
    const order: string[] = [];

    h.use(async (ctx, next) => {
      order.push('before');
      await next();
      order.push('after');
    });

    h.on('mw.order', async () => { order.push('handler'); });

    await h.start();
    await h.emitAndWait('mw.order', {}, { timeoutMs: 3000 });

    assertEquals(order, ['before', 'handler', 'after']);
  }));

Deno.test('multiple middleware run in registration order', () =>
  withHound(async (h) => {
    const order: string[] = [];

    h.use(async (_ctx, next) => { order.push('mw1-before'); await next(); order.push('mw1-after'); });
    h.use(async (_ctx, next) => { order.push('mw2-before'); await next(); order.push('mw2-after'); });

    h.on('mw.multi', async () => { order.push('handler'); });

    await h.start();
    await h.emitAndWait('mw.multi', {}, { timeoutMs: 3000 });

    assertEquals(order, ['mw1-before', 'mw2-before', 'handler', 'mw2-after', 'mw1-after']);
  }));

Deno.test('middleware receives correct ctx fields', () =>
  withHound(async (h) => {
    let seenName: string | undefined;
    let seenQueue: string | undefined;

    h.use(async (ctx, next) => {
      seenName = ctx.name;
      seenQueue = ctx.queue;
      await next();
    });

    h.on('mw.ctx', async () => {}, { queue: 'myqueue' });

    await h.start();
    await h.emitAndWait('mw.ctx', {}, { timeoutMs: 3000 });

    assertEquals(seenName, 'mw.ctx');
    assertEquals(seenQueue, 'myqueue');
  }));

Deno.test('middleware that throws fails the job', () =>
  withHound(async (h) => {
    h.use(async (_ctx, _next) => {
      throw new Error('middleware boom');
    });

    h.on('mw.throw', async () => {});

    await h.start();

    await assertRejects(
      () => h.emitAndWait('mw.throw', {}, { timeoutMs: 3000 }),
      Error,
    );
  }));

Deno.test('middleware that skips next() prevents handler from running', () =>
  withHound(async (h) => {
    let handlerRan = false;

    h.use(async (_ctx, _next) => {
      // intentionally does not call next()
    });

    h.on('mw.skip', async () => { handlerRan = true; });

    await h.start();
    // job completes (middleware resolved without error) but handler never ran
    await h.emitAndWait('mw.skip', {}, { timeoutMs: 3000 });

    assertEquals(handlerRan, false);
  }));

Deno.test('use() is chainable', () =>
  withHound(async (h) => {
    let count = 0;

    h
      .use(async (_ctx, next) => { count++; await next(); })
      .use(async (_ctx, next) => { count++; await next(); });

    h.on('mw.chain', async () => {});

    await h.start();
    await h.emitAndWait('mw.chain', {}, { timeoutMs: 3000 });

    assertEquals(count, 2);
  }));
