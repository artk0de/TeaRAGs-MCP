/**
 * Git CLI object reads — `git cat-file` blob readers (one-shot and persistent
 * `--batch` / `--batch-check` processes) and the blob-introduction commit time.
 */

import { spawn } from "node:child_process";

import { buildGitChildProcessEnv, resolveGitExecutable } from "../git-executable.js";
import { execFileAsync, TREE_LISTING_STALL_MS } from "./exec.js";
import { trackGitChildProcess } from "./git-child-process-registry.js";
import { execWithStallGuard } from "./stall-guard-exec.js";

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
      env: buildGitChildProcessEnv(),
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
      env: buildGitChildProcessEnv(),
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
