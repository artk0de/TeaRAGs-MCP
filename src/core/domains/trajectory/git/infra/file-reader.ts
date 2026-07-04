/**
 * File-level metadata building from git history.
 * All history access rides the injected `VcsGitAdapter` — no direct git CLI
 * calls remain here (the CLI specifics live in adapters/vcs/git/git-cli).
 */

import type { VcsGitAdapter } from "../../../../adapters/vcs/git/adapter.js";
import type { FileChurnData } from "../../../../adapters/vcs/types.js";
import type { GitEnrichmentCache } from "./cache.js";

/**
 * Build per-file FileChurnData from git history.
 * Uses the adapter's repo-wide numstat log (single history walk).
 *
 * @param maxAgeMonths - limit commits to last N months (default 12).
 *   Set to 0 to disable (read all commits).
 * @param timeoutMs - timeout for git log command (default 60000).
 */
export async function buildFileSignalMap(
  adapter: VcsGitAdapter,
  enrichmentCache: GitEnrichmentCache,
  maxAgeMonths = 12,
  timeoutMs = 60000,
): Promise<Map<string, FileChurnData>> {
  // Cache key includes maxAge to avoid returning stale results for different time windows
  const cacheKey = `${adapter.repoRoot}:${maxAgeMonths}`;

  // Check HEAD-based cache (non-fatal if HEAD resolution fails)
  const cached = await enrichmentCache.getFileMetadata(cacheKey, adapter);
  if (cached) return cached;

  const sinceDate = maxAgeMonths > 0 ? new Date(Date.now() - maxAgeMonths * 30 * 86400 * 1000) : undefined;

  const result = await adapter.readNumstatLog(sinceDate, timeoutMs);

  // Store in cache (non-fatal if HEAD unresolvable)
  await enrichmentCache.setFileMetadata(cacheKey, adapter, result);
  return result;
}

/**
 * Build the run-scoped, repo-wide file churn discovery (bd tea-rags-mcp-j4lm9).
 *
 * ONE `git log HEAD --numstat` over the WHOLE repo, parsed once into a per-file
 * FileChurnData map that a streaming run slices per batch (see
 * `sliceFileSignalsByPaths`) instead of re-running a full-history pathspec log
 * per file batch. It is deliberately UNBOUNDED (no `--since`): it must reproduce
 * `buildFileSignalsForPaths` exactly — that per-batch call carries no `--since`
 * filter — so a sliced entry deep-equals the legacy per-batch result. The only
 * flag difference from `buildFileSignalsForPaths` is the absent pathspec, which
 * is what `sliceFileSignalsByPaths` restores in memory. Reuses the same
 * numstat-log primitive as `buildFileSignalMap`, so there is a single
 * git-command definition (adapter-side).
 *
 * @param timeoutMs - timeout for the git log command (default 60000).
 */
export async function buildFileSignalDiscovery(
  adapter: VcsGitAdapter,
  timeoutMs = 60000,
): Promise<Map<string, FileChurnData>> {
  // No sinceDate ⇒ full history, identical to buildFileSignalsForPaths semantics.
  return adapter.readNumstatLog(undefined, timeoutMs);
}

/**
 * Slice a run-scoped discovery (see `buildFileSignalDiscovery`) down to a batch's
 * paths, in memory — the equivalent of the pathspec on a per-batch
 * `buildFileSignalsForPaths` call, without spawning git. Paths absent from the
 * discovery (never committed under HEAD) are omitted, matching a pathspec log
 * that returns no rows for them. Entries are shared by reference: the returned
 * FileChurnData objects are the discovery's own (never mutated downstream).
 */
export function sliceFileSignalsByPaths(
  discovery: Map<string, FileChurnData>,
  paths: string[],
): Map<string, FileChurnData> {
  const result = new Map<string, FileChurnData>();
  for (const path of paths) {
    const entry = discovery.get(path);
    if (entry) result.set(path, entry);
  }
  return result;
}

/**
 * Fetch file-level metadata for specific files (no --since filter).
 * Used as a backfill for files that weren't in the main git log window.
 * Batching to stay within OS ARG_MAX limits happens adapter-side
 * (`readNumstatLogForPaths`).
 */
export async function buildFileSignalsForPaths(
  adapter: VcsGitAdapter,
  paths: string[],
  timeoutMs = 30000,
): Promise<Map<string, FileChurnData>> {
  if (paths.length === 0) return new Map();
  return adapter.readNumstatLogForPaths(paths, timeoutMs);
}
