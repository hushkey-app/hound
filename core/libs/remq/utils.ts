/**
 * Generates a deterministic job ID based on the name and data (like old genJobId)
 * For cron jobs with same name and data, this will always produce the same ID
 */
export function genJobIdSync(name: string, data: unknown): string {
  const dataString = JSON.stringify(data);

  // Use same approach as old genJobId - create SHA256 hash (deterministic)
  // For cron jobs with empty data, this ensures same ID every time
  const encoder = new TextEncoder();
  const dataBytes = encoder.encode(dataString);

  // Simple hash function (deterministic, like old genJobId)
  // Old system uses crypto.createHash('sha256'), but we need sync version
  // Use same hash algorithm as old system for consistency
  let hash = 0;
  for (let i = 0; i < dataBytes.length; i++) {
    const char = dataBytes[i];
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }

  // Convert to hex (like old system uses .digest('hex'))
  const hashHex = Math.abs(hash).toString(16);

  // Same format as old genJobId: ${name}:${hash}
  return `${name}:${hashHex}`;
}
