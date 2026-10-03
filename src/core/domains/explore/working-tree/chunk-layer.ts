/**
 * WorkingTreeChunkLayer (bd tea-rags-mcp-xi2r9.3) — the delta files of a
 * working tree as the point rows ingest would store for them: the production
 * chunker, ingest's chunk ids, ingest's chunk payload. Nothing is written
 * anywhere; git and codegraph payload are absent, not copied from the base.
 *
 * Explore may not import ingest, so the layer owns only what is ITS concern —
 * reading the tree, the content cache, the pool's lifecycle — and receives the
 * two ingest-owned pieces by injection: `createPool` (a `ChunkerPool`, whose
 * worker is forked from the compiled build) and `chunkFile` (ingest's
 * `buildFileChunkPoints`). `src/bootstrap/factory.ts` wires both.
 *
 * Behind the memory cache sits an optional {@link WorkingTreeChunkStore}: a
 * memory miss for a call that names its collection reads the store before
 * chunking, and a fresh chunk is written to it, so a restarted process does not
 * re-chunk a tree it has seen. The store is a cache — its failures are misses.
 *
 * A call chunks its files concurrently, at most `concurrency` at a time, and
 * answers in request order. The memory cache is bounded by the bytes of the
 * rows it holds, not by a file count — a delta has no file cap — and each call
 * is one pass of a {@link WorkingTreePassRowCache}, so a delta whose rows exceed
 * the bound still serves a stable share from memory on every request.
 *
 * A warm delta is asked on every request, so an unchanged file costs one
 * `stat`: its content hash comes from {@link WorkingTreeContentHashes}, and its
 * bytes are read only when it must be chunked or stored.
 *
 * Pool lifecycle: built on the first call that has a file to chunk (a cache
 * hit chunks nothing), replaced when the chunker config changes, shut down
 * once no call has been in flight for `idleShutdownMs`, and by `dispose`.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";

import type { ChunkerConfig } from "../../../types.js";
import type { ScrollChunk } from "../chunk-grouping/types.js";
import { computeGitBlobId, type WorkingTreeChunkStore, type WorkingTreeChunkStoreKey } from "./chunk-store.js";
import { WorkingTreeContentHashes, type WorkingTreeFileContent } from "./content-hashes.js";
import { WORKING_TREE_ROW_CACHE_MAX_BYTES, WorkingTreePassRowCache, workingTreeRowBytes } from "./row-cache.js";
import { computeWorkingTreeSparseVectors, rememberWorkingTreeSparseVectors } from "./sparse-floor.js";

/** What one `chunk` call read from the tree. */
export interface WorkingTreeChunkLayerRead {
  /** Rows of every file that chunked, in request order. */
  chunks: readonly ScrollChunk[];
  /** Requested files that could not be read or parsed — they have no rows. */
  unparsed: readonly string[];
  /**
   * The persistent-store entry each chunked file's rows live under, by path —
   * where the dense floor keeps their vectors (WTO-5). Present when the call
   * named its collection; a memory hit names the same entry a chunk did.
   */
  storeKeys?: ReadonlyMap<string, WorkingTreeChunkStoreKey>;
  /**
   * `chunks` split per file: the rows of each chunked file, by path, in request
   * order. An unparsed file has no entry. Absent only on an empty request.
   */
  rowsByPath?: ReadonlyMap<string, readonly ScrollChunk[]>;
}

export interface WorkingTreeChunkLayer {
  /**
   * Rows for the given tree files, exactly as ingest would store them (minus
   * git/codegraph payload). `collectionName` — the base index — selects the
   * persistent store's namespace; without it only the memory cache is used.
   */
  chunk: (
    tree: string,
    relativePaths: readonly string[],
    config: ChunkerConfig,
    collectionName?: string,
  ) => Promise<WorkingTreeChunkLayerRead>;
  dispose: () => Promise<void>;
}

/** The part of a chunker pool the layer drives itself: releasing it. */
export interface WorkingTreeChunkerPool {
  shutdown: () => Promise<void>;
}

/** One file of a tree, handed to the injected chunker. */
export interface WorkingTreeSourceFile {
  root: string;
  relativePath: string;
  code: string;
}

