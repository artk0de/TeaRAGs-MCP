/**
 * WorkingTreeBasePointStore (bd tea-rags-mcp-xi2r9) — the LIGHT tier of the
 * touched-file base points (`WorkingTreeTouchedBasePoints`), kept across
 * processes. Every MCP call is its own process under `tea-rags call`; on a tree
 * 3,198 files from its index each one re-scrolled every touched path (live
 * probe: 3.9 s of Qdrant and 1.4 s of JSON parse per call). What a light point
 * holds — id, `relativePath`, `symbolId`, the span — is fixed by the index run
 * that wrote it, so a record of one index revision answers every later process
 * at that revision.
 *
 * One JSON record per index revision (`WorkingTreeTouchedBasePoints` builds it
 * from the collection, the registry's `indexedAt` and the point count): every
 * path read at that revision → its light points, `[]` for a path the index
 * holds none of. The file name hashes the revision; the record repeats it, so
 * a collision reads as a miss. A new revision writes a new record; the old one
 * is never read again and ages out.
 *
 * - Writes go through a `WorkingTreeFileWriter` (a pid-named temp renamed into
 *   place): a reader sees a whole record or none. Two processes writing one
 *   revision lose at most the other's additions, which the next miss scrolls.
 * - A read bumps the file's mtime — the record's last read. `sweep` evicts a
 *   record unread {@link WORKING_TREE_BASE_POINT_RETENTION_MS}, then the least
 *   recently read until the store fits its cap, and reaps abandoned temps.
 *   `scheduleWorkingTreeBasePointSweep` runs it in a long-lived server only.
 *
 * The directory sits under the working-tree store root behind a leading dot, so
 * the collection-named walks beside it (chunk store, tree-graph cache) never
 * take it for a collection. Nothing outside it is touched. Never rejects on
 * I/O: a failed read is a miss, a failed write is dropped.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import type {
  WorkingTreeBasePoint,
  WorkingTreeTouchedBasePointsByPath,
} from "../../../contracts/types/working-tree.js";
import {
  createWorkingTreeFileWriter,
  reapAbandonedWorkingTreeTemps,
  type WorkingTreeFileWriter,
} from "./file-writer.js";

export interface WorkingTreeBasePointStoreSweep {
  evicted: number;
  kept: number;
  bytes: number;
}

export interface WorkingTreeBasePointStore {
  /** Every path stored for `revision` (empty ones included), its last read bumped to now; undefined on a miss. */
  read: (revision: string) => Promise<WorkingTreeTouchedBasePointsByPath | undefined>;
  /** Replaces the record of `revision`. */
  write: (revision: string, points: WorkingTreeTouchedBasePointsByPath) => Promise<void>;
  sweep: (now?: number) => Promise<WorkingTreeBasePointStoreSweep>;
}

export interface WorkingTreeBasePointStoreDeps {
  /** `<dataDir>/working-tree` — the store keeps its records in a directory of its own below it. */
  rootDir: string;
  now?: () => number;
  capBytes?: number;
  /** Shared with the other working-tree stores and closed at cleanup; defaults to a private one. */
  writer?: WorkingTreeFileWriter;
}

export const WORKING_TREE_BASE_POINT_RETENTION_MS = 96 * 3_600_000;
export const WORKING_TREE_BASE_POINT_STORE_CAP_BYTES = 64 * 1024 * 1024;
export const WORKING_TREE_BASE_POINT_SWEEP_DELAY_MS = 2 * 60_000;
export const WORKING_TREE_BASE_POINT_SWEEP_INTERVAL_MS = 6 * 3_600_000;

const STORE_DIR = ".base-points";
const RECORD_SUFFIX = ".json";
const TEMP_SUFFIX = ".tmp";
/** A temp of a live (or unknown) writer older than this is dead too. */
const ABANDONED_WRITE_GRACE_MS = 3_600_000;
const RECORD_FORMAT = 1;

interface StoredRecord {
  format: number;
  revision: string;
  paths: Record<string, WorkingTreeBasePoint[]>;
}

export function createWorkingTreeBasePointStore(deps: WorkingTreeBasePointStoreDeps): WorkingTreeBasePointStore {
  const dir = join(deps.rootDir, STORE_DIR);
  const writer = deps.writer ?? createWorkingTreeFileWriter();
  const now = deps.now ?? Date.now;
  const capBytes = deps.capBytes ?? WORKING_TREE_BASE_POINT_STORE_CAP_BYTES;
  const pathOf = (revision: string): string =>
    join(dir, `${createHash("sha256").update(revision).digest("hex")}${RECORD_SUFFIX}`);

  return {
    async read(revision) {
      const path = pathOf(revision);
      let stored: unknown;
      try {
        stored = JSON.parse(await fs.readFile(path, "utf8"));
      } catch {
        return undefined;
      }
      const points = pointsOfRecord(stored, revision);
      if (!points) return undefined;
      const at = new Date(now());
      await fs.utimes(path, at, at).catch(() => undefined);
      return points;
    },

    async write(revision, points) {
      const stored: StoredRecord = {
        format: RECORD_FORMAT,
        revision,
        paths: Object.fromEntries([...points].map(([path, pathPoints]) => [path, [...pathPoints]])),
      };
      try {
        await fs.mkdir(dir, { recursive: true });
        await writer.write(pathOf(revision), JSON.stringify(stored));
      } catch {
        // A dropped write: the next process scrolls what it would have held.
      }
    },

    async sweep(at = now()) {
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch {
        return { evicted: 0, kept: 0, bytes: 0 };
      }
      await reapAbandonedWorkingTreeTemps(dir, { at, graceMs: ABANDONED_WRITE_GRACE_MS });
      let evicted = 0;
      const kept: { path: string; bytes: number; readAt: number }[] = [];
      for (const name of names) {
        if (name.endsWith(TEMP_SUFFIX) || !name.endsWith(RECORD_SUFFIX)) continue;
        const path = join(dir, name);
        const stat = await fs.stat(path).catch(() => undefined);
        if (!stat?.isFile()) continue;
        if (at - stat.mtimeMs >= WORKING_TREE_BASE_POINT_RETENTION_MS) {
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

/**
 * Sweeps after `initialDelayMs`, then every `intervalMs`, on timers that do not
 * hold the process open — a one-shot `tea-rags call` exits before its first
 * sweep, so only a long-lived server sweeps. Returns the stop.
 */
export function scheduleWorkingTreeBasePointSweep(
  store: Pick<WorkingTreeBasePointStore, "sweep">,
  {
    initialDelayMs = WORKING_TREE_BASE_POINT_SWEEP_DELAY_MS,
    intervalMs = WORKING_TREE_BASE_POINT_SWEEP_INTERVAL_MS,
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

/** The record's points when it is a whole record of `revision`; undefined otherwise. */
function pointsOfRecord(stored: unknown, revision: string): WorkingTreeTouchedBasePointsByPath | undefined {
  if (!isObject(stored) || stored.format !== RECORD_FORMAT || stored.revision !== revision) return undefined;
  if (!isObject(stored.paths)) return undefined;
  const byPath = new Map<string, readonly WorkingTreeBasePoint[]>();
  for (const [path, points] of Object.entries(stored.paths)) {
    if (!Array.isArray(points) || !points.every(isBasePoint)) return undefined;
    byPath.set(path, points);
  }
  return byPath;
}

function isBasePoint(value: unknown): value is WorkingTreeBasePoint {
  return isObject(value) && (typeof value.id === "string" || typeof value.id === "number") && isObject(value.payload);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
