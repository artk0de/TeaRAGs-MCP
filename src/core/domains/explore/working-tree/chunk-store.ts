/**
 * WorkingTreeChunkStore (bd tea-rags-mcp-xi2r9.3) — the delta-chunk cache that
 * outlives the process, so a restarted server does not re-chunk a tree it has
 * already seen. It sits behind `WorkingTreeChunkLayer`'s memory cache.
 *
 * Layout: `<rootDir>/<collection>/<key>.meta.json` + `<key>.rows.json`, where
 * `<key>` hashes everything the rows depend on — the tree root (chunk ids and
 * `codebasePath` carry it), the path, the content hash and the chunker
 * fingerprint. The meta file is small and is the entry's commit point: rows are
 * written first, meta last, so a sweep reads meta only and stats the rows.
 * Every write is a temp file renamed into place.
 *
 * Retention (`sweep`): a tree root that no longer exists → evict now; content
 * committed (its blob appears in the tree's history for that path) and idle
 * `WORKING_TREE_CHUNK_RETENTION_MS` since max(commit time, last read) → evict;
 * uncommitted content of a live tree → keep; then least-recently-read entries
 * go until the store fits its byte cap. Nothing outside `rootDir` is touched.
 */

import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { readBlobCommitTime as gitReadBlobCommitTime } from "../../../adapters/vcs/git/git-cli/client.js";
import type { ScrollChunk } from "../chunk-grouping/types.js";

/** What identifies one cached file: rows differ whenever any of these differ. */
export interface WorkingTreeChunkStoreKey {
  treeRoot: string;
  relativePath: string;
  contentSha256: string;
  /** The chunker config and build that produced the rows. */
  chunkerFingerprint: string;
}

export interface WorkingTreeChunkStoreEntry extends WorkingTreeChunkStoreKey {
  /** git hash-object id of the content — how `sweep` asks git whether it is committed. */
  blobId: string;
  rows: readonly ScrollChunk[];
  lastReadAt: number;
}

export interface WorkingTreeChunkStoreSweep {
  evicted: number;
  kept: number;
  /** Bytes the kept entries occupy on disk. */
  bytes: number;
}

export interface WorkingTreeChunkStore {
  /** The entry, with `lastReadAt` bumped to now (durably); undefined on a miss. */
  get: (collectionName: string, key: WorkingTreeChunkStoreKey) => Promise<WorkingTreeChunkStoreEntry | undefined>;
  put: (collectionName: string, entry: Omit<WorkingTreeChunkStoreEntry, "lastReadAt">) => Promise<void>;
  sweep: (now?: number) => Promise<WorkingTreeChunkStoreSweep>;
}

export interface WorkingTreeChunkStoreDeps {
  /** `<dataDir>/working-tree` */
  rootDir: string;
  readBlobCommitTime?: (root: string, relativePath: string, blobId: string) => Promise<number | null>;
  now?: () => number;
  capBytes?: number;
}

export const WORKING_TREE_CHUNK_RETENTION_MS = 96 * 3_600_000;
export const WORKING_TREE_CHUNK_STORE_CAP_BYTES = 512 * 1024 * 1024;
export const WORKING_TREE_CHUNK_SWEEP_INTERVAL_MS = 6 * 3_600_000;

/** A rows file with no meta, or a temp file, older than this is a dead write. */
const ABANDONED_WRITE_GRACE_MS = 3_600_000;
const META_SUFFIX = ".meta.json";
const ROWS_SUFFIX = ".rows.json";
const TMP_SUFFIX = ".tmp";
/** A collection name is one path segment; anything else would address outside the root. */
const COLLECTION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The id git assigns the content as a blob: sha1 of `blob <length>\0<content>`. */
export function computeGitBlobId(content: Buffer): string {
  return createHash("sha1")
    .update(`blob ${String(content.length)}\0`)
    .update(content)
    .digest("hex");
}

