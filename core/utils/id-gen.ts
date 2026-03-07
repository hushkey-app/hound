/**
 * Job ID and execution ID utilities (genJobIdSync, genExecId).
 *
 * @module
 */
// ─── FNV-1a constants ─────────────────────────────────────────────────────────

const FNV_OFFSET = 2166136261n;
const FNV_PRIME = 16777619n;
const FNV_MASK = 0xffffffffn; // keep result 32-bit

// ─── Key sorting ──────────────────────────────────────────────────────────────

/**
 * Deep-sort object keys ascending alphabetically before serialization.
 * Ensures identical payloads produce identical jobIds regardless of
 * key insertion order — critical for dedup stability across code paths.
 *
 * Handles: objects, arrays, primitives, null.
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeys((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

// ─── FNV-1a hash ─────────────────────────────────────────────────────────────

/**
 * FNV-1a 32-bit hash over a UTF-8 string.
 * Fast, low collision rate, good distribution for short strings.
 * Not cryptographic — used purely for dedup keying.
 */
function fnv1a(str: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = (hash * FNV_PRIME) & FNV_MASK;
  }
  return hash.toString(16).padStart(8, '0');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate a stable, synchronous job ID from event name + payload. Deterministic; key-order stable via deep-sort.
 *
 * @param event - Event/job name (e.g. 'property.sync')
 * @param payload - Job data; keys are deep-sorted before hashing for stability
 * @returns Job ID string in the form event-xxxxxxxx (8 hex chars)
 */
export function genJobIdSync(event: string, payload: unknown): string {
  const sorted = sortKeys(payload);
  const serialized = `${event}:${JSON.stringify(sorted)}`;
  return `${event}-${fnv1a(serialized)}`;
}

/**
 * Generate a short unique execution ID for terminal state keys (e.g. queues:default:jobId:completed:30a4e43c).
 * 8 hex chars; not cryptographic — audit trail only.
 *
 * @returns 8-character hex string (e.g. '30a4e43c')
 */
export function genExecId(): string {
  const arr = new Uint8Array(4);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
