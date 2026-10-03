/**
 * Low-level git operations — CLI only. No enrichment concepts, no caching.
 *
 * Everything (log walking, object reads, ref resolution) goes through the git
 * CLI. isomorphic-git was removed: its pack reader loaded the ENTIRE packfile
 * into a JS ArrayBuffer (heap profiler caught 3×1.4 GB on a large repo → 16 GB
 * OOM). `git cat-file` / `git rev-parse` stream individual objects from disk,
 * so resident memory never includes the whole pack.
 */

import { execFile, execFileSync, spawn, type ExecFileOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveGitExecutable } from "../../../../infra/git-executable.js";
import { isDebug } from "../../../../infra/runtime.js";
import type {
  BlameLine,
  CommitChangedPath,
  CommitFileNumstat,
  CommitInfo,
  CommitWithChangedFiles,
  FileChurnData,
} from "../../types.js";
import { trackGitChildProcess } from "./git-child-process-registry.js";
import { parseBlameOutput, parseCommitFileNumstat, parseNumstatOutput, parsePathspecOutput } from "./parsers.js";
import { execWithStallGuard } from "./stall-guard-exec.js";

/** `execFile` as a promise, with the child registered for shutdown reaping (bd tea-rags-mcp-w26dc). */
async function execFileAsync(
  file: string,
  args: string[],
  options: ExecFileOptions & { encoding?: BufferEncoding },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { ...options, encoding: options.encoding ?? "utf8" },
      (err: Error | null, stdout: string, stderr: string) => {
        if (err) {
          reject(err);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    trackGitChildProcess(child);
  });
}

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

/**
 * A bulk `git log` can be legitimately SILENT for minutes while staying
 * alive: computing --numstat for one giant commit (vendored tree import,
 * repo-wide migration) emits nothing until that diff finishes — taxdome got
 * a real 60s+ gap mid-stream. The stall window exists to reap HUNGS, so it
 * is floored well above any legitimate thinking pause; caller-provided
 * windows can only RAISE it.
 */
const BULK_LOG_STALL_FLOOR_MS = 600_000;

/**
 * Run `git log` with pathspec filtering, return raw stdout. The timeout is an
 * output-INACTIVITY window (stall guard), not a total-duration cap — a
 * long-but-streaming log completes; a hung spawn is reaped.
 */
export async function execFileForPathspec(repoRoot: string, args: string[], timeoutMs: number): Promise<string> {
  return execWithStallGuard(resolveGitExecutable(), args, {
    cwd: repoRoot,
    stallTimeoutMs: Math.max(timeoutMs, BULK_LOG_STALL_FLOOR_MS),
  });
}

/** Build CLI args for `git log --numstat`. Uses HEAD (not --all), no --max-count. */
export function buildCliArgs(sinceDate?: Date): string[] {
  const args = ["log", "HEAD", "--numstat", "--format=%x00%H%x00%P%x00%an%x00%ae%x00%at%x00%B%x00"];
  if (sinceDate) {
    args.push(`--since=${sinceDate.toISOString()}`);
  }
  return args;
}

/** Resolve HEAD SHA via CLI `git rev-parse HEAD`. */
export async function getHead(repoRoot: string): Promise<string> {
  const { stdout } = await execFileAsync(resolveGitExecutable(), ["rev-parse", "HEAD"], { cwd: repoRoot });
  return stdout.trim();
}

/** Resolve git repo root from a path. Returns absolutePath if not a git repo. */
export function resolveRepoRoot(absolutePath: string): string {
  try {
    return execFileSync(resolveGitExecutable(), ["rev-parse", "--show-toplevel"], {
      cwd: absolutePath,
      encoding: "utf-8",
    }).trim();
  } catch {
    return absolutePath;
  }
}

/**
 * Run CLI `git log --numstat` and parse output into FileChurnData map.
 *
 * `timeoutMs` is an output-INACTIVITY window (stall guard), not a total cap:
 * the UNBOUNDED (no --since) full-history sweep on a large monolith streams
 * for minutes (taxdome: 104MB / 122.9s) and used to get SIGTERM'd at the 60s
 * execFile budget — failing the whole git enrichment while the spawn was
 * perfectly alive (tea-rags-mcp-w2dlu).
 */
export async function buildViaCli(
  repoRoot: string,
  sinceDate?: Date,
  timeoutMs?: number,
): Promise<Map<string, FileChurnData>> {
  const args = buildCliArgs(sinceDate);
  const stdout = await execWithStallGuard(resolveGitExecutable(), args, {
    cwd: repoRoot,
    stallTimeoutMs: Math.max(timeoutMs ?? 60_000, BULK_LOG_STALL_FLOOR_MS),
  });
  return parseNumstatOutput(stdout);
}

/**
 * Fetch file-level metadata for specific files (no --since filter).
 * Used as a backfill for files that weren't in the main git log window.
 * Batches file paths to stay within OS ARG_MAX limits.
 */
