/**
 * Warm chunker pools for ingest tests (bd tea-rags-mcp-bbo1h.1).
 *
 * Every index/reindex run builds a `ChunkerPool`, i.e. forks the compiled
 * chunker worker, and shuts it down at the end. A cold fork costs ~280ms inside
 * vitest against ~4ms for a warm dispatch, and the heavy ingest files run
 * hundreds of runs. `warmChunkerPoolFactory` is a `ChunkerPoolFactory` that
 * hands each run a lease on a pool cached for the lifetime of the test-file
 * process (vitest forks a fresh process per file, so the cache is per file).
 * The lease's `shutdown()` is a no-op; the cached pools are really shut down by
 * the `afterAll` this module registers in the importing file.
 *
 * What may be shared is decided by what the worker keeps between requests. The
 * worker's chunker engine is built once per process from the init config, and
 * only `chunkSize` / `chunkOverlap` / `maxChunkSize` (plus the constant language
 * module path) shape chunking — so chunk-only requests go to a pool keyed by
 * those. `gemfileContent` and `projectRoot` gate the cross-pass codegraph
 * extraction only, and the worker turns `projectRoot` into a SNAPSHOT of the
 * project's dependency manifests at init. Sharing that across runs would leak
 * one run's manifest snapshot into the next, so a request that asks for an
 * extraction goes to a per-lease pool built with the run's full config and shut
 * down with the lease — exactly the production lifecycle.
 */

import { afterAll } from "vitest";

import {
  ChunkerPool,
  type ChunkerPoolFactory,
  type ChunkerPoolPort,
  type FileChunkResult,
} from "../../../../../src/core/domains/ingest/pipeline/chunker/infra/pool.js";
import type { ChunkerConfig } from "../../../../../src/core/types.js";

const warmChunkOnlyPools = new Map<string, ChunkerPool>();

function chunkOnlyPoolKey(poolSize: number, config: ChunkerConfig): string {
  const { gemfileContent: _gemfileContent, projectRoot: _projectRoot, ...chunkingConfig } = config;
  return JSON.stringify({ poolSize, chunkingConfig });
}

function warmChunkOnlyPool(poolSize: number, config: ChunkerConfig): ChunkerPool {
  const key = chunkOnlyPoolKey(poolSize, config);
  let pool = warmChunkOnlyPools.get(key);
  if (!pool) {
    const { gemfileContent: _gemfileContent, projectRoot: _projectRoot, ...chunkingConfig } = config;
    pool = new ChunkerPool(poolSize, chunkingConfig);
    warmChunkOnlyPools.set(key, pool);
  }
  return pool;
}

class WarmChunkerPoolLease implements ChunkerPoolPort {
  private extractionPool: ChunkerPool | undefined;

  constructor(
    private readonly poolSize: number,
    private readonly config: ChunkerConfig,
  ) {}

  async processFile(
    filePath: string,
    code: string,
    language: string,
    emitExtraction = false,
  ): Promise<FileChunkResult> {
    if (emitExtraction) {
      this.extractionPool ??= new ChunkerPool(this.poolSize, this.config);
      return this.extractionPool.processFile(filePath, code, language, true);
    }
    return warmChunkOnlyPool(this.poolSize, this.config).processFile(filePath, code, language, false);
  }

  async shutdown(): Promise<void> {
    const pool = this.extractionPool;
    this.extractionPool = undefined;
    await pool?.shutdown();
  }
}

export const warmChunkerPoolFactory: ChunkerPoolFactory = (poolSize, config) =>
  new WarmChunkerPoolLease(poolSize, config);

afterAll(async () => {
  const pools = [...warmChunkOnlyPools.values()];
  warmChunkOnlyPools.clear();
  await Promise.all(pools.map(async (pool) => pool.shutdown()));
});
