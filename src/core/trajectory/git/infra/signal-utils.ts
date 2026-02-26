/**
 * Git-specific payload accessor helpers.
 *
 * These functions extract signal values from the search result payload,
 * supporting both nested (git.file.*, git.chunk.*) and flat (git.*)
 * formats for backward compatibility.
 *
 * Terminology: Signal = raw payload value stored in Qdrant.
 */

// ---------------------------------------------------------------------------
// Internal payload resolvers
// ---------------------------------------------------------------------------

/**
 * Resolve file-level git metadata from payload.
 * Supports nested { git: { file: {...} } } and flat { git: { ageDays, ... } }.
 */
function resolveFile(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const git = payload.git as Record<string, unknown> | undefined;
  if (!git) return undefined;
  const file = git.file as Record<string, unknown> | undefined;
  return file ?? git;
}

/**
 * Resolve chunk-level git metadata from payload.
 * Supports nested { git: { chunk: {...} } } format.
 */
function resolveChunk(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const git = payload.git as Record<string, unknown> | undefined;
  if (!git) return undefined;
  return git.chunk as Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// Public accessors
// ---------------------------------------------------------------------------

/**
 * Read a signal from file-level git metadata, returning undefined if absent.
 */
export function fileSignal(payload: Record<string, unknown>, field: string): unknown {
  return resolveFile(payload)?.[field];
}

/**
 * Read a numeric signal from file-level git metadata, returning 0 if absent.
 */
export function fileNum(payload: Record<string, unknown>, field: string): number {
  const v = fileSignal(payload, field);
  return typeof v === "number" ? v : 0;
}

/**
 * Read a numeric signal from chunk-level git metadata, returning 0 if absent.
 */
export function chunkNum(payload: Record<string, unknown>, field: string): number {
  const chunk = resolveChunk(payload);
  if (!chunk) return 0;
  const v = chunk[field];
  return typeof v === "number" ? v : 0;
}

/**
 * Check if chunk-level data exists in the payload.
 */
export function hasChunkData(payload: Record<string, unknown>): boolean {
  const chunk = resolveChunk(payload);
  return chunk !== undefined && chunk !== null;
}

/**
 * Check if a specific chunk signal is defined.
 */
export function hasChunkSignal(payload: Record<string, unknown>, field: string): boolean {
  const chunk = resolveChunk(payload);
  return chunk?.[field] !== undefined;
}

/**
 * Check if a specific file signal is defined.
 */
export function hasFileSignal(payload: Record<string, unknown>, field: string): boolean {
  const file = resolveFile(payload);
  return file?.[field] !== undefined;
}

/**
 * Compute confidence alpha from effective commit count.
 * Confidence = min(1, commitCount / MIN_CONFIDENT_COMMITS).
 * Used to dampen statistical signals that are unreliable with small samples.
 */
export function computeAlpha(payload: Record<string, unknown>): number {
  const MIN_CONFIDENT_COMMITS = 5;
  const chunkCC = chunkNum(payload, "commitCount");
  const fileCC = fileNum(payload, "commitCount");
  const effective = chunkCC > 0 ? chunkCC : fileCC;
  return Math.min(1, effective / MIN_CONFIDENT_COMMITS);
}
