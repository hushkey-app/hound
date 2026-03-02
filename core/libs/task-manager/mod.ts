/**
 * Remq - High-level API for task/job management
 *
 * Simple, developer-friendly API built on top of Consumer + Processor
 */

export { Remq } from './remq.ts';
export type {
  TaskManagerOptions,
  TaskHandler,
  TaskContext,
  EmitFunction,
  EmitOptions,
  HandlerOptions,
} from '../../types/task-manager.ts';

