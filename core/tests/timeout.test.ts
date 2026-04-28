/**
 * Per-handler timeout tests — run against InMemoryStorage.
 */
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert';
import { withHound } from './helpers.ts';

Deno.test('job completes normally when handler finishes before timeout', () =>
  withHound(async (h) => {
    let ran = false;
    h.on('timeout.fast', async () => { ran = true; }, { timeoutMs: 500 });
    await h.start();
    await h.emitAndWait('timeout.fast', {}, { timeoutMs: 3000 });
    assertEquals(ran, true);
  }));

Deno.test('job fails when handler exceeds timeoutMs', () =>
  withHound(async (h) => {
    // Use a manually-resolved Promise instead of setTimeout so there's no
    // abandoned timer after Promise.race rejects — resolve it after assertRejects.
    let unblock!: () => void;
    const block = new Promise<void>((r) => { unblock = r; });

    h.on('timeout.slow', () => block, { timeoutMs: 50 });

    await h.start();
    await assertRejects(
      () => h.emitAndWait('timeout.slow', {}, { timeoutMs: 3000 }),
      Error,
    );
    unblock();
  }));

Deno.test('timeout error message includes job name and duration', () =>
  withHound(async (h) => {
    let unblock!: () => void;
    const block = new Promise<void>((r) => { unblock = r; });

    h.on('timeout.msg', () => block, { timeoutMs: 50 });

    await h.start();
    let message = '';
    try {
      await h.emitAndWait('timeout.msg', {}, { timeoutMs: 3000 });
    } catch (e: any) {
      message = e.message;
    }
    assert(message.includes('timeout.msg'), `expected job name in error: ${message}`);
    assert(message.includes('50ms'), `expected duration in error: ${message}`);
    unblock();
  }));

Deno.test('timeout applies to the full middleware + handler chain', () =>
  withHound(async (h) => {
    let unblock!: () => void;
    const block = new Promise<void>((r) => { unblock = r; });

    h.use(async (_ctx, next) => {
      await block;
      await next();
    });

    h.on('timeout.mw', async () => {}, { timeoutMs: 50 });

    await h.start();
    await assertRejects(
      () => h.emitAndWait('timeout.mw', {}, { timeoutMs: 3000 }),
      Error,
    );
    unblock();
  }));

Deno.test('no timeout when timeoutMs is not set', () =>
  withHound(async (h) => {
    let ran = false;
    h.on('timeout.none', async () => {
      await new Promise((r) => setTimeout(r, 100));
      ran = true;
    });

    await h.start();
    await h.emitAndWait('timeout.none', {}, { timeoutMs: 3000 });
    assertEquals(ran, true);
  }));