export async function buildViaCliForPaths(
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
      const { stdout } = await execFileAsync(resolveGitExecutable(), args, {
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

// ── Object reads (CLI cat-file — never loads the packfile into memory) ──
// isomorphic-git's readBlob loaded the ENTIRE packfile into a JS ArrayBuffer
// per cache object (heap profiler caught 3×1.4 GB `system / JSArrayBufferData`
// on a large repo, growing to 16 GB → OOM). `git cat-file` seeks a single
// object in the pack via its .idx and streams just that object from disk, so
// resident memory is one blob, not the whole pack.

/**
 * Read a blob at a specific commit as a UTF-8 string. Returns "" when the path
 * is missing at that commit (cat-file exits non-zero). `maxBuffer` is raised
 * above the 1 MB default so normal source blobs are not truncated; pathological
 * giant files are filtered out upstream by the chunk-churn line cap.
 */
export async function readBlobAsString(repoRoot: string, commitOid: string, filepath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(resolveGitExecutable(), ["cat-file", "blob", `${commitOid}:${filepath}`], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return "";
  }
}

/**
 * Persistent reader over a single `git cat-file --batch` process. Each `read`
 * streams ONE object through the long-lived process instead of spawning a
 * `git cat-file blob` per call. The chunk-churn walk issues tens of thousands
 * of blob reads; per-call spawn (fork + re-open the pack `.idx` every time)
 * dominated wall time. One persistent process keeps the pack open and still
 * holds only one object at a time — bounded memory, unlike isomorphic-git which
 * loaded the whole pack into an ArrayBuffer. See
 * `.claude/rules/git-cat-file-batch.md`.
 */
export interface CatFileBatchReader {
  /** Read `<commitOid>:<filepath>` as a UTF-8 string; "" when absent. */
  read: (commitOid: string, filepath: string) => Promise<string>;
  /** End the underlying git process and reject any later reads. */
  close: () => Promise<void>;
}

/**
 * Protocol (FIFO — one response per request, in order):
 *   stdin:  `<commitOid>:<filepath>\n`
 *   stdout: `<oid> <type> <size>\n<size bytes>\n`   (object exists)
 *           `<rev> missing\n`                        (object absent → "")
 * Content is framed by byte length (blobs contain newlines / arbitrary bytes)
 * and decoded as UTF-8 to match `readBlobAsString`.
 */
export function createCatFileBatch(repoRoot: string): CatFileBatchReader {
  interface Pending {
    resolve: (value: string) => void;
    reject: (err: Error) => void;
  }
  const queue: Pending[] = [];
  let buf: Buffer = Buffer.alloc(0);
  // null → awaiting a header line; number → that many content bytes still owed.
  let expectContent: number | null = null;
  let closed = false;
  let fatal: Error | null = null;
  let child: ReturnType<typeof spawn> | null = null;

  const failAll = (err: Error): void => {
    fatal ??= err;
    while (queue.length > 0) queue.shift()?.reject(err);
  };

  const onData = (chunk: Buffer): void => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    for (;;) {
      if (expectContent === null) {
        const nl = buf.indexOf(0x0a); // '\n'
        if (nl === -1) return; // header line not complete yet
        const header = buf.toString("utf8", 0, nl);
        buf = buf.subarray(nl + 1);
        const tail = header.slice(header.lastIndexOf(" ") + 1);
        if (tail === "missing") {
          queue.shift()?.resolve("");
          continue;
        }
        const size = Number.parseInt(tail, 10);
        if (!Number.isFinite(size) || size < 0) {
          failAll(new Error(`cat-file --batch: unparseable header "${header}"`));
          return;
        }
        expectContent = size;
      }
      // Need `size` content bytes plus the trailing newline git appends.
      if (buf.length < expectContent + 1) return;
      const content = buf.subarray(0, expectContent).toString("utf8");
      buf = buf.subarray(expectContent + 1);
      expectContent = null;
      queue.shift()?.resolve(content);
    }
  };

  // Spawn lazily on the first read — a walk that reads no blobs (every file
  // skipped, empty chunk map, pathspec returned nothing) never forks git.
  const ensureChild = (): NonNullable<typeof child> => {
    if (child) return child;
    const c = spawn(resolveGitExecutable(), ["cat-file", "--batch"], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "ignore"],
    });
    trackGitChildProcess(c);
    c.stdout?.on("data", onData);
    c.stdin?.on("error", (err) => {
      // Writing to a git process that has already exited (a non-repo dir exits
      // immediately; a process can also die mid-walk) surfaces EPIPE/ECONNRESET
      // asynchronously on the stdin pipe. The child 'close'/'error' handlers
      // already fail the pending reads with the authoritative reason, so swallow
      // the broken-pipe symptom — otherwise it escapes as an uncaught exception
      // and fails the whole run (seen on Node 22 in CI). Non-benign stdin errors
      // still fail loudly.
      const { code } = err as NodeJS.ErrnoException;
      if (code === "EPIPE" || code === "ECONNRESET") return;
      failAll(err instanceof Error ? err : new Error(String(err)));
    });
    c.on("error", (err) => {
      failAll(err instanceof Error ? err : new Error(String(err)));
    });
    c.on("close", () => {
      if (!closed) failAll(new Error("git cat-file --batch exited unexpectedly"));
    });
    child = c;
    return c;
  };

  return {
    read: async (commitOid: string, filepath: string): Promise<string> => {
      if (closed) throw new Error("CatFileBatchReader is closed");
      if (fatal) throw fatal;
      const c = ensureChild();
      return new Promise<string>((resolve, reject) => {
        queue.push({ resolve, reject });
        c.stdin?.write(`${commitOid}:${filepath}\n`);
      });
    },
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      const c = child;
      if (!c) return; // never spawned — nothing to tear down
      // Already dead (crashed mid-walk, or reaped at shutdown): its "close" has
      // fired or is about to, and awaiting it again would never resolve.
      if (c.exitCode !== null || c.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          c.kill();
        }, 2000);
        c.once("close", done);
        c.stdin?.end();
      });
    },
  };
}

/**
 * Persistent OID resolver over a single `git cat-file --batch-check` process
 * (bd tea-rags-mcp-v2mlw). Resolves `<rev>` strings (e.g. `HEAD:src/a.ts`) to
 * object OIDs — metadata only, no blob content transfer, so stdout stays
 * line-based. ONE long-lived process resolves thousands of paths; unlike a
 * per-path `git rev-parse` spawn it is immune to machine-wide EDR caps on
 * FRESH process spawns (measured ~10 proc/s with zero parallel scaling, while
 * persistent cat-file processes run ~2500 ops/s).
 */
