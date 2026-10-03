/**
 * WorkingTreeFileWriter (bd tea-rags-mcp-xi2r9, B1) — the one way the
 * working-tree stores (chunk store, git-signal store, tree-graph cache) put a
 * file on disk, and the one rule for what an abandoned write looks like.
 *
 * A write goes to `<target>.<pid>.<hex>.tmp` and is renamed into place, so a
 * reader sees the whole file or the previous one. Three ways a temp could be
 * stranded, and what closes each:
 *
 * - the write fails (disk full, the target is not replaceable) → the writer
 *   removes its temp before rejecting;
 * - the process exits with the write in flight — live: 8 of 20 cold
 *   `tea-rags call` runs stranded a `lastReadAt` bump of background warm-up
 *   work at `process.exit` → `close` is the defined flush point: it waits for
 *   every write in flight and refuses every later one. The composition root's
 *   cleanup awaits it, and `tea-rags call` awaits cleanup before exiting;
 * - the process dies anyway (SIGKILL, a cleanup that ran out of time) → the
 *   temp names its writer's pid, and {@link reapAbandonedWorkingTreeTemps}
 *   (called by every store's sweep) removes it as soon as that pid is gone,
 *   instead of after the hour's grace a pid-less name needs.
 */

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

export interface WorkingTreeFileWriter {
  /**
   * Write `data` to `target` through a pid-named temp renamed into place. A
   * failed write removes its temp and rejects. Once `close` was called, a no-op.
   */
  write: (target: string, data: string) => Promise<void>;
  /** Resolves once every write in flight has landed or failed; refuses every later write. Idempotent. */
  close: () => Promise<void>;
}

/** `<target>.<pid>.<hex>.tmp` — what this module writes, and the only name the reap removes. */
const TEMP_NAME = /\.(\d+)\.[0-9a-f]+\.tmp$/;

export function createWorkingTreeFileWriter(): WorkingTreeFileWriter {
  const inFlight = new Set<Promise<void>>();
  let closed = false;

  const writeThroughTemp = async (target: string, data: string): Promise<void> => {
    const temp = `${target}.${String(process.pid)}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await fs.writeFile(temp, data);
      await fs.rename(temp, target);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  };

  return {
    async write(target, data) {
      if (closed) return;
      // Registered before the first await, so a `close` in the same turn waits for it.
      const write = writeThroughTemp(target, data);
      const settled = write.then(
        () => undefined,
        () => undefined,
      );
      inFlight.add(settled);
      try {
        await write;
      } finally {
        inFlight.delete(settled);
      }
    },

    async close() {
      closed = true;
      await Promise.all([...inFlight]);
    },
  };
}

export interface WorkingTreeTempReapOptions {
  /** The sweep's clock. */
  at: number;
  /** A temp of a live (or unknown) writer older than this is dead too. */
  graceMs: number;
  /** Only temps of targets whose name starts with this — for a directory shared with other owners. */
  prefix?: string;
}

/**
 * Remove the temps under `dir` (not below it) a writer abandoned: its pid is
 * gone, or the temp is older than `graceMs` (a recycled pid reads as alive, so
 * the grace still backs the pid check up). A temp of this very process is only
 * ever removed by age — its write may be in flight. Returns how many went.
 * Never rejects: a directory that cannot be read reaps nothing.
 */
export async function reapAbandonedWorkingTreeTemps(dir: string, options: WorkingTreeTempReapOptions): Promise<number> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const owner = TEMP_NAME.exec(name)?.[1];
    if (owner === undefined || (options.prefix !== undefined && !name.startsWith(options.prefix))) continue;
    const path = join(dir, name);
    const abandoned =
      isWriterGone(Number(owner)) ||
      (await fs.stat(path).then(
        (stat) => stat.isFile() && options.at - stat.mtimeMs >= options.graceMs,
        () => false,
      ));
    if (!abandoned) continue;
    await fs.rm(path, { force: true }).catch(() => undefined);
    removed++;
  }
  return removed;
}

/**
 * Whether the process `pid` is gone. This process is never gone; a pid that
 * may not be signalled (`EPERM`) is alive.
 */
export function isWriterGone(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
