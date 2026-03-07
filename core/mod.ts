/**
 * Remq — job queue and worker runtime. Export point for Remq, RemqManagement, and defineJob.
 *
 * @module
 */
import { HandlerOptions, JobDefinition, JobHandler } from './types/index.ts';

/**
 * Type-safe job definition factory. Use instead of remq.on() directly when you want ctx.data typed.
 *
 * @param event - Event/job name (e.g. 'property.sync')
 * @param handler - Async handler; ctx.data is typed by TData
 * @param options - Optional queue, repeat, attempts, debounce
 * @returns JobDefinition to pass to remq.on()
 *
 * @example
 * const syncJob = defineJob<AppCtx, { propertyId: number }>('property.sync', async (ctx) => {
 *   ctx.data.propertyId; // typed as number
 * }, { queue: 'sync', attempts: 3 });
 * remq.on(syncJob);
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

export { Remq } from './libs/remq/mod.ts';
export { RemqManagement } from './libs/remq-management/mod.ts';