export interface CatFileBatchCheckReader {
  /** Resolve `<rev>` (e.g. `HEAD:src/a.ts`) to its object OID; null when the rev is missing. */
  check: (rev: string) => Promise<string | null>;
  /** End the underlying git process and reject any later checks. */
  close: () => Promise<void>;
}

/**
 * Protocol (FIFO — one response LINE per request, in order):
 *   stdin:  `<rev>\n`
 *   stdout: `<oid> <type> <size>\n`   (object exists → resolve the oid)
 *           `<rev> missing\n`         (object absent → resolve null)
 * Mirrors createCatFileBatch (lazy spawn, failAll on spawn error / unexpected
 * close, closed/fatal guards, bounded close) minus content framing — there
 * are no content bytes with --batch-check.
 */
export function createCatFileBatchCheck(repoRoot: string): CatFileBatchCheckReader {
  interface PendingCheck {
    resolve: (value: string | null) => void;
    reject: (err: Error) => void;
  }
  const queue: PendingCheck[] = [];
  let buf: Buffer = Buffer.alloc(0);
  let closed = false;
  let fatal: Error | null = null;
  let child: ReturnType<typeof spawn> | null = null;

  const failAll = (err: Error): void => {
    fatal ??= err;
    while (queue.length > 0) queue.shift()?.reject(err);
  };

  const onData = (chunk: Buffer): void => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    for (;;) {
      const nl = buf.indexOf(0x0a); // '\n'
      if (nl === -1) return; // response line not complete yet
      const line = buf.toString("utf8", 0, nl);
      buf = buf.subarray(nl + 1);
      if (line.endsWith(" missing")) {
        queue.shift()?.resolve(null);
        continue;
      }
      const spaceIdx = line.indexOf(" ");
      queue.shift()?.resolve(spaceIdx === -1 ? line : line.slice(0, spaceIdx));
    }
  };

  // Spawn lazily on the first check — a run that resolves no OIDs never forks git.
  const ensureChild = (): NonNullable<typeof child> => {
    if (child) return child;
    const c = spawn(resolveGitExecutable(), ["cat-file", "--batch-check"], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "ignore"],
    });
    trackGitChildProcess(c);
    c.stdout?.on("data", onData);
    c.stdin?.on("error", (err) => {
      // Writing to a git process that has already exited (a non-repo dir exits
      // immediately; a process can also die mid-walk) surfaces EPIPE/ECONNRESET
      // asynchronously on the stdin pipe. The child 'close'/'error' handlers
      // already fail the pending reads with the authoritative reason, so swallow
      // the broken-pipe symptom — otherwise it escapes as an uncaught exception
      // and fails the whole run (seen on Node 22 in CI). Non-benign stdin errors
      // still fail loudly.
      const { code } = err as NodeJS.ErrnoException;
      if (code === "EPIPE" || code === "ECONNRESET") return;
      failAll(err instanceof Error ? err : new Error(String(err)));
    });
    c.on("error", (err) => {
      failAll(err instanceof Error ? err : new Error(String(err)));
    });
    c.on("close", () => {
      if (!closed) failAll(new Error("git cat-file --batch-check exited unexpectedly"));
    });
    child = c;
    return c;
  };

  return {
    check: async (rev: string): Promise<string | null> => {
      if (closed) throw new Error("CatFileBatchCheckReader is closed");
      if (fatal) throw fatal;
      const c = ensureChild();
      return new Promise<string | null>((resolve, reject) => {
        queue.push({ resolve, reject });
        c.stdin?.write(`${rev}\n`);
      });
    },
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      const c = child;
      if (!c) return; // never spawned — nothing to tear down
      // Already dead (crashed mid-walk, or reaped at shutdown): its "close" has
      // fired or is about to, and awaiting it again would never resolve.
      if (c.exitCode !== null || c.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          c.kill();
        }, 2000);
        c.once("close", done);
        c.stdin?.end();
      });
    },
  };
}

// ── Pathspec CLI operations ──────────────────────────────────────

const PATHSPEC_BATCH_SIZE = 500;

/** NUL-delimited log format shared by the numstat log variants below. */
const NUMSTAT_LOG_FORMAT = "--format=%x00%H%x00%P%x00%an%x00%ae%x00%at%x00%B%x00";

/**
 * NUL-delimited log format for `readCommitFileNumstat` ONLY — inserts the
 * COMMITTER epoch (`%ct`) between the author epoch (`%at`) and the body (`%B`).
 * The file-churn discovery windows/evicts/sorts by committer date to match
 * `git log --since` (which filters on committer date), while `commit.timestamp`
 * (`%at`, author date) still feeds signal VALUES. The shared
 * `NUMSTAT_LOG_FORMAT` above is deliberately left untouched so the chunk path
 * (parseNumstatOutput / parsePathspecOutput) stays byte-identical.
 */
const NUMSTAT_LOG_FORMAT_WITH_COMMITTER = "--format=%x00%H%x00%P%x00%an%x00%ae%x00%at%x00%ct%x00%B%x00";

/**
 * Repo-wide `git log --since --numstat` — NO pathspec, NO explicit rev
 * (defaults to HEAD, matching getCommitsByPathspecSingle). ONE such call per
 * indexing run replaces the K per-batch pathspec logs: the parsed
 * commit → changedFiles matrix is a superset of every pathspec slice, and the
 * chunk-churn walk already filters changedFiles against its chunk map
 * (bd tea-rags-mcp-82va1).
 */
