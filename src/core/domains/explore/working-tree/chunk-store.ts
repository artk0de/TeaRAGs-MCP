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
 * Every write goes through a {@link WorkingTreeFileWriter} (a pid-named temp
 * renamed into place; a temp whose writer is gone is swept at once — see
 * `file-writer.ts`). `<key>.vectors.json` holds the
 * dense vectors of the entry's rows (WTO-5) and lives and dies with the entry;
 * `<key>.sparse.json`, optional, their BM25 vectors, written by `put` before
 * the meta, so a one-shot process that reads the rows vectorizes none of them.
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
 * What retention costs (bd tea-rags-mcp-xi2r9, live: a cold CLI call on a tree
 * with a delta spent ~11 s in 580 sequential `git log --find-object` spawns, one
 * per stored entry of every tree): every rule measures from `lastReadAt`, so an
 * entry read within the window is kept without a look at the disk or at git;
 * a removed tree and content the tree no longer holds are decided from the
 * filesystem; only an idle, current entry of a live tree asks git, at most
 * `commitLookupsPerSweep` per sweep, never-asked first, and a found commit
 * time is persisted in the meta so it is asked once. The schedule never sweeps
 * at start — the first sweep waits `WORKING_TREE_CHUNK_SWEEP_DELAY_MS` on an
 * unref'd timer, longer than a one-shot process lives — and `sweepIfDue`
 * skips when any process sweeping this root started one within the interval
 * (`.sweep-stamp.json` under the root). Reads and writes never sweep.
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

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import type { SparseVector } from "../../../adapters/qdrant/types.js";
import { readBlobCommitTime as gitReadBlobCommitTime } from "../../../adapters/vcs/git/git-cli/client.js";
import { fileContentHash } from "../../../infra/file-content-hash.js";
import type { ScrollChunk } from "../chunk-grouping/types.js";
import {
  createWorkingTreeFileWriter,
  reapAbandonedWorkingTreeTemps,
  type WorkingTreeFileWriter,
} from "./file-writer.js";

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
  /**
   * The rows' BM25 vectors (the sparse floor's), written with the entry so a
   * new process vectorizes nothing it reads from here. Optional: an entry
   * stored without them — or whose file is unreadable — still serves its rows.
   */
  sparseVectors?: WorkingTreeChunkSparseVectors;
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

/** BM25 vectors of an entry's rows, keyed by the sha256 of each row's `content`. */
export type WorkingTreeChunkSparseVectors = ReadonlyMap<string, SparseVector>;

export interface WorkingTreeChunkStore {
  /**
   * The entry, with `lastReadAt` bumped to now (durably) when the stored read is
   * at least {@link WORKING_TREE_CHUNK_READ_REFRESH_MS} old, else as stored;
   * undefined on a miss.
   */
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
  /** Apply retention now, unthrottled. An aborted `signal` stops it between entries, evicting nothing more. */
  sweep: (now?: number, options?: WorkingTreeChunkSweepOptions) => Promise<WorkingTreeChunkStoreSweep>;
  /**
   * `sweep`, unless a sweep of this root — by any process — started less than
   * `intervalMs` ago (a stamp under the root records it); undefined when skipped.
   */
  sweepIfDue: (
    now?: number,
    options?: WorkingTreeChunkSweepOptions & { intervalMs?: number },
  ) => Promise<WorkingTreeChunkStoreSweep | undefined>;
}

export interface WorkingTreeChunkSweepOptions {
  signal?: AbortSignal;
}

export interface WorkingTreeChunkStoreDeps {
  /** `<dataDir>/working-tree` */
  rootDir: string;
  readBlobCommitTime?: (root: string, relativePath: string, blobId: string) => Promise<number | null>;
  now?: () => number;
  capBytes?: number;
  /** The most git commit lookups one sweep makes; the rest wait for a later sweep. */
  commitLookupsPerSweep?: number;
  /**
   * Every file write goes through it; the composition root shares one across
   * the working-tree stores and closes it at cleanup, so an exit never cuts a
   * write between temp and rename. Defaults to a private one.
   */
  writer?: WorkingTreeFileWriter;
}

