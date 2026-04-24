/**
 * Hound — job queue and worker runtime. Export point for Hound, HoundManagement, and defineJob.
 *
 * @module
 */
import { HandlerOptions, JobDefinition, JobHandler } from './types/index.ts';

/**
 * Type-safe job definition factory. Use instead of hound.on() directly when you want ctx.data typed.
 *
 * @param event - Event/job name (e.g. 'property.sync')
 * @param handler - Async handler; ctx.data is typed by TData
 * @param options - Optional queue, repeat, attempts, debounce
 * @returns JobDefinition to pass to hound.on()
 *
 * @example
 * const syncJob = defineJob<AppCtx, { propertyId: number }>('property.sync', async (ctx) => {
 *   ctx.data.propertyId; // typed as number
 * }, { queue: 'sync', attempts: 3 });
 * hound.on(syncJob);
 */
export function defineJob<
  TApp extends Record<string, unknown> = Record<string, unknown>,
  TData = unknown,
>(
  event: string,
  handler: JobHandler<TApp, TData>,
  options?: HandlerOptions,
): JobDefinition<TApp, TData> {
  return { event, handler, options };
}

export { Hound } from './libs/hound/mod.ts';
export { HoundManagement } from './libs/hound-management/mod.ts';
export { InMemoryStorage } from './libs/storage/in-memory.ts';
export { DenoKvStorage } from './libs/storage/deno-kv.ts';