export interface WorkingTreeChunkLayerDeps<P extends WorkingTreeChunkerPool> {
  createPool: (config: ChunkerConfig) => P;
  /** Ingest's file → point rows; rejects when the file cannot be parsed. */
  chunkFile: (pool: P, file: WorkingTreeSourceFile) => Promise<readonly ScrollChunk[]>;
  idleShutdownMs?: number;
  /** Persistent cache behind the memory cache. */
  store?: WorkingTreeChunkStore;
  /** Identifies the chunker build (package version): a new build must not read an old build's rows. */
  chunkerBuildId?: string;
  /**
   * Files of one call chunked at a time — the composition root passes the
   * chunker pool's size. Default {@link WORKING_TREE_CHUNK_CONCURRENCY}.
   */
  concurrency?: number;
  /** Bound of the memory cache, in bytes of row content. Default {@link WORKING_TREE_ROW_CACHE_MAX_BYTES}. */
  maxCacheBytes?: number;
  /** Where tree files are read and hashed. Default: a private {@link WorkingTreeContentHashes}. */
  contentHashes?: WorkingTreeContentHashes;
}

/** Files one `chunk` call chunks at a time when the composition root names no pool size. */
export const WORKING_TREE_CHUNK_CONCURRENCY = 4;
const DEFAULT_IDLE_SHUTDOWN_MS = 60_000;
/**
 * Version of the row shape the injected `chunkFile` produces, folded into the
 * store's chunker fingerprint so a stored row of an older shape is a miss, not
 * a hit. The package version alone does not move between dev builds of one
 * release, and a stored row outlives the process that wrote it.
 *
 * 2 — row ids are stored point ids (`toQdrantPointId`), no longer
 *     `chunk_<hex>` (bd tea-rags-mcp-xi2r9, live probe P1-2).
 */
const WORKING_TREE_ROW_FORMAT = 2;

/** One chunked file of a call. */
interface WorkingTreeChunkedFile {
  rows: readonly ScrollChunk[];
  storeKey: WorkingTreeChunkStoreKey;
}

