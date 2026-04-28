/**
 * Hound — job queue and worker runtime. Export point for Hound, HoundManagement, and defineJob.
 *
 * @module
 */
import type {
  EmitOptions,
  HandlerOptions,
  JobDefinition,
  JobHandler,
} from './types/index.ts';
import type { Hound } from './libs/hound/mod.ts';

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
  TApp extends Record<string, any> = Record<string, any>,
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
export type {
  FindJobsOptions,
  HoundManagementOptions,
  JobFinishedPayload,
  JobRecord,
  QueueRecord,
  QueueStats,
} from './libs/hound-management/mod.ts';
export { InMemoryStorage } from './libs/storage/in-memory.ts';
export { DenoKvStorage } from './libs/storage/deno-kv.ts';
export { generateClient, generateTypes } from './libs/codegen/mod.ts';
export type { ClientgenOptions, CodegenOptions } from './libs/codegen/mod.ts';
export { createGateway } from './libs/gateways/gateway.ts';
export type { GatewayOptions } from './libs/gateways/gateway.ts';

// ─── Core types ───────────────────────────────────────────────────────────────
export type {
  // Benchmarking
  BenchmarkOptions,
  BenchmarkResult,
  DlqConfig,
  EmitAndWaitFunction,
  EmitAsyncFunction,
  // Emit function shapes
  EmitFunction,
  EmitOptions,
  // Handlers
  HandlerOptions,
  // Hound options
  HoundOptions,
  MiddlewareFn,
  JobContext,
  JobDefinition,
  JobError,
  JobHandler,
  // Job data (dashboard / log display)
  JobLog,
  JobSocketContext,
  RedisConnection,
  RepeatOptions,
  // Processor config
  RetryConfig,
  // Storage
  StorageClient,
} from './types/index.ts';

// ─── Typed emit helpers ───────────────────────────────────────────────────────

/** Emit options without `queue` — queue is owned by defineJob and auto-resolved. */
export type BoundEmitOptions = Omit<EmitOptions, 'queue'>;

/** Type-safe emit function narrowed to the job map from codegen. */
export type TypedEmit<TJobMap extends Record<string, any>> = <
  K extends keyof TJobMap,
>(event: K, data: TJobMap[K], options?: BoundEmitOptions) => string;

/** Type-safe emitAsync narrowed to the job map from codegen. */
export type TypedEmitAsync<TJobMap extends Record<string, any>> = <
  K extends keyof TJobMap,
>(event: K, data: TJobMap[K], options?: BoundEmitOptions) => Promise<string>;

/**
 * Cast a Hound instance to have type-safe emit methods.
 *
 * @example
 * import type { HoundJobMap } from '../types/hound-types.ts';
 * import type { TypedHound } from '@core/mod.ts';
 *
 * const hound = Hound.create({ ... }) as TypedHound<typeof ctx, HoundJobMap>;
 * hound.emit('user.read', { email: '...' }); // typed!
 */
export type TypedHound<
  TApp extends Record<string, any> = Record<string, any>,
  TJobMap extends Record<string, any> = Record<string, any>,
> = Omit<Hound<TApp>, 'emit' | 'emitAsync' | 'emitAndWait'> & {
  emit: TypedEmit<TJobMap>;
  emitAsync: TypedEmitAsync<TJobMap>;
  emitAndWait: <K extends keyof TJobMap>(
    event: K,
    data: TJobMap[K],
    options?: BoundEmitOptions & { timeoutMs?: number },
  ) => Promise<string>;
};