export async function getCommitsSince(
  repoRoot: string,
  sinceDate: Date,
  timeoutMs?: number,
): Promise<CommitWithChangedFiles[]> {
  const effectiveTimeoutMs = timeoutMs ?? 30000;
  const args = ["log", `--since=${sinceDate.toISOString()}`, NUMSTAT_LOG_FORMAT, "--numstat"];
  const stdout = await execFileForPathspec(repoRoot, args, effectiveTimeoutMs);
  return parsePathspecOutput(stdout);
}

/**
 * `git log --since <fromSha>..<toSha> --numstat` — the incremental top-up for
 * a persisted commit-discovery matrix: only commits reachable from the new
 * HEAD but not from the persisted one (bd tea-rags-mcp-82va1).
 */
export async function getCommitsInRange(
  repoRoot: string,
  fromSha: string,
  toSha: string,
  sinceDate: Date,
  timeoutMs?: number,
): Promise<CommitWithChangedFiles[]> {
  const effectiveTimeoutMs = timeoutMs ?? 30000;
  const args = ["log", `--since=${sinceDate.toISOString()}`, `${fromSha}..${toSha}`, NUMSTAT_LOG_FORMAT, "--numstat"];
  const stdout = await execFileForPathspec(repoRoot, args, effectiveTimeoutMs);
  return parsePathspecOutput(stdout);
}

/**
 * `git log [--since] [fromSha..toSha] --numstat` — the numstat-PRESERVING
 * sibling of `getCommitsSince`/`getCommitsInRange`: same NUL-delimited log
 * format and stall-guarded exec, but keeps each file's +/- counts instead of
 * collapsing them into `changedFiles: string[]`. `range` present narrows to
 * `fromSha..toSha` (incremental top-up, excludes `fromSha`'s own contribution
 * same as `getCommitsInRange`); absent walks the whole `--since` window.
 */
export async function readCommitFileNumstat(
  repoRoot: string,
  sinceDate?: Date,
  range?: { fromSha: string; toSha: string },
  timeoutMs?: number,
): Promise<CommitFileNumstat[]> {
  const effectiveTimeoutMs = timeoutMs ?? 30000;
  const args = ["log"];
  if (sinceDate) args.push(`--since=${sinceDate.toISOString()}`);
  if (range) args.push(`${range.fromSha}..${range.toSha}`);
  args.push(NUMSTAT_LOG_FORMAT_WITH_COMMITTER, "--numstat");
  const stdout = await execFileForPathspec(repoRoot, args, effectiveTimeoutMs);
  return parseCommitFileNumstat(stdout);
}

/**
 * `git log HEAD --numstat -- <paths>` kept per commit, with the rename rows a
 * pathspec hides put back (bd tea-rags-mcp-aikfk).
 *
 * Git detects a rename only between paths the pathspec names, so a commit that
 * moved a named path in from an unnamed one prints a plain add, and one that
 * moved it out prints a plain delete — neither row carries `previousPath`, and
 * a caller following renames (`sliceCommitsFollowingRenames`) never learns the
 * predecessor. `--diff-filter=AD` lists exactly those commits; they are re-read
 * without the pathspec (`--no-walk`, one spawn) and their rows touching a named
 * path on either side replace the pathspec-limited ones. Commits that only
 * modified a named path keep their pathspec rows. Log order is preserved.
 *
 * `since` present bounds both logs with `--since` and walks them with
 * `--full-history`: the pathspec-limited form of a repo-wide `git log --since
 * --numstat` (the run-scoped discovery an index run reads), whose commits a
 * pathspec log would otherwise simplify away wherever a merge is TREESAME to
 * one parent for the path (bd tea-rags-mcp-xi2r9).
 */
export async function readCommitFileNumstatForPaths(
  repoRoot: string,
  paths: string[],
  timeoutMs?: number,
  since?: Date,
): Promise<CommitFileNumstat[]> {
  if (paths.length === 0) return [];
  const effectiveTimeoutMs = timeoutMs ?? 30000;
  const window = since ? [`--since=${since.toISOString()}`, "--full-history"] : [];
  const entries = parseCommitFileNumstat(
    await execFileForPathspec(
      repoRoot,
      ["log", "HEAD", ...window, "--numstat", NUMSTAT_LOG_FORMAT_WITH_COMMITTER, "--", ...paths],
      effectiveTimeoutMs,
    ),
  );
  const addOrDelete = (
    await execFileForPathspec(
      repoRoot,
      ["log", "HEAD", ...window, "--diff-filter=AD", "--format=%H", "--", ...paths],
      effectiveTimeoutMs,
    )
  )
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (addOrDelete.length === 0) return entries;

  const named = new Set(paths);
  const unrestricted = new Map(
    parseCommitFileNumstat(
      await execFileForPathspec(
        repoRoot,
        ["log", "--no-walk=unsorted", NUMSTAT_LOG_FORMAT_WITH_COMMITTER, "--numstat", ...addOrDelete],
        effectiveTimeoutMs,
      ),
    ).map((entry) => [entry.commit.sha, entry]),
  );
  return entries.map((entry) => {
    const full = unrestricted.get(entry.commit.sha);
    if (!full) return entry;
    const files = full.files.filter(
      (row) => named.has(row.path) || (row.previousPath !== undefined && named.has(row.previousPath)),
    );
    return files.length > 0 ? { ...entry, files } : entry;
  });
}

/**
 * True iff `ancestor` is an ancestor of `descendant` per
 * `git merge-base --is-ancestor`. Any failure — non-ancestor exit code,
 * unresolvable / gc'd shas, not a repo — resolves false, which callers treat
 * as "cannot top up, rebuild fully" (bd tea-rags-mcp-82va1).
 */
