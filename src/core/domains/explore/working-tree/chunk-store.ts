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
 * Every write is a temp file renamed into place. `<key>.vectors.json` holds the
 * dense vectors of the entry's rows (WTO-5) and lives and dies with the entry.
 *
 * Retention (`sweep`): a tree root that no longer exists → evict now; content
 * the tree no longer holds at that path (the path is gone, or holds other
 * bytes) and unread `WORKING_TREE_CHUNK_RETENTION_MS` → evict; rows of a
 * content another chunker build (or config) stored and read since, this entry
 * unread `WORKING_TREE_CHUNK_RETENTION_MS` → evict; content
 * committed (its blob appears in the tree's history for that path) and idle
 * `WORKING_TREE_CHUNK_RETENTION_MS` since max(commit time, last read) → evict;
 * current uncommitted content of a live tree → keep; then least-recently-read
 * entries go until the store fits its byte cap. Nothing outside `rootDir` is
 * touched.
 *
 * Why the superseded rule exists (bd tea-rags-mcp-xi2r9, live probe): every
 * save of a file under edit writes a new entry, and a draft that was never
 * committed — or a deleted path — never shows up in `git log --find-object`,
 * so the commit rule alone kept such entries for the life of the tree (47
 * entries for 4 live files on one probe tree). The overlay only ever asks for
 * a path's CURRENT content, so an entry that is not current can serve a read
 * again only if the file returns to those exact bytes; the 96 h of read-idle
 * grace covers an undo or a branch switch-and-back without keeping drafts
 * forever. It is checked first: one file hash per path spares the git spawn
 * for every superseded draft. The same holds across chunker builds: a new
 * build (or a row-format bump) writes its own entry for unchanged content and
 * never reads the old one again, so the old one is dead once it sits unread
 * the retention window while a sibling was read after it — two builds serving
 * at once both stay read, and both stay.
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

/** Dense vectors of an entry's rows, keyed by the sha256 of each row's `content`. */
export type WorkingTreeChunkVectors = ReadonlyMap<string, number[]>;

export interface WorkingTreeChunkStore {
  /** The entry, with `lastReadAt` bumped to now (durably); undefined on a miss. */
  get: (collectionName: string, key: WorkingTreeChunkStoreKey) => Promise<WorkingTreeChunkStoreEntry | undefined>;
  put: (collectionName: string, entry: Omit<WorkingTreeChunkStoreEntry, "lastReadAt">) => Promise<void>;
  /**
   * The dense vectors stored beside an entry's rows by `model` (WTO-5);
   * undefined when the entry holds none of that model, or no entry exists.
   */
  getVectors: (
    collectionName: string,
    key: WorkingTreeChunkStoreKey,
    model: string,
  ) => Promise<WorkingTreeChunkVectors | undefined>;
  /**
   * Merge `vectors` into the entry's vectors of `model`; another model's are
   * replaced, never mixed. A no-op for an entry the store does not hold, so a
   * vector never outlives the rows it belongs to.
   */
  putVectors: (
    collectionName: string,
    key: WorkingTreeChunkStoreKey,
    model: string,
    vectors: WorkingTreeChunkVectors,
  ) => Promise<void>;
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
/** Dense vectors beside the rows (WTO-5): same entry, same retention. */
const VECTORS_SUFFIX = ".vectors.json";
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

/** One content of one tree path — what entries of different chunkers share. */
const contentKeyOf = (meta: StoredMeta): string =>
  JSON.stringify([meta.treeRoot, meta.relativePath, meta.contentSha256]);

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
    await fs.rm(join(dir, `${name}${VECTORS_SUFFIX}`), { force: true });
  };

  /** The entry's stored vectors file, when its meta names this very key. */
  const vectorsPathOf = async (collectionName: string, key: WorkingTreeChunkStoreKey): Promise<string | undefined> => {
    const dir = collectionDir(collectionName);
    if (!dir) return undefined;
    const name = entryKey(key);
    const meta = await readMeta(join(dir, `${name}${META_SUFFIX}`));
    return meta && sameKey(meta, key) ? join(dir, `${name}${VECTORS_SUFFIX}`) : undefined;
  };

  const readVectors = async (
    path: string,
  ): Promise<{ model: string; vectors: Record<string, number[]> } | undefined> => {
    try {
      const stored = JSON.parse(await fs.readFile(path, "utf8")) as { model?: unknown; vectors?: unknown };
      return typeof stored.model === "string" && stored.vectors && typeof stored.vectors === "object"
        ? { model: stored.model, vectors: stored.vectors as Record<string, number[]> }
        : undefined;
    } catch {
      return undefined;
    }
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

    async getVectors(collectionName, key, model) {
      const path = await vectorsPathOf(collectionName, key);
      const stored = path ? await readVectors(path) : undefined;
      if (stored?.model !== model) return undefined;
      return new Map(Object.entries(stored.vectors));
    },

    async putVectors(collectionName, key, model, vectors) {
      if (vectors.size === 0) return;
      const path = await vectorsPathOf(collectionName, key);
      if (!path) return;
      const stored = await readVectors(path);
      const merged = { ...(stored?.model === model ? stored.vectors : {}), ...Object.fromEntries(vectors) };
      await writeAtomic(path, JSON.stringify({ model, vectors: merged }));
    },

    async sweep(at = now()) {
      let evicted = 0;
      const kept: { dir: string; name: string; bytes: number; lastReadAt: number }[] = [];
      const commitTimes = new Map<string, Promise<number | null>>();
      const currentContents = new Map<string, Promise<string | null>>();
      /** sha256 of what the tree holds at the entry's path now; null when the path is gone. */
      const currentSha256Of = async (meta: StoredMeta): Promise<string | null> => {
        const path = join(meta.treeRoot, meta.relativePath);
        let sha = currentContents.get(path);
        if (!sha) {
          sha = fs.readFile(path).then(
            (content) => createHash("sha256").update(content).digest("hex"),
            () => null,
          );
          currentContents.set(path, sha);
        }
        return sha;
      };
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
            [ROWS_SUFFIX, VECTORS_SUFFIX].some(
              (suffix) => file.name.endsWith(suffix) && !metaNames.has(file.name.slice(0, -suffix.length)),
            );
          if (!abandoned) continue;
          const path = join(dir, file.name);
          const stat = await fs.stat(path).catch(() => undefined);
          if (stat && at - stat.mtimeMs >= ABANDONED_WRITE_GRACE_MS) await fs.rm(path, { force: true });
        }

        const entries: { name: string; meta: StoredMeta | undefined }[] = [];
        for (const name of metaNames) entries.push({ name, meta: await readMeta(join(dir, `${name}${META_SUFFIX}`)) });
        // The latest read of each content, over every chunker that stored it.
        const latestReadOfContent = new Map<string, number>();
        for (const { meta } of entries) {
          if (!meta) continue;
          const content = contentKeyOf(meta);
          latestReadOfContent.set(content, Math.max(latestReadOfContent.get(content) ?? 0, meta.lastReadAt));
        }

        for (const { name, meta } of entries) {
          const rowsBytes = await sizeOf(join(dir, `${name}${ROWS_SUFFIX}`));
          const metaBytes = await sizeOf(join(dir, `${name}${META_SUFFIX}`));
          const vectorsBytes = (await sizeOf(join(dir, `${name}${VECTORS_SUFFIX}`))) ?? 0;
          let expired = !meta || rowsBytes === undefined || metaBytes === undefined;
          if (meta && !expired) {
            const idle = at - meta.lastReadAt >= WORKING_TREE_CHUNK_RETENTION_MS;
            if (!(await treeExists(meta.treeRoot))) expired = true;
            else if (idle && (latestReadOfContent.get(contentKeyOf(meta)) ?? 0) > meta.lastReadAt) {
              // Another chunker's rows of this very content were read since: this build's are dead.
              expired = true;
            } else if ((await currentSha256Of(meta)) !== meta.contentSha256) {
              expired = idle;
            } else {
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
          kept.push({
            dir,
            name,
            bytes: (rowsBytes ?? 0) + (metaBytes ?? 0) + vectorsBytes,
            lastReadAt: meta.lastReadAt,
          });
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
