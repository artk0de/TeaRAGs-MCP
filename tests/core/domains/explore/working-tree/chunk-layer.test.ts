/**
 * `WorkingTreeChunkLayer` (bd tea-rags-mcp-xi2r9.3): delta files of a working
 * tree chunked by the production chunker, rows shaped exactly as ingest would
 * store them (minus git / codegraph payload), cached by content, the pool
 * built lazily and released when idle.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { toQdrantPointId } from "../../../../../src/core/adapters/qdrant/point-id.js";
import type { ScrollChunk } from "../../../../../src/core/domains/explore/chunk-grouping/types.js";
import { createWorkingTreeChunkLayer } from "../../../../../src/core/domains/explore/working-tree/index.js";
import type { ChunkerPoolPort } from "../../../../../src/core/domains/ingest/pipeline/chunker/infra/pool.js";
import { buildFileChunkPoints } from "../../../../../src/core/domains/ingest/pipeline/file-chunk-points.js";
import { processFiles } from "../../../../../src/core/domains/ingest/pipeline/file-processor.js";
import type { ChunkItem } from "../../../../../src/core/domains/ingest/pipeline/types.js";
import { StaticPayloadBuilder } from "../../../../../src/core/domains/trajectory/static/provider.js";
import type { ChunkerConfig } from "../../../../../src/core/types.js";
import { cleanupTempDir, createTempTestDir } from "../../ingest/__helpers__/test-helpers.js";
import { warmChunkerPoolFactory } from "../../ingest/__helpers__/warm-chunker-pool.js";

const CONFIG: ChunkerConfig = { chunkSize: 2500, chunkOverlap: 300, maxChunkSize: 2500 };

const GREETER = `import { join } from "node:path";

export class Greeter {
  constructor(private readonly name: string) {}

  greet(): string {
    return join("hello", this.name);
  }
}

export function helper(value: number): number {
  return value * 2;
}
`;

const README = `# Title

Intro paragraph that is long enough to become a section of its own.

## Usage

Call \`helper\` with a number and it doubles the value for you.
`;

describe("WorkingTreeChunkLayer", () => {
  let tempDir: string;
  let tree: string;

  const write = (relativePath: string, content: string): void => {
    const target = join(tree, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };

  beforeEach(async () => {
    ({ tempDir, codebaseDir: tree } = await createTempTestDir());
  });

  afterEach(async () => {
    vi.useRealTimers();
    await cleanupTempDir(tempDir);
  });

  /** A layer over stub pools whose chunker returns one row per file. */
  const stubLayer = (idleShutdownMs?: number) => {
    const pools: { shutdown: ReturnType<typeof vi.fn> }[] = [];
    const createPool = vi.fn((_config: ChunkerConfig) => {
      const pool = { shutdown: vi.fn(async () => undefined) };
      pools.push(pool);
      return pool;
    });
    const chunkFile = vi.fn(
      async (_pool: unknown, file: { relativePath: string; code: string }): Promise<ScrollChunk[]> => {
        if (file.code.includes("BROKEN")) throw new Error(`parse failed: ${file.relativePath}`);
        return [{ id: `id:${file.relativePath}:${file.code.length}`, payload: { relativePath: file.relativePath } }];
      },
    );
    const layer = createWorkingTreeChunkLayer({ createPool, chunkFile, idleShutdownMs });
    return { layer, pools, createPool, chunkFile };
  };

  // Invariant changed (bd tea-rags-mcp-xi2r9, live probe P1-2): the parity is
  // with the id ingest STORES — `generateChunkId` mapped by `toQdrantPointId`,
  // as `QdrantPointStore` writes it — not with the pre-write `chunk_<hex>`.
  // A `chunk_` id addressed no point, so find_similar answered it with a 400.
  it("should produce the point ids and payload ingest stores for the same files", async () => {
    write("src/greeter.ts", GREETER);
    write("docs/README.md", README);
    const payloadBuilder = new StaticPayloadBuilder();
    const layer = createWorkingTreeChunkLayer({
      createPool: (config: ChunkerConfig) => warmChunkerPoolFactory(1, config),
      chunkFile: async (pool: ChunkerPoolPort, file) => buildFileChunkPoints(pool, file, payloadBuilder),
    });

    const read = await layer.chunk(tree, ["src/greeter.ts", "docs/README.md"], CONFIG);

    const stored: ScrollChunk[] = [];
    const chunkPipeline = {
      addChunk: (chunk: ChunkItem["chunk"], id: string, codebasePath: string) => {
        stored.push({ id: String(toQdrantPointId(id)), payload: payloadBuilder.buildPayload(chunk, codebasePath) });
        return true;
      },
      isBackpressured: () => false,
      waitForBackpressure: async () => true,
    };
    await processFiles(
      [join(tree, "src/greeter.ts"), join(tree, "docs/README.md")],
      tree,
      warmChunkerPoolFactory(1, CONFIG),
      chunkPipeline as never,
      { enableGitMetadata: false },
    );
    const byId = (rows: readonly ScrollChunk[]) => [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));

    expect(read.unparsed).toEqual([]);
    expect(stored.length).toBeGreaterThan(2);
    expect(byId(read.chunks)).toEqual(byId(stored));
    for (const row of read.chunks) {
      expect(row.payload).not.toHaveProperty("git");
      expect(row.payload).not.toHaveProperty("codegraph");
    }
    await layer.dispose();
  });

  it("should not re-chunk a file whose content is unchanged, and should re-chunk an edit", async () => {
    write("a.ts", "export const a = 1;\n");
    const { layer, chunkFile } = stubLayer();

    const first = await layer.chunk(tree, ["a.ts"], CONFIG);
    const second = await layer.chunk(tree, ["a.ts"], CONFIG);
    expect(chunkFile).toHaveBeenCalledTimes(1);
    expect(second.chunks).toEqual(first.chunks);

    write("a.ts", "export const a = 2; // edited\n");
    const third = await layer.chunk(tree, ["a.ts"], CONFIG);
    expect(chunkFile).toHaveBeenCalledTimes(2);
    expect(third.chunks).not.toEqual(first.chunks);
    await layer.dispose();
  });

  it("should not build a pool until a call has a file to chunk", async () => {
    write("a.ts", "export const a = 1;\n");
    const { layer, createPool } = stubLayer();

    expect(await layer.chunk(tree, [], CONFIG)).toEqual({ chunks: [], unparsed: [] });
    expect(createPool).not.toHaveBeenCalled();

    await layer.chunk(tree, ["a.ts"], CONFIG);
    expect(createPool).toHaveBeenCalledTimes(1);
    expect(createPool).toHaveBeenCalledWith(CONFIG);
    await layer.dispose();
  });

  it("should shut the pool down after the idle window and build a new one on the next call", async () => {
    write("a.ts", "export const a = 1;\n");
    write("b.ts", "export const b = 1;\n");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { layer, pools, createPool } = stubLayer(1_000);

    await layer.chunk(tree, ["a.ts"], CONFIG);
    await vi.advanceTimersByTimeAsync(999);
    expect(pools[0].shutdown).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(pools[0].shutdown).toHaveBeenCalledTimes(1);

    await layer.chunk(tree, ["b.ts"], CONFIG);
    expect(createPool).toHaveBeenCalledTimes(2);
    await layer.dispose();
    expect(pools[1].shutdown).toHaveBeenCalledTimes(1);
  });

  it("should replace the pool when the chunker config changes", async () => {
    write("a.ts", "export const a = 1;\n");
    const { layer, pools, createPool } = stubLayer();

    await layer.chunk(tree, ["a.ts"], CONFIG);
    await layer.chunk(tree, ["a.ts"], { ...CONFIG, chunkSize: 1000, maxChunkSize: 1000 });

    expect(createPool).toHaveBeenCalledTimes(2);
    expect(pools[0].shutdown).toHaveBeenCalledTimes(1);
    await layer.dispose();
  });

  it("should list a file that fails to parse or read as unparsed and keep the other rows", async () => {
    write("good.ts", "export const good = 1;\n");
    write("bad.ts", "BROKEN {{{\n");
    const { layer } = stubLayer();

    const read = await layer.chunk(tree, ["good.ts", "bad.ts", "missing.ts"], CONFIG);

    expect(read.chunks.map((row) => row.payload.relativePath)).toEqual(["good.ts"]);
    expect(read.unparsed).toEqual(["bad.ts", "missing.ts"]);
    await layer.dispose();
  });
});