export async function isAncestor(repoRoot: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await execFileAsync(resolveGitExecutable(), ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: repoRoot,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The best common ancestor of `ref` and HEAD (`git merge-base <ref> HEAD`) —
 * where a branch left `ref`, so a diff against it holds only the branch's
 * side (three-dot semantics). `null` when the two share no history: unrelated
 * roots, or a shallow clone whose cut-off hides the ancestor. An unknown ref or
 * a path outside a repository rejects.
 */
export async function readMergeBase(repoRoot: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(resolveGitExecutable(), ["merge-base", ref, "HEAD"], { cwd: repoRoot });
    return stdout.trim();
  } catch (error) {
    // Exit 1 is git's "no common ancestor"; an unknown ref or a non-repository exits 128.
    if ((error as { code?: unknown }).code === 1) return null;
    throw error;
  }
}

/** Silence window for the two tree listings below — one bounded spawn each, never a history walk. */
const TREE_LISTING_STALL_MS = 60_000;

/**
 * Every path `commitOid`'s tree tracks, repo-relative, as git spells it
 * (`ls-tree -z`: no C-quoting). Submodule entries are listed by their path.
 */
export async function listTreePaths(
  repoRoot: string,
  commitOid: string,
  timeoutMs = TREE_LISTING_STALL_MS,
): Promise<string[]> {
  const out = await execWithStallGuard(
    resolveGitExecutable(),
    ["ls-tree", "-r", "-z", "--name-only", "--full-tree", commitOid],
    { cwd: repoRoot, stallTimeoutMs: timeoutMs },
  );
  return splitNulTerminated(out);
}

/**
 * HEAD paths the working tree no longer has, repo-relative: deleted on disk,
 * removed from the index, or moved away (`--no-renames`, so the old side of an
 * uncommitted rename reads as a deletion). Edited files are not listed.
 */
export async function listWorktreeDeletions(repoRoot: string, timeoutMs = TREE_LISTING_STALL_MS): Promise<string[]> {
  const out = await execWithStallGuard(
    resolveGitExecutable(),
    ["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", "--diff-filter=D", "HEAD", "--"],
    { cwd: repoRoot, stallTimeoutMs: timeoutMs },
  );
  return splitNulTerminated(out);
}

/**
 * Paths among `paths` whose working-tree content differs from HEAD — edited,
 * staged or not — repo-relative (bd tea-rags-mcp-xi2r9). Added, deleted and
 * untracked paths are not listed: only a path HEAD holds has HEAD rows to
 * carry a working row onto. `--no-renames`, so a moved file's new side reads
 * as an add and is left out.
 */
export async function listWorktreeModifications(
  repoRoot: string,
  paths: readonly string[],
  timeoutMs = TREE_LISTING_STALL_MS,
): Promise<string[]> {
  if (paths.length === 0) return [];
  const out = await execFileForPathspec(
    repoRoot,
    ["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", "--diff-filter=M", "HEAD", "--", ...paths],
    timeoutMs,
  );
  return splitNulTerminated(out);
}

/**
 * When content was committed (bd tea-rags-mcp-xi2r9.3): the commit time, in
 * epoch ms, of the newest commit on HEAD's history whose diff of
 * `relativePath` adds or drops the blob `blobId`
 * (`git log -1 --format=%ct --find-object`). `null` when no such commit
 * exists — the content is not committed. A path outside a repository rejects.
 */
export async function readBlobCommitTime(
  root: string,
  relativePath: string,
  blobId: string,
  timeoutMs = TREE_LISTING_STALL_MS,
): Promise<number | null> {
  const out = await execWithStallGuard(
    resolveGitExecutable(),
    ["log", "-1", "--format=%ct", `--find-object=${blobId}`, "HEAD", "--", relativePath],
    { cwd: root, stallTimeoutMs: timeoutMs },
  );
  const seconds = Number(out.trim());
  return out.trim() === "" || !Number.isFinite(seconds) ? null : seconds * 1000;
}

/**
 * The commits on either side of `sinceCommit...headCommit` that touched each
 * path, repo-relative, newest first (`--no-renames`: a committed move lists
 * both its sides under its commit).
 */
export interface PathCommitsSince {
  /** Commits reachable from HEAD and not from the stamp (`since..head`) — what HEAD's history adds. */
  headSide: ReadonlyMap<string, readonly string[]>;
  /**
   * Commits reachable from the stamp and not from HEAD — what HEAD's history
   * lacks. Empty when HEAD descends from the stamp.
   */
  stampSide: ReadonlyMap<string, readonly string[]>;
}

const COMMIT_HEADER_MARK = "\u0001";

/**
 * Which commits on either side of the stamp touched which paths — one spawn for
 * the whole symmetric range (`git log --left-right since...head`). The
 * working-tree overlay's answer to "whose history moved since the index" (live
 * G1) and to "which commits does a path's history at HEAD hold that the stamp's
 * does not" (live C2: a path's on-demand git signals are keyed by exactly
 * that, so a commit touching one file leaves every other file's record valid).
 * bd tea-rags-mcp-xi2r9. An unknown commit or a path outside a repository rejects.
 */
export async function readPathCommitsSince(
  repoRoot: string,
  sinceCommit: string,
  headCommit: string,
  timeoutMs = TREE_LISTING_STALL_MS,
): Promise<PathCommitsSince> {
  const out = await execWithStallGuard(
    resolveGitExecutable(),
    [
      "log",
      "-z",
      `--format=${COMMIT_HEADER_MARK}%m%H`,
      "--name-only",
      "--no-renames",
      "--left-right",
      `${sinceCommit}...${headCommit}`,
      "--",
    ],
    { cwd: repoRoot, stallTimeoutMs: timeoutMs },
  );
  const headSide = new Map<string, string[]>();
  const stampSide = new Map<string, string[]>();
  let commit: { sha: string; side: Map<string, string[]> } | undefined;
  for (const token of splitNulTerminated(out)) {
    const entry = token.replace(/^\n+/, "");
    if (entry === "") continue;
    if (entry.startsWith(COMMIT_HEADER_MARK)) {
      const side = entry.charAt(1) === "<" ? stampSide : headSide;
      commit = { sha: entry.slice(2), side };
      continue;
    }
    if (!commit) continue;
    const shas = commit.side.get(entry);
    if (shas) shas.push(commit.sha);
    else commit.side.set(entry, [commit.sha]);
  }
  return { headSide, stampSide };
}

function splitNulTerminated(out: string): string[] {
  return out.split("\0").filter((p) => p.length > 0);
}

/** Lines of a file the working tree ADDED against a base: 1-based, inclusive on both ends. */
export interface AddedLineRange {
  start: number;
  end: number;
}

/**
 * Files the working tree changed against `base`, repo-relative and sorted: every
 * tracked path whose content differs from `base` (staged or not, `--no-renames`
 * so a move lists its new side) plus every untracked, non-ignored file. Paths
 * the working tree deleted are not listed — a naming review has nothing to read
 * in them.
 */
export async function listChangedFiles(
  repoRoot: string,
  base: string,
  timeoutMs = TREE_LISTING_STALL_MS,
): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    execWithStallGuard(
      resolveGitExecutable(),
      ["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", "--diff-filter=d", base, "--"],
      { cwd: repoRoot, stallTimeoutMs: timeoutMs },
    ),
    listUntrackedFiles(repoRoot, [], timeoutMs),
  ]);
  return [...new Set([...splitNulTerminated(tracked), ...untracked])].sort();
}

