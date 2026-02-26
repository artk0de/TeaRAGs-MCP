/**
 * File-level metadata building from git history.
 * CLI `git log` only — no isomorphic-git fallback (avoids OOM on large repos).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { buildViaCli, withTimeout } from "../../../adapters/git/client.js";
import { parseNumstatOutput } from "../../../adapters/git/parsers.js";
import type { FileChurnData } from "../../../adapters/git/types.js";
import type { GitEnrichmentCache } from "./cache.js";

const execFileAsync = promisify(execFile);

/**
 * Build per-file FileChurnData from git history.
 * Uses CLI `git log HEAD --numstat` (single process spawn).
 *
 * @param maxAgeMonths - limit commits to last N months (default: GIT_LOG_MAX_AGE_MONTHS env, default 12).
 *   Set to 0 to disable (read all commits).
 */
export async function buildFileSignalMap(
  repoRoot: string,
  enrichmentCache: GitEnrichmentCache,
  maxAgeMonths?: number,
): Promise<Map<string, FileChurnData>> {
  const effectiveMaxAge = maxAgeMonths ?? parseFloat(process.env.GIT_LOG_MAX_AGE_MONTHS ?? "12");

  // Cache key includes maxAge to avoid returning stale results for different time windows
  const cacheKey = `${repoRoot}:${effectiveMaxAge}`;

  // Check HEAD-based cache (non-fatal if HEAD resolution fails)
  const cached = await enrichmentCache.getFileMetadata(cacheKey, repoRoot);
  if (cached) return cached;

  const sinceDate = effectiveMaxAge > 0 ? new Date(Date.now() - effectiveMaxAge * 30 * 86400 * 1000) : undefined;

  const timeoutMs = parseInt(process.env.GIT_LOG_TIMEOUT_MS ?? "60000", 10);

  const result = await withTimeout(buildViaCli(repoRoot, sinceDate), timeoutMs, "CLI git log timed out");

  // Store in cache (non-fatal if HEAD unresolvable)
  await enrichmentCache.setFileMetadata(cacheKey, repoRoot, result);
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
    const args = ["log", "HEAD", "--numstat", "--format=%x00%H%x00%an%x00%ae%x00%at%x00%B%x00", "--", ...batch];

    try {
      const batchResult = await withTimeout(
        execFileAsync("git", args, { cwd: repoRoot, maxBuffer: Infinity }).then(({ stdout }) =>
          parseNumstatOutput(stdout),
        ),
        timeoutMs,
        "git log backfill timed out",
      );
      for (const [path, data] of batchResult) {
        result.set(path, data);
      }
    } catch (error) {
      if (process.env.DEBUG) {
        console.error(`[GitLogReader] Backfill batch failed:`, error instanceof Error ? error.message : error);
      }
    }
  }

  return result;
}
