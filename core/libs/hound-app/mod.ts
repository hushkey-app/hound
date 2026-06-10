/**
 * HoundApp — typed bundle of a Hound runtime, its management API, and a
 * type-safe `defineJob`. Pass `<TApp, TJobMap>` once and consume typed
 * handles everywhere.
 *
 * @example
 * import { HoundApp } from '@hushkey/hound/mod.ts';
 * import type { HoundJobMap } from '../gen/hound-types.ts';
 *
 * const ctx = { foo: 'bar' };
 * export const app = new HoundApp<typeof ctx, HoundJobMap>({
 *   db, ctx, importMeta: import.meta, jobDirs: ['../_tasks'],
 * });
 *
 * export const { hound, management, defineJob } = app;
 *
 * @module
 */
import { defineJob as _defineJob } from '../../mod.ts';
import { Hound } from '../hound/mod.ts';
import { HoundManagement } from '../hound-management/mod.ts';
import type {
  HandlerOptions,
  HoundOptions,
  JobContext,
  JobDefinition,
} from '../../types/index.ts';
import type {
  BoundEmitOptions,
  TypedEmit,
  TypedEmitAsync,
  TypedEmitBatch,
  TypedHound,
} from '../../mod.ts';

/**
 * Job handler context with typed `emit` family — narrowed to the job map so
 * `ctx.emit('event', data)` is checked against `TJobMap`. Standard
 * `JobContext` fields (id, name, data, logger, etc.) are unchanged.
 */
export type TypedJobContext<
  TApp extends Record<string, unknown>,
  TJobMap extends object,
  TData = unknown,
> =
  & Omit<
    JobContext<TApp, TData>,
    'emit' | 'emitAsync' | 'emitAndWait' | 'emitBatch'
  >
  & {
    emit: TypedEmit<TJobMap>;
    emitAsync: TypedEmitAsync<TJobMap>;
    emitAndWait: <K extends keyof TJobMap>(
      event: K,
      data: TJobMap[K],
      options?: BoundEmitOptions & { timeoutMs?: number },
    ) => Promise<string>;
    emitBatch: TypedEmitBatch<TJobMap>;
  };

/**
 * `defineJob` with typed `ctx.emit` family. `event` and `TData` are free —
 * job definitions are the source of truth for `HoundJobMap`, so they cannot
 * be constrained by it without circularity. Only the handler's `ctx.emit*`
 * methods get narrowed against `TJobMap`.
 */
export type TypedDefineJob<
  TApp extends Record<string, unknown>,
  TJobMap extends object,
> = <TData = unknown>(
  event: string,
  handler: (ctx: TypedJobContext<TApp, TJobMap, TData>) => void | Promise<void>,
  options?: HandlerOptions,
) => JobDefinition<TApp, TData>;

/**
 * Bundles a typed Hound instance, management API, and `defineJob` factory
 * under a single generic application of `<TApp, TJobMap>`.
 */
export class HoundApp<
  TApp extends Record<string, unknown> = Record<string, unknown>,
  TJobMap extends object = Record<string, any>,
> {
  readonly hound: TypedHound<TApp, TJobMap>;
  readonly management: HoundManagement;
  readonly defineJob: TypedDefineJob<TApp, TJobMap>;
  readonly #hound: Hound<TApp>;

  constructor(options: HoundOptions<TApp>) {
    const _hound = Hound.create<TApp>(options);
    this.#hound = _hound;
    this.hound = _hound as unknown as TypedHound<TApp, TJobMap>;
    this.management = new HoundManagement({ db: options.db, hound: _hound });
    this.defineJob = _defineJob as unknown as TypedDefineJob<TApp, TJobMap>;
  }

  /**
   * Start the HTTP gateway with this app's management API already attached —
   * /emit*, /events, and the full /management/* surface in one call.
   * Equivalent to `hound.listen(port, app.management)`.
   */
  listen(port: number, onListen?: (addr: Deno.NetAddr) => void): this {
    this.#hound.listen(port, this.management, onListen);
    return this;
  }
}
