/**
 * Core V2 - Main exports
 * 
 * High-level API for task/job management
 */

export { Remq } from './libs/task-manager/mod.ts';
export type {
  TaskManagerOptions,
  TaskHandler,
  TaskContext,
  EmitFunction,
  EmitOptions,
  HandlerOptions,
} from './types/task-manager.ts';

// Re-export lower-level APIs if needed
export { Processor } from './libs/processor/mod.ts';
export { Consumer } from './libs/consumer/mod.ts';
export type {
  ProcessorOptions,
  ConsumerOptions,
  Message,
  MessageHandler,
} from './types/index.ts';

// Export SDK
export { Sdk } from './libs/sdk/mod.ts';
export type {
  AdminJobData,
  ListJobsOptions,
  TaskStats,
  QueueInfo,
} from './types/admin.ts';

