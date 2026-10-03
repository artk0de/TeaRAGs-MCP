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
 * Pool lifecycle: built on the first call that has a file to chunk (a cache
 * hit chunks nothing), replaced when the chunker config changes, shut down
 * once no call has been in flight for `idleShutdownMs`, and by `dispose`.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ChunkerConfig } from "../../../types.js";
import type { ScrollChunk } from "../chunk-grouping/types.js";
import { computeGitBlobId, type WorkingTreeChunkStore, type WorkingTreeChunkStoreKey } from "./chunk-store.js";

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
}

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
/**
 * Files kept in the in-memory content cache, oldest evicted first, so the
 * cache never grows with the server's uptime. A delta has no file cap: one
 * past this bound evicts its own earliest files, which are re-read (and served
 * from the chunk store) on the next request.
 */
const CONTENT_CACHE_MAX_FILES = 2_000;

export function createWorkingTreeChunkLayer<P extends WorkingTreeChunkerPool>(
  deps: WorkingTreeChunkLayerDeps<P>,
): WorkingTreeChunkLayer {
  const idleShutdownMs = deps.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
  const cache = new Map<string, readonly ScrollChunk[]>();
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

  const remember = (key: string, rows: readonly ScrollChunk[]): void => {
    if (cache.size >= CONTENT_CACHE_MAX_FILES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, rows);
  };

  const armIdleShutdown = (): void => {
    if (inFlight > 0 || !live) return;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      void release();
    }, idleShutdownMs);
    idleTimer.unref?.();
  };

  return {
    async chunk(tree, relativePaths, config, collectionName) {
      if (relativePaths.length === 0) return { chunks: [], unparsed: [] };
      clearTimeout(idleTimer);
      idleTimer = undefined;
      inFlight++;
      try {
        const configKey = JSON.stringify(config);
        const chunkerFingerprint = createHash("sha256")
          .update(`${deps.chunkerBuildId ?? ""}\0${configKey}\0rows-v${String(WORKING_TREE_ROW_FORMAT)}`)
          .digest("hex");
        const chunks: ScrollChunk[] = [];
        const unparsed: string[] = [];
        const storeKeys = new Map<string, WorkingTreeChunkStoreKey>();
        for (const relativePath of relativePaths) {
          try {
            const content = await readFile(join(tree, relativePath));
            const contentSha256 = createHash("sha256").update(content).digest("hex");
            const key = `${configKey}\0${tree}\0${relativePath}\0${contentSha256}`;
            const storeKey = { treeRoot: tree, relativePath, contentSha256, chunkerFingerprint };
            let rows = cache.get(key);
            if (!rows) {
              const { store } = deps;
              const stored =
                store && collectionName !== undefined
                  ? await store.get(collectionName, storeKey).catch(() => undefined)
                  : undefined;
              rows = stored?.rows;
              if (!rows) {
                const code = content.toString("utf8");
                rows = await deps.chunkFile(await poolFor(config, configKey), { root: tree, relativePath, code });
                if (store && collectionName !== undefined) {
                  await store
                    .put(collectionName, { ...storeKey, blobId: computeGitBlobId(content), rows })
                    .catch(() => undefined);
                }
              }
              remember(key, rows);
            }
            chunks.push(...rows);
            if (collectionName !== undefined) storeKeys.set(relativePath, storeKey);
          } catch {
            unparsed.push(relativePath);
          }
        }
        return collectionName === undefined ? { chunks, unparsed } : { chunks, unparsed, storeKeys };
      } finally {
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
