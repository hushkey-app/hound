/**
 * Typed errors — replaces string-matching on error messages for retry decisions.
 *
 * @module
 */

/**
 * Non-retryable configuration error — wrong wiring, not a transient failure.
 * Thrown for missing handlers and malformed job payloads. Jobs failing with
 * this error are never retried, regardless of their retry budget.
 */
export class HoundConfigError extends Error {
  override readonly name = 'HoundConfigError';
}

/**
 * True when the error marks a configuration problem that retrying cannot fix.
 * Checks the error name as well as instanceof, so detection survives
 * duplicate module instances (e.g. mixed jsr/file imports).
 */
export function isConfigError(error: unknown): boolean {
  return error instanceof HoundConfigError ||
    (error instanceof Error && error.name === 'HoundConfigError');
}

/**
 * Wait timeout — the job did not reach a terminal state within the window.
 * Thrown by emitAndWait. Distinct from job failure: the job may still be
 * running or queued when this fires.
 */
export class HoundTimeoutError extends Error {
  override readonly name = 'HoundTimeoutError';
}

/** True when the error is a wait timeout (name-checked like isConfigError). */
export function isTimeoutError(error: unknown): boolean {
  return error instanceof HoundTimeoutError ||
    (error instanceof Error && error.name === 'HoundTimeoutError');
}
