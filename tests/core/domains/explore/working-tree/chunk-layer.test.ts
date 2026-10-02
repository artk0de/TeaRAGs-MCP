/**
 * `WorkingTreeChunkLayer` (bd tea-rags-mcp-xi2r9.3): delta files of a working
 * tree chunked by the production chunker, rows shaped exactly as ingest would
 * store them (minus git / codegraph payload), cached by content, the pool
 * built lazily and released when idle.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("should produce the ids and payload ingest assigns for the same files", async () => {
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
        stored.push({ id, payload: payloadBuilder.buildPayload(chunk, codebasePath) });
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
