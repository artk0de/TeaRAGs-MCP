/**
 * Low-level git operations — CLI primary, isomorphic-git for individual object reads.
 * No enrichment concepts, no caching logic.
 *
 * Heavy operations (log walking, tree diffing) use CLI exclusively to avoid OOM
 * on large repos. isomorphic-git is used only for individual object reads
 * (readBlob, readCommit, resolveRef) where pack cache growth is bounded.
 */

import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { promisify } from "node:util";

import git from "isomorphic-git";

import { parseNumstatOutput, parsePathspecOutput } from "./parsers.js";
import type { CommitInfo, FileChurnData } from "./types.js";

const execFileAsync = promisify(execFile);

// ── Generic utility ──────────────────────────────────────────────

/** Race a promise against a timeout. Rejects with Error(message) on expiry. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

// ── CLI primitives ───────────────────────────────────────────────

/** Run `git log` with pathspec filtering, return raw stdout. */
export async function execFileForPathspec(repoRoot: string, args: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoRoot,
    maxBuffer: Infinity,
    timeout: timeoutMs,
  });
  return stdout;
}

/** Build CLI args for `git log --numstat`. Uses HEAD (not --all), no --max-count. */
export function buildCliArgs(sinceDate?: Date): string[] {
  const args = ["log", "HEAD", "--numstat", "--format=%x00%H%x00%an%x00%ae%x00%at%x00%B%x00"];
  if (sinceDate) {
    args.push(`--since=${sinceDate.toISOString()}`);
  }
  return args;
}

/** Resolve HEAD SHA — isomorphic-git first, CLI fallback. */
export async function getHead(repoRoot: string): Promise<string> {
  try {
    return await git.resolveRef({ fs, dir: repoRoot, ref: "HEAD" });
  } catch {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
    return stdout.trim();
  }
}

/** Resolve git repo root from a path. Returns absolutePath if not a git repo. */
export function resolveRepoRoot(absolutePath: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: absolutePath,
      encoding: "utf-8",
    }).trim();
  } catch {
    return absolutePath;
  }
}

/** Run CLI `git log --numstat` and parse output into FileChurnData map. */
export async function buildViaCli(repoRoot: string, sinceDate?: Date): Promise<Map<string, FileChurnData>> {
  const args = buildCliArgs(sinceDate);
  const { stdout } = await execFileAsync("git", args, { cwd: repoRoot, maxBuffer: Infinity });
  return parseNumstatOutput(stdout);
}

// ── isomorphic-git object reads ──────────────────────────────────
// Only used for individual object reads (readBlob, readCommit, resolveRef).
// Heavy operations (log walking, tree diffing) use CLI to avoid OOM.

/** Read a blob at a specific commit as a UTF-8 string. Returns "" if missing. */
export async function readBlobAsString(
  repoRoot: string,
  commitOid: string,
  filepath: string,
  cache: Record<string, unknown>,
): Promise<string> {
  try {
    const { blob } = await git.readBlob({
      fs,
      dir: repoRoot,
      oid: commitOid,
      filepath,
      cache,
    });
    return new TextDecoder().decode(blob);
  } catch {
    return "";
  }
}

// ── Pathspec CLI operations ──────────────────────────────────────

const PATHSPEC_BATCH_SIZE = 500;

/** Run a single pathspec-filtered git log and parse the output. */
export async function getCommitsByPathspecSingle(
  repoRoot: string,
  sinceDate: Date,
  filePaths: string[],
  timeoutMs?: number,
): Promise<{ commit: CommitInfo; changedFiles: string[] }[]> {
  const effectiveTimeoutMs = timeoutMs ?? 30000;
  const args = [
    "log",
    `--since=${sinceDate.toISOString()}`,
    "--format=%x00%H%x00%an%x00%ae%x00%at%x00%B%x00",
    "--numstat",
    "--",
    ...filePaths,
  ];

  const stdout = await execFileForPathspec(repoRoot, args, effectiveTimeoutMs);
  return parsePathspecOutput(stdout);
}

/**
 * Run multiple pathspec CLI calls in batches, merge results by commit SHA.
 * Same commit may appear in multiple batches (touched files in different batches).
 */
export async function getCommitsByPathspecBatched(
  repoRoot: string,
  sinceDate: Date,
  filePaths: string[],
  timeoutMs?: number,
): Promise<{ commit: CommitInfo; changedFiles: string[] }[]> {
  const batchSize = PATHSPEC_BATCH_SIZE;
  const batches: string[][] = [];
  for (let i = 0; i < filePaths.length; i += batchSize) {
    batches.push(filePaths.slice(i, i + batchSize));
  }

  const debug = process.env.DEBUG === "true" || process.env.DEBUG === "1";
  if (debug) {
    console.error(
      `[ChunkChurn] Pathspec batching: ${filePaths.length} files → ${batches.length} batches of ≤${batchSize}`,
    );
  }

  const merged = new Map<string, { commit: CommitInfo; changedFiles: Set<string> }>();

  for (const batch of batches) {
    try {
      const batchResult = await getCommitsByPathspecSingle(repoRoot, sinceDate, batch, timeoutMs);
      for (const entry of batchResult) {
        const existing = merged.get(entry.commit.sha);
        if (existing) {
          for (const f of entry.changedFiles) existing.changedFiles.add(f);
        } else {
          merged.set(entry.commit.sha, {
            commit: entry.commit,
            changedFiles: new Set(entry.changedFiles),
          });
        }
      }
    } catch (error) {
      if (debug) {
        console.error(
          `[ChunkChurn] Pathspec batch failed (${batch.length} files):`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  return Array.from(merged.values()).map(({ commit, changedFiles }) => ({
    commit,
    changedFiles: Array.from(changedFiles),
  }));
}

/**
 * Get commits touching specific files via CLI pathspec filtering.
 * Dispatches to single or batched depending on count.
 */
export async function getCommitsByPathspec(
  repoRoot: string,
  sinceDate: Date,
  filePaths: string[],
  timeoutMs?: number,
): Promise<{ commit: CommitInfo; changedFiles: string[] }[]> {
  if (filePaths.length === 0) return [];

  if (filePaths.length > PATHSPEC_BATCH_SIZE) {
    return getCommitsByPathspecBatched(repoRoot, sinceDate, filePaths, timeoutMs);
  }

  return getCommitsByPathspecSingle(repoRoot, sinceDate, filePaths, timeoutMs);
}