/** The working tree against a commit, repo-relative: what reads differently and what is gone. */
export interface WorkingTreeNameStatus {
  changed: string[];
  deleted: string[];
  /** The untracked, non-ignored files among `changed`. */
  untracked: string[];
}

/**
 * The working tree against `commit` (staged, unstaged and committed-since alike):
 * `git diff --name-status --no-renames <commit>` — a `D` entry is deleted, every
 * other status changed, so a move reads as its source deleted and its target
 * changed — plus every untracked, non-ignored file as changed. Both lists sorted.
 * An unknown commit or a path outside a repository rejects.
 */
export async function readWorkingTreeChanges(
  repoRoot: string,
  commit: string,
  timeoutMs = TREE_LISTING_STALL_MS,
): Promise<WorkingTreeNameStatus> {
  const [nameStatus, untracked] = await Promise.all([
    execWithStallGuard(
      resolveGitExecutable(),
      ["diff", "--no-ext-diff", "--no-renames", "--name-status", "-z", commit, "--"],
      { cwd: repoRoot, stallTimeoutMs: timeoutMs },
    ),
    listUntrackedFiles(repoRoot, [], timeoutMs),
  ]);
  const changed = new Set(untracked);
  const deleted: string[] = [];
  const fields = splitNulTerminated(nameStatus);
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] === "D") deleted.push(fields[i + 1]);
    else changed.add(fields[i + 1]);
  }
  return { changed: [...changed].sort(), deleted: deleted.sort(), untracked: [...untracked].sort() };
}

/** One move git detected between a commit and the working tree, repo-relative. */
export interface WorkingTreeRenamePair {
  from: string;
  to: string;
}

/**
 * The moves of the working tree against `commit`, as git's own rename
 * detection pairs them (`git diff -M --name-status <commit>`): staged, unstaged
 * and committed-since alike, edits within the similarity threshold included.
 *
 * `git diff` sees only paths the index tracks, so an unstaged move — the old
 * path deleted, the new one untracked — would read as an unrelated delete and
 * add. The `untracked` files are therefore marked intent-to-add (`add -N`) in a
 * THROWAWAY copy of the index (`GIT_INDEX_FILE`), which makes them diffable
 * candidates; the repository's own index is never written.
 */
export async function readWorkingTreeRenames(
  repoRoot: string,
  commit: string,
  untracked: readonly string[],
  timeoutMs = TREE_LISTING_STALL_MS,
): Promise<WorkingTreeRenamePair[]> {
  const git = resolveGitExecutable();
  const diffArgs = ["diff", "--no-ext-diff", "-M", "--name-status", "-z", commit, "--"];
  if (untracked.length === 0) {
    return parseRenamePairs(await execWithStallGuard(git, diffArgs, { cwd: repoRoot, stallTimeoutMs: timeoutMs }));
  }
  const indexPath = (
    await execWithStallGuard(git, ["rev-parse", "--path-format=absolute", "--git-path", "index"], {
      cwd: repoRoot,
      stallTimeoutMs: timeoutMs,
    })
  ).trim();
  const scratch = await mkdtemp(join(tmpdir(), "tea-rags-renames-"));
  const scratchIndex = join(scratch, "index");
  try {
    // A repository with no index yet (nothing ever staged) has no file to copy:
    // the scratch index then starts empty, which is what git would read.
    await copyFile(indexPath, scratchIndex).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    const env = { ...process.env, GIT_INDEX_FILE: scratchIndex };
    for (let i = 0; i < untracked.length; i += UNTRACKED_INTENT_BATCH) {
      await execWithStallGuard(
        git,
        ["--literal-pathspecs", "add", "-N", "--", ...untracked.slice(i, i + UNTRACKED_INTENT_BATCH)],
        {
          cwd: repoRoot,
          stallTimeoutMs: timeoutMs,
          env,
        },
      );
    }
    return parseRenamePairs(await execWithStallGuard(git, diffArgs, { cwd: repoRoot, stallTimeoutMs: timeoutMs, env }));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Paths per `add -N` — keeps the argv within OS ARG_MAX limits. */
const UNTRACKED_INTENT_BATCH = 500;

/** The `R<score> old new` entries of a `--name-status -z` diff; every other status names one path. */
function parseRenamePairs(nameStatus: string): WorkingTreeRenamePair[] {
  const fields = splitNulTerminated(nameStatus);
  const pairs: WorkingTreeRenamePair[] = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i];
    if (status.startsWith("R") || status.startsWith("C")) {
      if (status.startsWith("R") && i + 2 < fields.length) pairs.push({ from: fields[i + 1], to: fields[i + 2] });
      i += 3;
    } else {
      i += 2;
    }
  }
  return pairs;
}

