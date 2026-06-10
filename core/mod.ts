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
export { HoundApp } from './libs/hound-app/mod.ts';
export type { TypedDefineJob } from './libs/hound-app/mod.ts';
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
export { Broker, JOB_FINISHED_CHANNEL } from './libs/broker/mod.ts';
export type { BrokerConnection } from './libs/broker/mod.ts';
export { generateClient, generateTypes } from './libs/codegen/mod.ts';
export type { ClientgenOptions, CodegenOptions } from './libs/codegen/mod.ts';
export { createGateway } from './libs/gateways/gateway.ts';
export type { GatewayOptions } from './libs/gateways/gateway.ts';

// ─── Core types ───────────────────────────────────────────────────────────────
export type {
  // Benchmarking
  BenchmarkOptions,
  BenchmarkResult,
  EmitAndWaitFunction,
  EmitAsyncFunction,
  // Emit
  EmitBatchEntry,
  EmitBatchFunction,
  // Emit function shapes
  EmitFunction,
  EmitOptions,
  // Handlers
  HandlerOptions,
  // Hound options
  HoundBroker,
  HoundMetrics,
  HoundOptions,
  JobContext,
  JobDefinition,
  JobError,
  JobHandler,
  // Job data (dashboard / log display)
  JobLog,
  JobSocketContext,
  MiddlewareFn,
  QueueMetrics,
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

/**
 * Type-safe `defineJob` bound to a specific app context. TData stays a
 * per-job generic so handlers declare their own payload shape (which
 * codegen then captures into `HoundJobMap`).
 *
 * Note: not parameterized over `TJobMap` on purpose — that would create a
 * circular type (job file → typed defineJob → HoundJobMap → job file).
 *
 * @deprecated Use {@link HoundApp} — its `defineJob` is typed against `TJobMap`
 * and narrows `ctx.emit*`. This manual-cast pattern is kept for back-compat only.
 *
 * @example
 * // plugins/hound.plugin.ts
 * import { defineJob as _defineJob } from '@hushkey/hound/mod.ts';
 * import type { BoundDefineJob } from '@hushkey/hound/mod.ts';
 * export const defineJob = _defineJob as BoundDefineJob<typeof contextApp>;
 *
 * // _tasks/request.job.ts
 * import { defineJob } from '../plugins/hound.plugin.ts';
 * export const userReadJob = defineJob<{ email: string }>('user.read', async (ctx) => {
 *   ctx.foo;          // typed from app context
 *   ctx.data.email;   // typed from TData
 * });
 */
export type BoundDefineJob<TApp extends Record<string, any>> = <
  TData = unknown,
>(
  event: string,
  handler: JobHandler<TApp, TData>,
  options?: HandlerOptions,
) => JobDefinition<TApp, TData>;

/**
 * Type-safe emit function narrowed to the job map from codegen.
 * @deprecated Use {@link HoundApp} — `app.hound.emit` is already narrowed.
 */
export type TypedEmit<TJobMap extends object> = <
  K extends keyof TJobMap,
>(event: K, data: TJobMap[K], options?: BoundEmitOptions) => string;

/**
 * Type-safe emitAsync narrowed to the job map from codegen.
 * @deprecated Use {@link HoundApp} — `app.hound.emitAsync` is already narrowed.
 */
export type TypedEmitAsync<TJobMap extends object> = <
  K extends keyof TJobMap,
>(event: K, data: TJobMap[K], options?: BoundEmitOptions) => Promise<string>;

/**
 * Type-safe emitBatch narrowed to the job map from codegen.
 * @deprecated Use {@link HoundApp} — `app.hound.emitBatch` is already narrowed.
 */
export type TypedEmitBatch<TJobMap extends object> = (
  jobs: {
    [K in keyof TJobMap]: {
      event: K;
      data: TJobMap[K];
      options?: BoundEmitOptions;
    };
  }[keyof TJobMap][],
) => Promise<string[]>;

/**
 * Type-safe handler registration narrowed to the job map from codegen.
 * @deprecated Use {@link HoundApp} — `app.hound.on` is already narrowed.
 */
export interface TypedOn<
  TApp extends Record<string, any>,
  TJobMap extends object,
> {
  <K extends keyof TJobMap>(
    definition: JobDefinition<TApp, TJobMap[K]> & { event: K },
  ): TypedHound<TApp, TJobMap>;
  <K extends keyof TJobMap>(
    event: K,
    handler: JobHandler<TApp, TJobMap[K]>,
    options?: HandlerOptions,
  ): TypedHound<TApp, TJobMap>;
}

/**
 * Cast a Hound instance to have type-safe emit and on methods.
 *
 * @deprecated Use {@link HoundApp} — it owns a `TypedHound` internally and
 * exposes it as `app.hound`. This manual-cast pattern is kept for back-compat only.
 *
 * @example
 * import type { HoundJobMap } from '../types/hound-types.ts';
 * import type { TypedHound } from '@core/mod.ts';
 *
 * const hound = Hound.create({ ... }) as TypedHound<typeof ctx, HoundJobMap>;
 * hound.emit('user.read', { email: '...' }); // typed!
 * hound.on('user.read', async (ctx) => ctx.data.email); // ctx.data typed!
 */
export type TypedHound<
  TApp extends Record<string, any> = Record<string, any>,
  TJobMap extends object = Record<string, any>,
> =
  & Omit<Hound<TApp>, 'emit' | 'emitAsync' | 'emitAndWait' | 'emitBatch' | 'on'>
  & {
    emit: TypedEmit<TJobMap>;
    emitAsync: TypedEmitAsync<TJobMap>;
    emitAndWait: <K extends keyof TJobMap>(
      event: K,
      data: TJobMap[K],
      options?: BoundEmitOptions & { timeoutMs?: number },
    ) => Promise<string>;
    emitBatch: TypedEmitBatch<TJobMap>;
    on: TypedOn<TApp, TJobMap>;
  };
