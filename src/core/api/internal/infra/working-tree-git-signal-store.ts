/**
 * WorkingTreeGitSignalStore (bd tea-rags-mcp-xi2r9, live G2) — the on-demand
 * git signals of working-tree delta files, kept across processes. Every MCP
 * call is its own process under `tea-rags call`, and a cold `find_symbol` on a
 * 159-file delta spawned 136 `git blame` + 137 `git cat-file` (~3 s) each time;
 * the blocks those spawns produce depend only on what the record key holds.
 *
 * One JSON record per (repository toplevel, HEAD, history path, signal
 * fingerprint, UTC day): its `git.file` blocks by line extent and its
 * `git.chunk` blocks by (tree-file content sha, row range) — the keys
 * `createWorkingTreeGitSignalSource` caches by in memory. A
 * computed "no history" is a `null` block, so it is a hit too.
 *
 * - The UTC day is in the key because the blocks carry time-relative values
 *   (`ageDays`, `recencyWeightedFreq`, `changeDensity`): a record answers for
 *   one day, as a value computed that day would.
 * - The file name hashes the key; the record repeats it, so a hash collision
 *   reads as a miss, never as another file's signals.
 * - Writes go through a `WorkingTreeFileWriter` — a pid-named temp renamed into
 *   place, so a reader sees a whole record or none, and a temp whose writer is
 *   gone is swept at once; two processes writing one record lose at most the
 *   other's additions, which the next miss recomputes.
 * - A read bumps the file's mtime — the record's last read. `sweep` evicts a
 *   record unread {@link WORKING_TREE_GIT_SIGNAL_RETENTION_MS} (96 h, the chunk
 *   store's window), then the least recently read until the store fits its cap.
 *   A record of a superseded HEAD or day is never read again and ages out.
 *   `scheduleWorkingTreeGitSignalSweep` runs it in a long-lived server only.
 *
 * The directory sits under the working-tree store root, named so neither the
 * chunk store nor the tree-graph cache — which walk collection-named
 * directories there — ever takes it for a collection. Nothing outside it is
 * touched. Never rejects on I/O: a failed read is a miss, a failed write is
 * dropped.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  createWorkingTreeFileWriter,
  reapAbandonedWorkingTreeTemps,
  type WorkingTreeFileWriter,
} from "../../../domains/explore/working-tree/index.js";

/** A stored block; `null` = computed, and there was nothing to give. */
export type WorkingTreeGitSignalBlock = Record<string, unknown> | null;

/** One history path's computed blocks at one HEAD, fingerprint and day. */
export interface WorkingTreeGitSignalRecord {
  /** `git.file` by the line extent it was computed over. */
  file: Record<string, WorkingTreeGitSignalBlock>;
  /** `git.chunk` by `<content sha>:<startLine>-<endLine>` in the tree file's lines. */
  chunks: Record<string, WorkingTreeGitSignalBlock>;
}

export interface WorkingTreeGitSignalStoreSweep {
  evicted: number;
  kept: number;
  bytes: number;
}

export interface WorkingTreeGitSignalStore {
  /** The record stored under `key`, its last read bumped to now; undefined on a miss. */
  read: (key: string) => Promise<WorkingTreeGitSignalRecord | undefined>;
  /** Replaces the record under `key`. */
  write: (key: string, record: WorkingTreeGitSignalRecord) => Promise<void>;
  sweep: (now?: number) => Promise<WorkingTreeGitSignalStoreSweep>;
}

export interface WorkingTreeGitSignalStoreDeps {
  /** `<dataDir>/working-tree` — the store keeps its records in a directory of its own below it. */
  rootDir: string;
  now?: () => number;
  capBytes?: number;
  /** Shared with the other working-tree stores and closed at cleanup (bd tea-rags-mcp-xi2r9, B1); defaults to a private one. */
  writer?: WorkingTreeFileWriter;
}

export const WORKING_TREE_GIT_SIGNAL_RETENTION_MS = 96 * 3_600_000;
export const WORKING_TREE_GIT_SIGNAL_STORE_CAP_BYTES = 64 * 1024 * 1024;

/** A leading dot keeps the directory out of the collection-named walks beside it. */
const STORE_DIR = ".git-signals";
const RECORD_SUFFIX = ".json";
/** The pid-less temp naming of earlier builds (`<record>.part-<hex>`), reaped by age only. */
const LEGACY_PART_MARKER = ".part-";
/** The writer's temps: `<record>.<pid>.<hex>.tmp`. */
const TEMP_SUFFIX = ".tmp";
/** A temp file older than this is a dead write. */
const ABANDONED_WRITE_GRACE_MS = 3_600_000;
const RECORD_FORMAT = 1;

