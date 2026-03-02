/**
 * Core V2 - Main exports
 *
 * High-level API for job management
 */

export { Remq } from './libs/remq/mod.ts';
export type {
  EmitFunction,
  EmitOptions,
  HandlerOptions,
  TaskContext,
  TaskHandler,
  TaskManagerOptions,
} from './types/remq.ts';

// Re-export lower-level APIs if needed
export { Processor } from './libs/processor/mod.ts';
export { Consumer } from './libs/consumer/mod.ts';
export type {
  ConsumerOptions,
  Message,
  MessageHandler,
  ProcessorOptions,
} from './types/index.ts';

// Export SDK
export { RemqAdmin } from './libs/remq-admin/mod.ts';
export type { Job, ListOptions, QueueInfo, QueueStats } from './types/admin.ts';