export interface WorkingTreeChunkSweepSchedule {
  /** Delay before the first sweep — longer than a one-shot process lives. */
  initialDelayMs?: number;
  intervalMs?: number;
}

export const WORKING_TREE_CHUNK_RETENTION_MS = 96 * 3_600_000;
/**
 * How old a stored `lastReadAt` must be before `get` rewrites it. A warm delta
 * is read on every request, and a meta rewrite per read was a writeFile + rename
 * per delta file per request. Retention compares `at - lastReadAt` against
 * {@link WORKING_TREE_CHUNK_RETENTION_MS} (96 h), so a stamp at most this stale
 * moves an eviction at most an hour earlier — never one of an entry read within
 * the last 95 h — and the cap's least-recently-read order is coarsened to an hour.
 */
export const WORKING_TREE_CHUNK_READ_REFRESH_MS = 3_600_000;
export const WORKING_TREE_CHUNK_STORE_CAP_BYTES = 512 * 1024 * 1024;
export const WORKING_TREE_CHUNK_SWEEP_INTERVAL_MS = 6 * 3_600_000;
export const WORKING_TREE_CHUNK_SWEEP_DELAY_MS = 2 * 60_000;
export const WORKING_TREE_CHUNK_COMMIT_LOOKUPS_PER_SWEEP = 32;
/** Commit lookups one sweep runs at once. */
const COMMIT_LOOKUP_CONCURRENCY = 4;
/** The throttle stamp: a dot-file in the root, never a collection directory. */
const SWEEP_STAMP_FILE = ".sweep-stamp.json";

/** A rows file with no meta, or a temp file, older than this is a dead write. */
const ABANDONED_WRITE_GRACE_MS = 3_600_000;
const META_SUFFIX = ".meta.json";
const ROWS_SUFFIX = ".rows.json";
/** Dense vectors beside the rows (WTO-5): same entry, same retention. */
const VECTORS_SUFFIX = ".vectors.json";
/** BM25 vectors of the rows: written by `put` with the rows, before the meta commits the entry. */
const SPARSE_SUFFIX = ".sparse.json";
/** Every file of an entry besides its meta: what an entry with no meta leaves behind. */
const ENTRY_BODY_SUFFIXES = [ROWS_SUFFIX, VECTORS_SUFFIX, SPARSE_SUFFIX];
/** A collection name is one path segment; anything else would address outside the root. */
const COLLECTION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The id git assigns the content as a blob: sha1 of `blob <length>\0<content>`. */
export function computeGitBlobId(content: Buffer): string {
  return createHash("sha1")
    .update(`blob ${String(content.length)}\0`)
    .update(content)
    .digest("hex");
}

/**
 * Sweeps (if due) once `initialDelayMs` has passed and every `intervalMs` after,
 * on timers that do not hold the process open — a one-shot process exits before
 * the first, so a request never waits on retention. Returns the stop, which also
 * aborts a sweep in flight.
 */
export function scheduleWorkingTreeChunkSweep(
  store: Pick<WorkingTreeChunkStore, "sweepIfDue">,
  schedule: WorkingTreeChunkSweepSchedule = {},
): () => void {
  const intervalMs = schedule.intervalMs ?? WORKING_TREE_CHUNK_SWEEP_INTERVAL_MS;
  const controller = new AbortController();
  const sweep = (): void => {
    if (controller.signal.aborted) return;
    void store.sweepIfDue(undefined, { signal: controller.signal, intervalMs }).catch(() => undefined);
  };
  let interval: ReturnType<typeof setInterval> | undefined;
  const first = setTimeout(() => {
    sweep();
    interval = setInterval(sweep, intervalMs);
    interval.unref?.();
  }, schedule.initialDelayMs ?? WORKING_TREE_CHUNK_SWEEP_DELAY_MS);
  first.unref?.();
  return () => {
    controller.abort();
    clearTimeout(first);
    clearInterval(interval);
  };
}