interface StoredRecord extends WorkingTreeGitSignalRecord {
  format: number;
  key: string;
}

export function createWorkingTreeGitSignalStore(deps: WorkingTreeGitSignalStoreDeps): WorkingTreeGitSignalStore {
  const dir = join(deps.rootDir, STORE_DIR);
  const writer = deps.writer ?? createWorkingTreeFileWriter();
  const now = deps.now ?? Date.now;
  const capBytes = deps.capBytes ?? WORKING_TREE_GIT_SIGNAL_STORE_CAP_BYTES;
  const pathOf = (key: string): string =>
    join(dir, `${createHash("sha256").update(key).digest("hex")}${RECORD_SUFFIX}`);

  return {
    async read(key) {
      const path = pathOf(key);
      let stored: StoredRecord;
      try {
        stored = JSON.parse(await fs.readFile(path, "utf8")) as StoredRecord;
      } catch {
        return undefined;
      }
      if (
        stored.format !== RECORD_FORMAT ||
        stored.key !== key ||
        !isBlockMap(stored.file) ||
        !isBlockMap(stored.chunks)
      ) {
        return undefined;
      }
      const at = new Date(now());
      await fs.utimes(path, at, at).catch(() => undefined);
      return { file: stored.file, chunks: stored.chunks };
    },

    async write(key, record) {
      const stored: StoredRecord = { format: RECORD_FORMAT, key, file: record.file, chunks: record.chunks };
      try {
        await fs.mkdir(dir, { recursive: true });
        // The writer removes its own temp when the write fails.
        await writer.write(pathOf(key), JSON.stringify(stored));
      } catch {
        // A dropped write: the next miss recomputes the record.
      }
    },

    async sweep(at = now()) {
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch {
        return { evicted: 0, kept: 0, bytes: 0 };
      }
      let evicted = 0;
      const kept: { path: string; bytes: number; readAt: number }[] = [];
      // The writer's pid-named temps: a dead writer's go at once, others after the grace.
      await reapAbandonedWorkingTreeTemps(dir, { at, graceMs: ABANDONED_WRITE_GRACE_MS });
      for (const name of names) {
        if (name.endsWith(TEMP_SUFFIX)) continue;
        const path = join(dir, name);
        const stat = await fs.stat(path).catch(() => undefined);
        if (!stat?.isFile()) continue;
        // A temp of the pid-less naming earlier builds wrote: by age only.
        if (name.includes(LEGACY_PART_MARKER)) {
          if (at - stat.mtimeMs >= ABANDONED_WRITE_GRACE_MS) await fs.rm(path, { force: true });
          continue;
        }
        if (!name.endsWith(RECORD_SUFFIX)) continue;
        if (at - stat.mtimeMs >= WORKING_TREE_GIT_SIGNAL_RETENTION_MS) {
          await fs.rm(path, { force: true });
          evicted++;
          continue;
        }
        kept.push({ path, bytes: stat.size, readAt: stat.mtimeMs });
      }
      let bytes = kept.reduce((sum, record) => sum + record.bytes, 0);
      let survivors = kept.length;
      kept.sort((a, b) => a.readAt - b.readAt);
      for (const record of kept) {
        if (bytes <= capBytes) break;
        await fs.rm(record.path, { force: true });
        bytes -= record.bytes;
        evicted++;
        survivors--;
      }
      return { evicted, kept: survivors, bytes };
    },
  };
}

export const WORKING_TREE_GIT_SIGNAL_SWEEP_DELAY_MS = 2 * 60_000;
export const WORKING_TREE_GIT_SIGNAL_SWEEP_INTERVAL_MS = 6 * 3_600_000;

/**
 * Sweeps after `initialDelayMs`, then every `intervalMs`, on timers that do not
 * hold the process open — so a one-shot `tea-rags call` exits before its first
 * sweep and only a long-lived server sweeps. Returns the stop.
 */
export function scheduleWorkingTreeGitSignalSweep(
  store: Pick<WorkingTreeGitSignalStore, "sweep">,
  {
    initialDelayMs = WORKING_TREE_GIT_SIGNAL_SWEEP_DELAY_MS,
    intervalMs = WORKING_TREE_GIT_SIGNAL_SWEEP_INTERVAL_MS,
  }: { initialDelayMs?: number; intervalMs?: number } = {},
): () => void {
  const sweep = (): void => {
    void store.sweep().catch(() => undefined);
  };
  let interval: ReturnType<typeof setInterval> | undefined;
  const first = setTimeout(() => {
    sweep();
    interval = setInterval(sweep, intervalMs);
    interval.unref?.();
  }, initialDelayMs);
  first.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(interval);
  };
}

function isBlockMap(value: unknown): value is Record<string, WorkingTreeGitSignalBlock> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