/** Sweeps now and every `intervalMs` on a timer that does not hold the process open; returns the stop. */
export function scheduleWorkingTreeChunkSweep(
  store: Pick<WorkingTreeChunkStore, "sweep">,
  intervalMs: number = WORKING_TREE_CHUNK_SWEEP_INTERVAL_MS,
): () => void {
  const sweep = (): void => {
    void store.sweep().catch(() => undefined);
  };
  sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
  };
}

type StoredMeta = Omit<WorkingTreeChunkStoreEntry, "rows">;

export function createWorkingTreeChunkStore(deps: WorkingTreeChunkStoreDeps): WorkingTreeChunkStore {
  const { rootDir } = deps;
  const now = deps.now ?? Date.now;
  const capBytes = deps.capBytes ?? WORKING_TREE_CHUNK_STORE_CAP_BYTES;
  const readBlobCommitTime = deps.readBlobCommitTime ?? gitReadBlobCommitTime;

  const collectionDir = (collectionName: string): string | undefined =>
    COLLECTION_NAME.test(collectionName) ? join(rootDir, collectionName) : undefined;

  const entryKey = (key: WorkingTreeChunkStoreKey): string =>
    createHash("sha256")
      .update(JSON.stringify([key.treeRoot, key.relativePath, key.contentSha256, key.chunkerFingerprint]))
      .digest("hex");

  const writeAtomic = async (target: string, data: string): Promise<void> => {
    const tmp = `${target}.${String(process.pid)}.${randomBytes(4).toString("hex")}${TMP_SUFFIX}`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, target);
  };

  const readMeta = async (path: string): Promise<StoredMeta | undefined> => {
    try {
      const meta = JSON.parse(await fs.readFile(path, "utf8")) as Partial<StoredMeta>;
      return typeof meta.treeRoot === "string" &&
        typeof meta.relativePath === "string" &&
        typeof meta.blobId === "string" &&
        typeof meta.lastReadAt === "number"
        ? (meta as StoredMeta)
        : undefined;
    } catch {
      return undefined;
    }
  };

  const sameKey = (meta: StoredMeta, key: WorkingTreeChunkStoreKey): boolean =>
    meta.treeRoot === key.treeRoot &&
    meta.relativePath === key.relativePath &&
    meta.contentSha256 === key.contentSha256 &&
    meta.chunkerFingerprint === key.chunkerFingerprint;

  const evict = async (dir: string, name: string): Promise<void> => {
    await fs.rm(join(dir, `${name}${META_SUFFIX}`), { force: true });
    await fs.rm(join(dir, `${name}${ROWS_SUFFIX}`), { force: true });
  };

  const sizeOf = async (path: string): Promise<number | undefined> => {
    try {
      return (await fs.stat(path)).size;
    } catch {
      return undefined;
    }
  };

  const listDir = async (dir: string): Promise<{ name: string; isDirectory: boolean }[]> => {
    try {
      return (await fs.readdir(dir, { withFileTypes: true })).map((d) => ({
        name: d.name,
        isDirectory: d.isDirectory(),
      }));
    } catch {
      return [];
    }
  };

  const treeExists = async (treeRoot: string): Promise<boolean> => {
    try {
      return (await fs.stat(treeRoot)).isDirectory();
    } catch {
      return false;
    }
  };

  return {
    async get(collectionName, key) {
      const dir = collectionDir(collectionName);
      if (!dir) return undefined;
      const name = entryKey(key);
      const meta = await readMeta(join(dir, `${name}${META_SUFFIX}`));
      if (!meta || !sameKey(meta, key)) return undefined;
      let rows: readonly ScrollChunk[];
      try {
        rows = JSON.parse(await fs.readFile(join(dir, `${name}${ROWS_SUFFIX}`), "utf8")) as ScrollChunk[];
      } catch {
        return undefined;
      }
      const bumped: StoredMeta = { ...meta, lastReadAt: now() };
      await writeAtomic(join(dir, `${name}${META_SUFFIX}`), JSON.stringify(bumped));
      return { ...bumped, rows };
    },

    async put(collectionName, entry) {
      const dir = collectionDir(collectionName);
      if (!dir) return;
      const { rows, ...key } = entry;
      const name = entryKey(key);
      await fs.mkdir(dir, { recursive: true });
      await writeAtomic(join(dir, `${name}${ROWS_SUFFIX}`), JSON.stringify(rows));
      const meta: StoredMeta = { ...key, lastReadAt: now() };
      await writeAtomic(join(dir, `${name}${META_SUFFIX}`), JSON.stringify(meta));
    },

    async sweep(at = now()) {
      let evicted = 0;
      const kept: { dir: string; name: string; bytes: number; lastReadAt: number }[] = [];
      const commitTimes = new Map<string, Promise<number | null>>();
      const commitTimeOf = async (meta: StoredMeta): Promise<number | null> => {
        const cacheKey = `${meta.treeRoot}\0${meta.relativePath}\0${meta.blobId}`;
        let time = commitTimes.get(cacheKey);
        if (!time) {
          // A tree git cannot read is treated as uncommitted; the byte cap still bounds it.
          time = readBlobCommitTime(meta.treeRoot, meta.relativePath, meta.blobId).catch(() => null);
          commitTimes.set(cacheKey, time);
        }
        return time;
      };

      for (const collection of await listDir(rootDir)) {
        if (!collection.isDirectory || !COLLECTION_NAME.test(collection.name)) continue;
        const dir = join(rootDir, collection.name);
        const files = await listDir(dir);
        const metaNames = new Set(
          files.filter((f) => f.name.endsWith(META_SUFFIX)).map((f) => f.name.slice(0, -META_SUFFIX.length)),
        );

        for (const file of files) {
          const abandoned =
            file.name.endsWith(TMP_SUFFIX) ||
            (file.name.endsWith(ROWS_SUFFIX) && !metaNames.has(file.name.slice(0, -ROWS_SUFFIX.length)));
          if (!abandoned) continue;
          const path = join(dir, file.name);
          const stat = await fs.stat(path).catch(() => undefined);
          if (stat && at - stat.mtimeMs >= ABANDONED_WRITE_GRACE_MS) await fs.rm(path, { force: true });
        }

        for (const name of metaNames) {
          const meta = await readMeta(join(dir, `${name}${META_SUFFIX}`));
          const rowsBytes = await sizeOf(join(dir, `${name}${ROWS_SUFFIX}`));
          const metaBytes = await sizeOf(join(dir, `${name}${META_SUFFIX}`));
          let expired = !meta || rowsBytes === undefined || metaBytes === undefined;
          if (meta && !expired) {
            if (!(await treeExists(meta.treeRoot))) expired = true;
            else {
              const committedAt = await commitTimeOf(meta);
              expired =
                committedAt !== null && at - Math.max(committedAt, meta.lastReadAt) >= WORKING_TREE_CHUNK_RETENTION_MS;
            }
          }
          if (expired || !meta) {
            await evict(dir, name);
            evicted++;
            continue;
          }
          kept.push({ dir, name, bytes: (rowsBytes ?? 0) + (metaBytes ?? 0), lastReadAt: meta.lastReadAt });
        }

        if ((await listDir(dir)).length === 0) await fs.rmdir(dir).catch(() => undefined);
      }

      let bytes = kept.reduce((sum, entry) => sum + entry.bytes, 0);
      kept.sort((a, b) => a.lastReadAt - b.lastReadAt);
      let survivors = kept.length;
      for (const entry of kept) {
        if (bytes <= capBytes) break;
        await evict(entry.dir, entry.name);
        bytes -= entry.bytes;
        evicted++;
        survivors--;
      }
      return { evicted, kept: survivors, bytes };
    },
  };
}
