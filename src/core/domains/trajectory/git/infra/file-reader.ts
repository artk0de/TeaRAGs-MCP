/**
 * File-level metadata building from git history.
 * CLI `git log` only — no isomorphic-git fallback (avoids OOM on large repos).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { buildViaCli } from "../../../../adapters/vcs/git/git-cli/client.js";
import { parseNumstatOutput } from "../../../../adapters/vcs/git/git-cli/parsers.js";
import type { FileChurnData } from "../../../../adapters/vcs/types.js";
import { isDebug } from "../../../../infra/runtime.js";
import type { GitEnrichmentCache } from "./cache.js";

const execFileAsync = promisify(execFile);

/**
 * Build per-file FileChurnData from git history.
 * Uses CLI `git log HEAD --numstat` (single process spawn).
 *
 * @param maxAgeMonths - limit commits to last N months (default 12).
 *   Set to 0 to disable (read all commits).
 * @param timeoutMs - timeout for git log command (default 60000).
 */
export async function buildFileSignalMap(
  repoRoot: string,
  enrichmentCache: GitEnrichmentCache,
  maxAgeMonths = 12,
  timeoutMs = 60000,
): Promise<Map<string, FileChurnData>> {
  // Cache key includes maxAge to avoid returning stale results for different time windows
  const cacheKey = `${repoRoot}:${maxAgeMonths}`;

  // Check HEAD-based cache (non-fatal if HEAD resolution fails)
  const cached = await enrichmentCache.getFileMetadata(cacheKey, repoRoot);
  if (cached) return cached;

  const sinceDate = maxAgeMonths > 0 ? new Date(Date.now() - maxAgeMonths * 30 * 86400 * 1000) : undefined;

  const result = await buildViaCli(repoRoot, sinceDate, timeoutMs);

  // Store in cache (non-fatal if HEAD unresolvable)
  await enrichmentCache.setFileMetadata(cacheKey, repoRoot, result);
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
 * `buildViaCli` primitive (and `parseNumstatOutput`) as `buildFileSignalMap`, so
 * there is a single git-command definition.
 *
 * @param timeoutMs - timeout for the git log command (default 60000).
 */
export async function buildFileSignalDiscovery(
  repoRoot: string,
  timeoutMs = 60000,
): Promise<Map<string, FileChurnData>> {
  // No sinceDate ⇒ full history, identical to buildFileSignalsForPaths semantics.
  return buildViaCli(repoRoot, undefined, timeoutMs);
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
 * Batches file paths to stay within OS ARG_MAX limits.
 */
export async function buildFileSignalsForPaths(
  repoRoot: string,
  paths: string[],
  timeoutMs = 30000,
): Promise<Map<string, FileChurnData>> {
  if (paths.length === 0) return new Map();

  const result = new Map<string, FileChurnData>();
  const BATCH = 500; // stay within ARG_MAX

  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = paths.slice(i, i + BATCH);
    const args = ["log", "HEAD", "--numstat", "--format=%x00%H%x00%P%x00%an%x00%ae%x00%at%x00%B%x00", "--", ...batch];

    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd: repoRoot,
        maxBuffer: Infinity,
        timeout: timeoutMs,
      });
      const batchResult = parseNumstatOutput(stdout);
      for (const [path, data] of batchResult) {
        result.set(path, data);
      }
    } catch (error) {
      if (isDebug()) {
        console.error(`[GitLogReader] Backfill batch failed:`, error instanceof Error ? error.message : error);
      }
    }
  }

  return result;
}