/**
 * `git status --porcelain=v2 -z --branch --untracked-files=all`, verbatim: one
 * spawn that carries HEAD (the `# branch.oid <sha>` header, `(initial)` before
 * the first commit) and every staged, unstaged and untracked path. The text does
 * not move when an already-modified file is edited again.
 */
export async function readStatusPorcelain(repoRoot: string, timeoutMs = TREE_LISTING_STALL_MS): Promise<string> {
  return execWithStallGuard(
    resolveGitExecutable(),
    ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"],
    { cwd: repoRoot, stallTimeoutMs: timeoutMs },
  );
}

/**
 * The line ranges `relPath` gained against `base`, read from the hunk headers of
 * `git diff -U0` (`@@ -a,b +c,d @@` → `c..c+d-1`; `d` omitted means 1, `d = 0`
 * is a pure deletion and adds nothing). An untracked file was added whole, so it
 * reads as one range over every line it has.
 */
export async function readAddedLineRanges(
  repoRoot: string,
  base: string,
  relPath: string,
  timeoutMs = TREE_LISTING_STALL_MS,
): Promise<AddedLineRange[]> {
  if ((await listUntrackedFiles(repoRoot, [relPath], timeoutMs)).length > 0) {
    const lineCount = countLines(readFileSync(join(repoRoot, relPath), "utf8"));
    return lineCount > 0 ? [{ start: 1, end: lineCount }] : [];
  }
  const diff = await execWithStallGuard(
    resolveGitExecutable(),
    ["diff", "--no-ext-diff", "--no-color", "--no-renames", "-U0", base, "--", relPath],
    { cwd: repoRoot, stallTimeoutMs: timeoutMs },
  );
  return parseAddedHunkRanges(diff);
}

/**
 * {@link readAddedLineRanges} for many files in two subprocesses: one untracked
 * listing and one `git diff -U0` over every tracked path, split per file by its
 * `+++` header. Every asked path gets an entry — `[]` when nothing was added.
 * Paths are literal (`--literal-pathspecs`): `[id].ts` names a file, not a
 * character class.
 */
export async function readAddedLineRangesOfFiles(
  repoRoot: string,
  base: string,
  relPaths: readonly string[],
  timeoutMs = TREE_LISTING_STALL_MS,
): Promise<Map<string, AddedLineRange[]>> {
  const ranges = new Map<string, AddedLineRange[]>(relPaths.map((relPath) => [relPath, []]));
  if (relPaths.length === 0) return ranges;
  const untracked = new Set(
    splitNulTerminated(
      await execWithStallGuard(
        resolveGitExecutable(),
        ["--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "-z", "--", ...relPaths],
        { cwd: repoRoot, stallTimeoutMs: timeoutMs },
      ),
    ),
  );
  for (const relPath of untracked) {
    const lineCount = countLines(readFileSync(join(repoRoot, relPath), "utf8"));
    ranges.set(relPath, lineCount > 0 ? [{ start: 1, end: lineCount }] : []);
  }
  const tracked = relPaths.filter((relPath) => !untracked.has(relPath));
  if (tracked.length === 0) return ranges;
  const diff = await execWithStallGuard(
    resolveGitExecutable(),
    [
      "-c",
      "core.quotePath=false",
      "--literal-pathspecs",
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--no-renames",
      "-U0",
      base,
      "--",
      ...tracked,
    ],
    { cwd: repoRoot, stallTimeoutMs: timeoutMs },
  );
  for (const [relPath, added] of parseAddedHunkRangesPerFile(diff)) {
    if (ranges.has(relPath)) ranges.set(relPath, added);
  }
  return ranges;
}

/**
 * A multi-file `-U0` diff split per file. The file is the `+++ b/<path>` side;
 * a deletion (`+++ /dev/null`) keeps its `--- a/<path>` side and adds nothing.
 */
function parseAddedHunkRangesPerFile(diff: string): Map<string, AddedLineRange[]> {
  const perFile = new Map<string, AddedLineRange[]>();
  let oldPath: string | undefined;
  let current: string | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      oldPath = undefined;
      current = undefined;
    } else if (line.startsWith("--- ")) {
      oldPath = diffHeaderPath(line.slice(4), "a/");
    } else if (line.startsWith("+++ ")) {
      current = diffHeaderPath(line.slice(4), "b/") ?? oldPath;
      if (current !== undefined && !perFile.has(current)) perFile.set(current, []);
    } else if (current !== undefined && line.startsWith("@@ ")) {
      perFile.get(current)?.push(...parseAddedHunkRanges(line));
    }
  }
  return perFile;
}

/**
 * The path of a `---` / `+++` header side: `/dev/null` → undefined; a trailing
 * TAB (git's marker after a name holding a space) dropped; a C-quoted name
 * (`"b/a\"b.ts"`, what `core.quotePath=false` still quotes) unquoted.
 */
