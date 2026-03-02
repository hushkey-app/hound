/**
 * admin.ts — types for RemqAdmin and dashboard queries
 */

export interface Job {
  id: string;
  status: 'waiting' | 'processing' | 'completed' | 'failed' | 'delayed';
  paused?: boolean;

  // Job identity
  state: {
    name: string;
    queue: string;
    data: unknown;
    options?: Record<string, unknown>;
  };

  // Timing
  timestamp: number;
  delayUntil: number;
  lockUntil: number;
  lastRun?: number;

  // Retry
  retryCount: number;
  retryDelayMs: number;
  retriedAttempts: number;

  // Cron
  repeatCount: number;
  repeatDelayMs: number;

  // Observability
  logs: { message: string; timestamp: number }[];
  errors: { message: string; stack?: string; timestamp: number }[];

  // Misc
  priority: number;
}

export interface QueueStats {
  queue: string;
  waiting: number;
  processing: number;
  completed: number;
  failed: number;
  delayed: number;
  total: number;
}

export interface QueueInfo {
  name: string;
  stats: QueueStats;
}

export interface ListOptions {
  queue?: string;
  status?: Job['status'];
  limit?: number;
  offset?: number;
}