export function createWorkingTreeChunkLayer<P extends WorkingTreeChunkerPool>(
  deps: WorkingTreeChunkLayerDeps<P>,
): WorkingTreeChunkLayer {
  const idleShutdownMs = deps.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
  const concurrency = Math.max(1, deps.concurrency ?? WORKING_TREE_CHUNK_CONCURRENCY);
  const cache = new WorkingTreePassRowCache<readonly ScrollChunk[]>(
    deps.maxCacheBytes ?? WORKING_TREE_ROW_CACHE_MAX_BYTES,
  );
  const contentHashes = deps.contentHashes ?? new WorkingTreeContentHashes();
  let live: { pool: P; configKey: string } | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = 0;

  const release = async (): Promise<void> => {
    const current = live;
    live = undefined;
    await current?.pool.shutdown();
  };

  const poolFor = async (config: ChunkerConfig, configKey: string): Promise<P> => {
    if (live && live.configKey !== configKey) await release();
    live ??= { pool: deps.createPool(config), configKey };
    return live.pool;
  };

  const armIdleShutdown = (): void => {
    if (inFlight > 0 || !live) return;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      void release();
    }, idleShutdownMs);
    idleTimer.unref?.();
  };

  /**
   * One file's rows: memory → store → chunker. The content hash comes from the
   * stamp memo; the bytes are read only to chunk or store them. Rejects when the
   * file cannot be read or parsed.
   */
  const chunkOne = async (
    tree: string,
    relativePath: string,
    config: ChunkerConfig,
    configKey: string,
    chunkerFingerprint: string,
    collectionName: string | undefined,
    pass: number,
  ): Promise<WorkingTreeChunkedFile> => {
    const path = join(tree, relativePath);
    const readContent = async (): Promise<WorkingTreeFileContent> => {
      const read = await contentHashes.readContent(path);
      if (!read) throw new Error(`unreadable tree file: ${relativePath}`);
      return read;
    };
    // An unchanged file is answered from the stamp memo; a moved one is read here, once.
    let content: WorkingTreeFileContent | undefined;
    let known = await contentHashes.memoizedSha256Of(path);
    if (known === undefined) {
      content = await readContent();
      known = content.sha256;
    }
    const memoized = known;
    const keyOf = (contentSha256: string): string => `${configKey}\0${tree}\0${relativePath}\0${contentSha256}`;
    const storeKeyOf = (contentSha256: string): WorkingTreeChunkStoreKey => ({
      treeRoot: tree,
      relativePath,
      contentSha256,
      chunkerFingerprint,
    });
    const cached = cache.get(keyOf(memoized), pass);
    if (cached) return { rows: cached, storeKey: storeKeyOf(memoized) };
    const { store } = deps;
    const stored =
      store && collectionName !== undefined
        ? await store.get(collectionName, storeKeyOf(memoized)).catch(() => undefined)
        : undefined;
    if (stored?.sparseVectors) rememberWorkingTreeSparseVectors(stored.sparseVectors);
    // The rows and the content hash they belong to: a chunk follows the bytes it
    // read, which may be newer than the memoized stamp.
    let rows = stored?.rows;
    let rowsSha256 = memoized;
    if (!rows) {
      content ??= await readContent();
      rowsSha256 = content.sha256;
      rows = await deps.chunkFile(await poolFor(config, configKey), {
        root: tree,
        relativePath,
        code: content.content.toString("utf8"),
      });
    }
    // A fresh chunk, or an entry an earlier build stored without BM25 vectors.
    if (store && collectionName !== undefined && !stored?.sparseVectors) {
      content ??= await readContent();
      // Stored rows are re-filed only under the bytes they were chunked from.
      if (content.sha256 === rowsSha256) {
        const blobId = computeGitBlobId(content.content);
        const sparseVectors = computeWorkingTreeSparseVectors(rows);
        await store
          .put(collectionName, { ...storeKeyOf(rowsSha256), blobId, rows, sparseVectors })
          .catch(() => undefined);
      }
    }
    cache.set(keyOf(rowsSha256), rows, workingTreeRowBytes(rows), pass);
    return { rows, storeKey: storeKeyOf(rowsSha256) };
  };

  return {
    async chunk(tree, relativePaths, config, collectionName) {
      if (relativePaths.length === 0) return { chunks: [], unparsed: [] };
      clearTimeout(idleTimer);
      idleTimer = undefined;
      inFlight++;
      const pass = cache.beginPass();
      try {
        const configKey = JSON.stringify(config);
        const chunkerFingerprint = createHash("sha256")
          .update(`${deps.chunkerBuildId ?? ""}\0${configKey}\0rows-v${String(WORKING_TREE_ROW_FORMAT)}`)
          .digest("hex");
        // Settled per request index, so the answer keeps request order however the files finish.
        const settled: (WorkingTreeChunkedFile | undefined)[] = [];
        let next = 0;
        const worker = async (): Promise<void> => {
          while (next < relativePaths.length) {
            const index = next++;
            settled[index] = await chunkOne(
              tree,
              relativePaths[index],
              config,
              configKey,
              chunkerFingerprint,
              collectionName,
              pass,
            ).catch(() => undefined);
          }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, relativePaths.length) }, worker));

        const chunks: ScrollChunk[] = [];
        const unparsed: string[] = [];
        const storeKeys = new Map<string, WorkingTreeChunkStoreKey>();
        const rowsByPath = new Map<string, readonly ScrollChunk[]>();
        relativePaths.forEach((relativePath, index) => {
          const file = settled[index];
          if (!file) {
            unparsed.push(relativePath);
            return;
          }
          chunks.push(...file.rows);
          rowsByPath.set(relativePath, file.rows);
          if (collectionName !== undefined) storeKeys.set(relativePath, file.storeKey);
        });
        return collectionName === undefined
          ? { chunks, unparsed, rowsByPath }
          : { chunks, unparsed, storeKeys, rowsByPath };
      } finally {
        cache.endPass(pass);
        inFlight--;
        armIdleShutdown();
      }
    },

    async dispose() {
      clearTimeout(idleTimer);
      idleTimer = undefined;
      cache.clear();
      await release();
    },
  };
}