function diffHeaderPath(raw: string, prefix: "a/" | "b/"): string | undefined {
  const name = raw.endsWith("\t") ? raw.slice(0, -1) : raw;
  if (name === "/dev/null") return undefined;
  const unquoted = name.startsWith('"') && name.endsWith('"') ? unquoteGitPath(name.slice(1, -1)) : name;
  return unquoted.startsWith(prefix) ? unquoted.slice(prefix.length) : unquoted;
}

const GIT_PATH_ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

/** Git's C-style path quoting reversed: named escapes and `\ooo` octal bytes, decoded as UTF-8. */
function unquoteGitPath(body: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const next = body[i + 1] ?? "";
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(GIT_PATH_ESCAPES[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

async function listUntrackedFiles(repoRoot: string, pathspec: string[], timeoutMs: number): Promise<string[]> {
  const out = await execWithStallGuard(
    resolveGitExecutable(),
    ["ls-files", "--others", "--exclude-standard", "-z", "--", ...pathspec],
    { cwd: repoRoot, stallTimeoutMs: timeoutMs },
  );
  return splitNulTerminated(out);
}

const ADDED_HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;

function parseAddedHunkRanges(diff: string): AddedLineRange[] {
  const ranges: AddedLineRange[] = [];
  for (const match of diff.matchAll(ADDED_HUNK_HEADER)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count > 0) ranges.push({ start, end: start + count - 1 });
  }
  return ranges;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const newlines = text.split("\n").length - 1;
  return text.endsWith("\n") ? newlines : newlines + 1;
}

/** Run a single pathspec-filtered git log and parse the output. */
export async function getCommitsByPathspecSingle(
  repoRoot: string,
  sinceDate: Date,
  filePaths: string[],
  timeoutMs?: number,
): Promise<CommitWithChangedFiles[]> {
  const effectiveTimeoutMs = timeoutMs ?? 30000;
  const args = [
    "log",
    `--since=${sinceDate.toISOString()}`,
    "--format=%x00%H%x00%P%x00%an%x00%ae%x00%at%x00%B%x00",
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
): Promise<CommitWithChangedFiles[]> {
  const batchSize = PATHSPEC_BATCH_SIZE;
  const batches: string[][] = [];
  for (let i = 0; i < filePaths.length; i += batchSize) {
    batches.push(filePaths.slice(i, i + batchSize));
  }

  if (isDebug()) {
    console.error(
      `[ChunkChurn] Pathspec batching: ${filePaths.length} files → ${batches.length} batches of ≤${batchSize}`,
    );
  }

  // Deduped by CURRENT path: the same file can surface in several batches, and
  // its rename pair is identical every time it does (the pair is a property of
  // the commit, not of the batch) — so first writer wins.
  const merged = new Map<string, { commit: CommitInfo; changedFiles: Map<string, CommitChangedPath> }>();

  for (const batch of batches) {
    try {
      const batchResult = await getCommitsByPathspecSingle(repoRoot, sinceDate, batch, timeoutMs);
      for (const entry of batchResult) {
        const existing = merged.get(entry.commit.sha);
        const target = existing?.changedFiles ?? new Map<string, CommitChangedPath>();
        for (const changed of entry.changedFiles) {
          if (!target.has(changed.path)) target.set(changed.path, changed);
        }
        if (!existing) merged.set(entry.commit.sha, { commit: entry.commit, changedFiles: target });
      }
    } catch (error) {
      if (isDebug()) {
        console.error(
          `[ChunkChurn] Pathspec batch failed (${batch.length} files):`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  return Array.from(merged.values()).map(({ commit, changedFiles }) => ({
    commit,
    changedFiles: Array.from(changedFiles.values()),
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
): Promise<CommitWithChangedFiles[]> {
  if (filePaths.length === 0) return [];

  if (filePaths.length > PATHSPEC_BATCH_SIZE) {
    return getCommitsByPathspecBatched(repoRoot, sinceDate, filePaths, timeoutMs);
  }

  return getCommitsByPathspecSingle(repoRoot, sinceDate, filePaths, timeoutMs);
}

// ── Blame primitive ──────────────────────────────────────────────

/**
 * Run `git blame --porcelain HEAD -- <file>` and return per-line attributions.
 * Returns an empty array when the file is untracked, missing, or the command
 * fails — callers treat absence of blame data as "no ownership signal", not as
 * an error condition.
 */
export async function blameFile(repoRoot: string, filePath: string, timeoutMs?: number): Promise<BlameLine[]> {
  try {
    const { stdout } = await execFileAsync(resolveGitExecutable(), ["blame", "--porcelain", "HEAD", "--", filePath], {
      cwd: repoRoot,
      maxBuffer: Infinity,
      timeout: timeoutMs,
    });
    return parseBlameOutput(stdout);
  } catch {
    return [];
  }
}

/**
 * One-time pre-enrichment warmup: `git commit-graph write --reachable
 * --changed-paths`. The commit-graph gives O(1) generation-number reachability
 * (accelerates every `git log`) and the `--changed-paths` Bloom filters
 * accelerate pathspec `git log` AND `git blame` — a free speedup for the whole
 * enrichment sweep regardless of adapter. Best-effort: any failure (no repo
 * write access, concurrent gc lock, old git) is swallowed — the graph is a pure
 * optimization, never a correctness dependency. Persists on disk, so subsequent
 * runs (and incremental reindexes) reuse it.
 */
export async function writeCommitGraph(repoRoot: string, timeoutMs?: number): Promise<void> {
  try {
    await execFileAsync(resolveGitExecutable(), ["commit-graph", "write", "--reachable", "--changed-paths"], {
      cwd: repoRoot,
      timeout: timeoutMs,
    });
  } catch {
    // Optimization only — proceed without it.
  }
}
