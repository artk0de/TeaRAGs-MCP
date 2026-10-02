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
 * Pool lifecycle: built on the first call that has a file to chunk (a cache
 * hit chunks nothing), replaced when the chunker config changes, shut down
 * once no call has been in flight for `idleShutdownMs`, and by `dispose`.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ChunkerConfig } from "../../../types.js";
import type { ScrollChunk } from "../chunk-grouping/types.js";

/** What one `chunk` call read from the tree. */
export interface WorkingTreeChunkLayerRead {
  /** Rows of every file that chunked, in request order. */
  chunks: readonly ScrollChunk[];
  /** Requested files that could not be read or parsed — they have no rows. */
  unparsed: readonly string[];
}

export interface WorkingTreeChunkLayer {
  /** Rows for the given tree files, exactly as ingest would store them (minus git/codegraph payload). */
  chunk: (tree: string, relativePaths: readonly string[], config: ChunkerConfig) => Promise<WorkingTreeChunkLayerRead>;
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
}

const DEFAULT_IDLE_SHUTDOWN_MS = 60_000;
/**
 * Files kept in the in-memory content cache, oldest evicted first. A delta is
 * capped at 200 files (`WORKING_TREE_DELTA_FILE_CAP`), so this holds the
 * edit history of several trees without growing with the server's uptime.
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
    async chunk(tree, relativePaths, config) {
      if (relativePaths.length === 0) return { chunks: [], unparsed: [] };
      clearTimeout(idleTimer);
      idleTimer = undefined;
      inFlight++;
      try {
        const configKey = JSON.stringify(config);
        const chunks: ScrollChunk[] = [];
        const unparsed: string[] = [];
        for (const relativePath of relativePaths) {
          try {
            const code = await readFile(join(tree, relativePath), "utf8");
            const contentHash = createHash("sha256").update(code).digest("hex");
            const key = `${configKey}\0${tree}\0${relativePath}\0${contentHash}`;
            let rows = cache.get(key);
            if (!rows) {
              rows = await deps.chunkFile(await poolFor(config, configKey), { root: tree, relativePath, code });
              remember(key, rows);
            }
            chunks.push(...rows);
          } catch {
            unparsed.push(relativePath);
          }
        }
        return { chunks, unparsed };
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