/**
 * WTO unbounded delta, Task 5: the layer chunks a call's files concurrently,
 * up to `concurrency`, and keeps the result in request order; its memory cache
 * is bounded by the bytes of the rows it holds, not by a file count.
 */
describe("WorkingTreeChunkLayer — concurrency and the byte-bounded cache", () => {
  let tempDir: string;
  let tree: string;

  const write = (relativePath: string, content: string): void => {
    const target = join(tree, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };

  beforeEach(async () => {
    ({ tempDir, codebaseDir: tree } = await createTempTestDir());
  });

  afterEach(async () => {
    vi.useRealTimers();
    await cleanupTempDir(tempDir);
  });

  /** A chunker whose calls finish only when the test releases them. */
  const gatedChunker = () => {
    const gates: { path: string; release: () => void }[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const chunkFile = vi.fn(
      async (_pool: unknown, file: { relativePath: string; code: string }): Promise<ScrollChunk[]> => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => gates.push({ path: file.relativePath, release: resolve }));
        inFlight--;
        return [{ id: `id:${file.relativePath}`, payload: { relativePath: file.relativePath, content: file.code } }];
      },
    );
    const settle = async () => new Promise((resolve) => setImmediate(resolve));
    /**
     * Releases all `total` chunker calls, newest first, then awaits `done` —
     * each release only once `parallel` calls (or every call left) wait, so
     * the layer had every chance to exceed its bound.
     */
    const drain = async <T>(done: Promise<T>, parallel: number, total: number): Promise<T> => {
      let released = 0;
      while (released < total) {
        await settle();
        if (gates.length < Math.min(parallel, total - released)) continue;
        gates.pop()?.release();
        released++;
      }
      return done;
    };
    return { chunkFile, gates, drain, maxInFlight: () => maxInFlight, settle };
  };

  const pool = () => ({ shutdown: vi.fn(async () => undefined) });

  it("should never have more than `concurrency` chunkFile calls in flight and should keep request order", async () => {
    const paths = Array.from({ length: 10 }, (_, i) => `f${String(i)}.ts`);
    for (const path of paths) write(path, `export const v = "${path}";\n`);
    const chunker = gatedChunker();
    const layer = createWorkingTreeChunkLayer({ createPool: pool, chunkFile: chunker.chunkFile, concurrency: 3 });

    const read = await chunker.drain(layer.chunk(tree, paths, CONFIG), 3, paths.length);

    expect(chunker.chunkFile).toHaveBeenCalledTimes(10);
    expect(chunker.maxInFlight()).toBe(3);
    // released newest-first, so files finished out of order — the rows are still in request order
    expect(read.chunks.map((row) => row.payload.relativePath)).toEqual(paths);
    expect([...(read.rowsByPath?.keys() ?? [])]).toEqual(paths);
    expect(read.rowsByPath?.get("f4.ts")?.map((row) => row.id)).toEqual(["id:f4.ts"]);
    await layer.dispose();
  });

  it("should keep unparsed files in request order when chunking concurrently", async () => {
    write("a.ts", "export const a = 1;\n");
    write("c.ts", "export const c = 1;\n");
    const chunkFile = vi.fn(async (_pool: unknown, file: { relativePath: string }): Promise<ScrollChunk[]> => {
      if (file.relativePath === "a.ts") await new Promise((resolve) => setTimeout(resolve, 20));
      if (file.relativePath === "c.ts") throw new Error("parse failed");
      return [{ id: file.relativePath, payload: { relativePath: file.relativePath } }];
    });
    const layer = createWorkingTreeChunkLayer({ createPool: pool, chunkFile, concurrency: 4 });

    const read = await layer.chunk(tree, ["missing.ts", "a.ts", "c.ts"], CONFIG);

    expect(read.unparsed).toEqual(["missing.ts", "c.ts"]);
    expect(read.chunks.map((row) => row.id)).toEqual(["a.ts"]);
    await layer.dispose();
  });

  it("should evict the oldest rows once the cache holds more bytes than its bound", async () => {
    write("a.ts", "a".repeat(60));
    write("b.ts", "b".repeat(60));
    const chunkFile = vi.fn(
      async (_pool: unknown, file: { relativePath: string; code: string }): Promise<ScrollChunk[]> => [
        { id: file.relativePath, payload: { relativePath: file.relativePath, content: file.code } },
      ],
    );
    const layer = createWorkingTreeChunkLayer({ createPool: pool, chunkFile, maxCacheBytes: 100 });

    await layer.chunk(tree, ["a.ts"], CONFIG);
    await layer.chunk(tree, ["b.ts"], CONFIG); // 120 bytes > 100 — a.ts goes
    expect(chunkFile).toHaveBeenCalledTimes(2);

    await layer.chunk(tree, ["b.ts"], CONFIG);
    expect(chunkFile).toHaveBeenCalledTimes(2); // b.ts is still held

    await layer.chunk(tree, ["a.ts"], CONFIG);
    expect(chunkFile).toHaveBeenCalledTimes(3); // a.ts was evicted
    await layer.dispose();
  });

  it("should not cache a file whose rows alone exceed the bound", async () => {
    write("big.ts", "x".repeat(60));
    write("small.ts", "y".repeat(10));
    const chunkFile = vi.fn(
      async (_pool: unknown, file: { relativePath: string; code: string }): Promise<ScrollChunk[]> => [
        { id: file.relativePath, payload: { relativePath: file.relativePath, content: file.code } },
      ],
    );
    const layer = createWorkingTreeChunkLayer({ createPool: pool, chunkFile, maxCacheBytes: 50 });

    await layer.chunk(tree, ["small.ts", "big.ts"], CONFIG);
    await layer.chunk(tree, ["small.ts", "big.ts"], CONFIG);

    expect(chunkFile.mock.calls.map(([, file]) => file.relativePath).sort()).toEqual(["big.ts", "big.ts", "small.ts"]);
    await layer.dispose();
  });

  it("should arm the idle shutdown only once every concurrent call has finished", async () => {
    write("a.ts", "export const a = 1;\n");
    write("b.ts", "export const b = 1;\n");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pools: ReturnType<typeof pool>[] = [];
    const chunker = gatedChunker();
    const layer = createWorkingTreeChunkLayer({
      createPool: () => {
        const created = pool();
        pools.push(created);
        return created;
      },
      chunkFile: chunker.chunkFile,
      concurrency: 2,
      idleShutdownMs: 1_000,
    });

    const slow = layer.chunk(tree, ["a.ts"], CONFIG);
    const fast = layer.chunk(tree, ["b.ts"], CONFIG);
    while (chunker.gates.length < 2) await chunker.settle();
    chunker.gates.find((gate) => gate.path === "b.ts")?.release();
    await fast;

    await vi.advanceTimersByTimeAsync(5_000);
    expect(pools[0].shutdown).not.toHaveBeenCalled(); // a.ts is still being chunked

    chunker.gates.find((gate) => gate.path === "a.ts")?.release();
    await slow;
    await vi.advanceTimersByTimeAsync(999);
    expect(pools[0].shutdown).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(pools[0].shutdown).toHaveBeenCalledTimes(1);
    expect(pools).toHaveLength(1);
    await layer.dispose();
  });
});
