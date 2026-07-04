/**
 * Low-level git operations — CLI only. No enrichment concepts, no caching.
 *
 * Everything (log walking, object reads, ref resolution) goes through the git
 * CLI. isomorphic-git was removed: its pack reader loaded the ENTIRE packfile
 * into a JS ArrayBuffer (heap profiler caught 3×1.4 GB on a large repo → 16 GB
 * OOM). `git cat-file` / `git rev-parse` stream individual objects from disk,
 * so resident memory never includes the whole pack.
 */

import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";

import { isDebug } from "../../../../infra/runtime.js";
import type { BlameLine, CommitInfo, FileChurnData } from "../../types.js";
import { parseBlameOutput, parseNumstatOutput, parsePathspecOutput } from "./parsers.js";

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
  const args = ["log", "HEAD", "--numstat", "--format=%x00%H%x00%P%x00%an%x00%ae%x00%at%x00%B%x00"];
  if (sinceDate) {
    args.push(`--since=${sinceDate.toISOString()}`);
  }
  return args;
}

/** Resolve HEAD SHA via CLI `git rev-parse HEAD`. */
export async function getHead(repoRoot: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  return stdout.trim();
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
export async function buildViaCli(
  repoRoot: string,
  sinceDate?: Date,
  timeoutMs?: number,
): Promise<Map<string, FileChurnData>> {
  const args = buildCliArgs(sinceDate);
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoRoot,
    maxBuffer: Infinity,
    timeout: timeoutMs,
  });
  return parseNumstatOutput(stdout);
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
    const { stdout } = await execFileAsync("git", ["cat-file", "blob", `${commitOid}:${filepath}`], {
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
    const c = spawn("git", ["cat-file", "--batch"], { cwd: repoRoot, stdio: ["pipe", "pipe", "ignore"] });
    c.stdout?.on("data", onData);
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
    const c = spawn("git", ["cat-file", "--batch-check"], { cwd: repoRoot, stdio: ["pipe", "pipe", "ignore"] });
    c.stdout?.on("data", onData);
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
): Promise<{ commit: CommitInfo; changedFiles: string[] }[]> {
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
): Promise<{ commit: CommitInfo; changedFiles: string[] }[]> {
  const effectiveTimeoutMs = timeoutMs ?? 30000;
  const args = ["log", `--since=${sinceDate.toISOString()}`, `${fromSha}..${toSha}`, NUMSTAT_LOG_FORMAT, "--numstat"];
  const stdout = await execFileForPathspec(repoRoot, args, effectiveTimeoutMs);
  return parsePathspecOutput(stdout);
}

/**
 * True iff `ancestor` is an ancestor of `descendant` per
 * `git merge-base --is-ancestor`. Any failure — non-ancestor exit code,
 * unresolvable / gc'd shas, not a repo — resolves false, which callers treat
 * as "cannot top up, rebuild fully" (bd tea-rags-mcp-82va1).
 */
export async function isAncestor(repoRoot: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

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
): Promise<{ commit: CommitInfo; changedFiles: string[] }[]> {
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

// ── Blame primitive ──────────────────────────────────────────────

/**
 * Run `git blame --porcelain HEAD -- <file>` and return per-line attributions.
 * Returns an empty array when the file is untracked, missing, or the command
 * fails — callers treat absence of blame data as "no ownership signal", not as
 * an error condition.
 */
export async function blameFile(repoRoot: string, filePath: string, timeoutMs?: number): Promise<BlameLine[]> {
  try {
    const { stdout } = await execFileAsync("git", ["blame", "--porcelain", "HEAD", "--", filePath], {
      cwd: repoRoot,
      maxBuffer: Infinity,
      timeout: timeoutMs,
    });
    return parseBlameOutput(stdout);
  } catch {
    return [];
  }
}