type StoredMeta = Omit<WorkingTreeChunkStoreEntry, "rows"> & {
  /** When git last answered the commit lookup; absent = never asked. */
  commitCheckedAt?: number;
  /** The content's commit time once git found it — persisted, never asked again. */
  committedAt?: number;
};

/** Runs `task` over `items`, at most `limit` at a time. */
async function forEachWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await task(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** One content of one tree path — what entries of different chunkers share. */
const contentKeyOf = (meta: StoredMeta): string =>
  JSON.stringify([meta.treeRoot, meta.relativePath, meta.contentSha256]);

export function createWorkingTreeChunkStore(deps: WorkingTreeChunkStoreDeps): WorkingTreeChunkStore {
  const { rootDir } = deps;
  const now = deps.now ?? Date.now;
  const capBytes = deps.capBytes ?? WORKING_TREE_CHUNK_STORE_CAP_BYTES;
  const readBlobCommitTime = deps.readBlobCommitTime ?? gitReadBlobCommitTime;
  const commitLookupsPerSweep = deps.commitLookupsPerSweep ?? WORKING_TREE_CHUNK_COMMIT_LOOKUPS_PER_SWEEP;
  const stampPath = join(rootDir, SWEEP_STAMP_FILE);

  const collectionDir = (collectionName: string): string | undefined =>
    COLLECTION_NAME.test(collectionName) ? join(rootDir, collectionName) : undefined;

  const entryKey = (key: WorkingTreeChunkStoreKey): string =>
    createHash("sha256")
      .update(JSON.stringify([key.treeRoot, key.relativePath, key.contentSha256, key.chunkerFingerprint]))
      .digest("hex");

  const writer = deps.writer ?? createWorkingTreeFileWriter();
  const writeAtomic = async (target: string, data: string): Promise<void> => writer.write(target, data);

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
    await fs.rm(join(dir, `${name}${SPARSE_SUFFIX}`), { force: true });
  };

  /** The stored BM25 vectors; undefined when absent or unreadable — the rows still serve. */
  const readSparseVectors = async (path: string): Promise<WorkingTreeChunkSparseVectors | undefined> => {
    try {
      const stored = JSON.parse(await fs.readFile(path, "utf8")) as { vectors?: unknown };
      if (!stored.vectors || typeof stored.vectors !== "object") return undefined;
      const vectors = Object.entries(stored.vectors as Record<string, Partial<SparseVector>>);
      const wellFormed = vectors.every(
        ([, vector]) =>
          Array.isArray(vector.indices) &&
          Array.isArray(vector.values) &&
          vector.indices.length === vector.values.length,
      );
      return wellFormed ? new Map(vectors as [string, SparseVector][]) : undefined;
    } catch {
      return undefined;
    }
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

  /** When a sweep of this root last started, by any process; undefined when never (or unreadable). */
  const readSweepStamp = async (): Promise<number | undefined> => {
    try {
      const stamp = JSON.parse(await fs.readFile(stampPath, "utf8")) as { sweptAt?: unknown };
      return typeof stamp.sweptAt === "number" ? stamp.sweptAt : undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * Persist what a commit lookup answered onto the entry's CURRENT meta (a read
   * may have bumped it meanwhile): a found commit time is never asked again, an
   * uncommitted answer only moves the entry to the back of the next sweep's queue.
   */
  const recordCommitLookup = async (
    dir: string,
    name: string,
    looked: StoredMeta,
    committedAt: number | null,
    at: number,
  ): Promise<void> => {
    const path = join(dir, `${name}${META_SUFFIX}`);
    const current = await readMeta(path);
    if (!current || !sameKey(current, looked)) return;
    const recorded: StoredMeta = {
      ...current,
      commitCheckedAt: at,
      ...(committedAt === null ? {} : { committedAt }),
    };
    await writeAtomic(path, JSON.stringify(recorded)).catch(() => undefined);
  };

  const store: WorkingTreeChunkStore = {
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
      const sparseVectors = await readSparseVectors(join(dir, `${name}${SPARSE_SUFFIX}`));
      const at = now();
      // Refreshed only once the stored read is stale: a steady-state read writes nothing.
      const bumped: StoredMeta =
        at - meta.lastReadAt >= WORKING_TREE_CHUNK_READ_REFRESH_MS ? { ...meta, lastReadAt: at } : meta;
      if (bumped !== meta) await writeAtomic(join(dir, `${name}${META_SUFFIX}`), JSON.stringify(bumped));
      const { treeRoot, relativePath, contentSha256, chunkerFingerprint, blobId, lastReadAt } = bumped;
      const entry = { treeRoot, relativePath, contentSha256, chunkerFingerprint, blobId, lastReadAt, rows };
      return sparseVectors ? { ...entry, sparseVectors } : entry;
    },

    async put(collectionName, entry) {
      const dir = collectionDir(collectionName);
      if (!dir) return;
      const { rows, sparseVectors, ...key } = entry;
      const name = entryKey(key);
      await fs.mkdir(dir, { recursive: true });
      await writeAtomic(join(dir, `${name}${ROWS_SUFFIX}`), JSON.stringify(rows));
      // The entry is what this put says: no vectors given → none left from an earlier put.
      const sparsePath = join(dir, `${name}${SPARSE_SUFFIX}`);
      if (sparseVectors) await writeAtomic(sparsePath, JSON.stringify({ vectors: Object.fromEntries(sparseVectors) }));
      else await fs.rm(sparsePath, { force: true });
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

    async sweep(at = now(), options = {}) {
      const { signal } = options;
      const aborted = (): boolean => signal?.aborted === true;
      let evicted = 0;
      const kept: { dir: string; name: string; bytes: number; lastReadAt: number }[] = [];
      /** Entries whose verdict needs git: idle, current, tree alive, commit time unknown. */
      const lookups: { dir: string; name: string; bytes: number; meta: StoredMeta }[] = [];
      const collectionDirs: string[] = [];
      const currentContents = new Map<string, Promise<string | null>>();
      /** sha256 of what the tree holds at the entry's path now; null when the path is gone. */
      const currentSha256Of = async (meta: StoredMeta): Promise<string | null> => {
        const path = join(meta.treeRoot, meta.relativePath);
        let sha = currentContents.get(path);
        if (!sha) {
          // The chunk layer's definition (`WorkingTreeContentHashes`): the text's hash.
          sha = fs.readFile(path, "utf8").then(fileContentHash, () => null);
          currentContents.set(path, sha);
        }
        return sha;
      };
      const committedExpired = (meta: StoredMeta, committedAt: number): boolean =>
        at - Math.max(committedAt, meta.lastReadAt) >= WORKING_TREE_CHUNK_RETENTION_MS;
      /**
       * Every rule that needs no git. A non-idle entry is kept outright: each rule
       * measures from `lastReadAt` (the commit rule from max(commit, lastReadAt)),
       * so none can fire before the entry sits unread the retention window.
       */
      const verdictOf = async (
        meta: StoredMeta,
        latestReadOfContent: ReadonlyMap<string, number>,
      ): Promise<"evict" | "keep" | "lookup"> => {
        if (!(await treeExists(meta.treeRoot))) return "evict";
        if (at - meta.lastReadAt < WORKING_TREE_CHUNK_RETENTION_MS) return "keep";
        // Another chunker's rows of this very content were read since: this build's are dead.
        if ((latestReadOfContent.get(contentKeyOf(meta)) ?? 0) > meta.lastReadAt) return "evict";
        if ((await currentSha256Of(meta)) !== meta.contentSha256) return "evict";
        if (meta.committedAt !== undefined) return committedExpired(meta, meta.committedAt) ? "evict" : "keep";
        return "lookup";
      };

      // The throttle stamp's own temps: the root is shared, so only this store's stamp.
      await reapAbandonedWorkingTreeTemps(rootDir, {
        at,
        graceMs: ABANDONED_WRITE_GRACE_MS,
        prefix: SWEEP_STAMP_FILE,
      });
      for (const collection of await listDir(rootDir)) {
        if (aborted()) break;
        if (!collection.isDirectory || !COLLECTION_NAME.test(collection.name)) continue;
        const dir = join(rootDir, collection.name);
        collectionDirs.push(dir);
        const files = await listDir(dir);
        const metaNames = new Set(
          files.filter((f) => f.name.endsWith(META_SUFFIX)).map((f) => f.name.slice(0, -META_SUFFIX.length)),
        );

        // A temp goes once its writer is gone (named by pid), else after the grace.
        await reapAbandonedWorkingTreeTemps(dir, { at, graceMs: ABANDONED_WRITE_GRACE_MS });
        for (const file of files) {
          const abandoned = ENTRY_BODY_SUFFIXES.some(
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
          if (aborted()) break;
          const rowsBytes = await sizeOf(join(dir, `${name}${ROWS_SUFFIX}`));
          const metaBytes = await sizeOf(join(dir, `${name}${META_SUFFIX}`));
          const vectorsBytes = (await sizeOf(join(dir, `${name}${VECTORS_SUFFIX}`))) ?? 0;
          const sparseBytes = (await sizeOf(join(dir, `${name}${SPARSE_SUFFIX}`))) ?? 0;
          const verdict =
            !meta || rowsBytes === undefined || metaBytes === undefined
              ? "evict"
              : await verdictOf(meta, latestReadOfContent);
          const bytes = (rowsBytes ?? 0) + (metaBytes ?? 0) + vectorsBytes + sparseBytes;
          if (verdict === "evict" || !meta) {
            await evict(dir, name);
            evicted++;
          } else if (verdict === "lookup") {
            lookups.push({ dir, name, bytes, meta });
          } else {
            kept.push({ dir, name, bytes, lastReadAt: meta.lastReadAt });
          }
        }
      }

      // Git lookups, bounded: never-asked entries first, then the longest since
      // asked, so repeated sweeps rotate through what is still uncommitted. One
      // beyond the cap — or any once aborted — is kept for a later sweep.
      lookups.sort(
        (a, b) =>
          (a.meta.commitCheckedAt ?? 0) - (b.meta.commitCheckedAt ?? 0) || a.meta.lastReadAt - b.meta.lastReadAt,
      );
      for (const { dir, name, bytes, meta } of lookups.slice(commitLookupsPerSweep)) {
        kept.push({ dir, name, bytes, lastReadAt: meta.lastReadAt });
      }
      await forEachWithConcurrency(
        lookups.slice(0, commitLookupsPerSweep),
        COMMIT_LOOKUP_CONCURRENCY,
        async (entry) => {
          const { dir, name, bytes, meta } = entry;
          if (!aborted()) {
            // A tree git cannot read is treated as uncommitted; the byte cap still bounds it.
            const committedAt = await readBlobCommitTime(meta.treeRoot, meta.relativePath, meta.blobId).catch(
              () => null,
            );
            if (committedAt !== null && committedExpired(meta, committedAt)) {
              await evict(dir, name);
              evicted++;
              return;
            }
            await recordCommitLookup(dir, name, meta, committedAt, at);
          }
          kept.push({ dir, name, bytes, lastReadAt: meta.lastReadAt });
        },
      );

      if (aborted()) {
        return { evicted, kept: kept.length, bytes: kept.reduce((sum, entry) => sum + entry.bytes, 0) };
      }
      for (const dir of collectionDirs) {
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

    async sweepIfDue(at = now(), options = {}) {
      const intervalMs = options.intervalMs ?? WORKING_TREE_CHUNK_SWEEP_INTERVAL_MS;
      // No root, nothing stored: nothing to sweep, and no root is created for a stamp.
      if (!(await treeExists(rootDir))) return undefined;
      const sweptAt = await readSweepStamp();
      if (sweptAt !== undefined && sweptAt <= at && at - sweptAt < intervalMs) return undefined;
      // Stamped at the START, so a concurrent process skips instead of sweeping alongside.
      await writeAtomic(stampPath, JSON.stringify({ sweptAt: at }));
      return store.sweep(at, options);
    },
  };
  return store;
}
