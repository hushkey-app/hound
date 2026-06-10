/**
 * Job index — sorted-set indexes over job state keys, so management reads
 * (find, stats, queue discovery) are index lookups instead of full keyspace
 * SCANs.
 *
 * Layout (outside the queues:* namespace so state-key patterns never match):
 *   hound:queues                     zset — queue registry; member = queue name
 *   hound:idx:{queue}:{status}       zset — member = full state key,
 *                                           score  = transition timestamp ms
 *
 * Maintained inline by the engine's existing write pipelines (emit,
 * transition, retry, reap) — index upkeep costs extra pipelined ops, not
 * extra round trips. State keys expire via jobStateTtlSeconds but zset
 * members do not, so the Reaper trims indexes by score and readers lazily
 * remove members whose state key is gone.
 *
 * @module
 */

/** Queue registry zset — member = queue name, score = last-registered ms. */
export const QUEUE_REGISTRY_KEY = 'hound:queues';

export const ACTIVE_STATUSES = ['processing', 'waiting', 'delayed'] as const;
export const TERMINAL_STATUSES = ['completed', 'failed'] as const;
export const ALL_STATUSES = [
  ...ACTIVE_STATUSES,
  ...TERMINAL_STATUSES,
] as const;

export type JobStatus = (typeof ALL_STATUSES)[number];

export interface ParsedStateKey {
  queue: string;
  jobId: string;
  status: JobStatus;
  execId?: string;
}

/** Index zset key for a queue + status. */
export function indexKey(queue: string, status: string): string {
  return `hound:idx:${queue}:${status}`;
}

/**
 * Parse a job state key. Status is suffix-anchored against the closed status
 * set, so jobIds containing colons still parse correctly:
 *   queues:{queue}:{jobId}:{status}            (active)
 *   queues:{queue}:{jobId}:{status}:{execId}   (terminal)
 */
export function parseStateKey(key: string): ParsedStateKey | null {
  const segs = key.split(':');
  if (segs[0] !== 'queues' || segs.length < 4) return null;
  const queue = segs[1];

  const last = segs[segs.length - 1];
  if ((ACTIVE_STATUSES as readonly string[]).includes(last)) {
    const jobId = segs.slice(2, -1).join(':');
    if (!jobId) return null;
    return { queue, jobId, status: last as JobStatus };
  }

  const prev = segs[segs.length - 2];
  if ((TERMINAL_STATUSES as readonly string[]).includes(prev)) {
    const jobId = segs.slice(2, -2).join(':');
    if (!jobId) return null;
    return { queue, jobId, status: prev as JobStatus, execId: last };
  }

  return null;
}

/** Index zset key a state key belongs in, or null for non-state keys. */
export function indexKeyForState(stateKey: string): string | null {
  const parsed = parseStateKey(stateKey);
  return parsed ? indexKey(parsed.queue, parsed.status) : null;
}
