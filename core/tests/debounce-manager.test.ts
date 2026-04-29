import { assertEquals } from 'jsr:@std/assert';
import { DebounceManager } from '../libs/processor/debounce-manager.ts';
import { sleep } from './helpers.ts';

const msg = (id: string, data: Record<string, unknown> = {}) =>
  ({ id, queue: 'default', data }) as unknown as import('../types/index.ts').Message;

Deno.test('DebounceManager: allows first-ever call (no history)', () => {
  const dm = new DebounceManager(60);
  assertEquals(dm.shouldProcess(msg('a')), true);
});

Deno.test('DebounceManager: suppresses duplicate within window after markProcessed', () => {
  const dm = new DebounceManager(60); // 60s window
  dm.markProcessed(msg('a'));
  assertEquals(dm.shouldProcess(msg('a')), false);
});

Deno.test('DebounceManager: allows same key after window expires', async () => {
  const dm = new DebounceManager(0.01); // 10ms window
  dm.markProcessed(msg('a'));
  await sleep(20);
  assertEquals(dm.shouldProcess(msg('a')), true);
});

Deno.test('DebounceManager: independent keys do not interfere', () => {
  const dm = new DebounceManager(60);
  dm.markProcessed(msg('a'));
  assertEquals(dm.shouldProcess(msg('a')), false); // debounced
  assertEquals(dm.shouldProcess(msg('b')), true);  // untouched
});

Deno.test('DebounceManager: custom keyFn groups by derived key', () => {
  const dm = new DebounceManager(60, (m) => String((m.data as any).topic));
  const m1 = msg('j1', { topic: 'orders' });
  const m2 = msg('j2', { topic: 'orders' });
  dm.markProcessed(m1);
  // j2 has a different ID but same topic — should be debounced
  assertEquals(dm.shouldProcess(m2), false);
});

Deno.test('DebounceManager: cleanup removes entries older than 2x window', async () => {
  const dm = new DebounceManager(0.01); // 10ms
  dm.markProcessed(msg('a'));
  assertEquals(dm.size, 1);
  await sleep(30); // > 2x window
  dm.cleanup();
  assertEquals(dm.size, 0);
});

Deno.test('DebounceManager: cleanup does not remove entries within 2x window', () => {
  const dm = new DebounceManager(60);
  dm.markProcessed(msg('a'));
  dm.cleanup();
  assertEquals(dm.size, 1); // still within window
});
