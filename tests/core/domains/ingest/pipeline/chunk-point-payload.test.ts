/**
 * `buildChunkPointPayload` (bd tea-rags-mcp-xi2r9.3) — the chunker-owned point
 * payload ingest stores for one chunk, as ONE function a second reader (the
 * working-tree overlay) can call. Pinned against what the ingest file path
 * actually stores: the chunk `processFiles` hands the pipeline, shaped by the
 * same `PayloadBuilder` the chunk pipeline applies before upsert.
 */

import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cleanupTempDir, createTempTestDir, createTestFile } from "../__helpers__/test-helpers.js";
import { warmChunkerPoolFactory } from "../__helpers__/warm-chunker-pool.js";
import { buildChunkPointPayload } from "../../../../../src/core/domains/ingest/pipeline/chunk-point-payload.js";
import type {
  ChunkerPoolPort,
  FileChunkResult,
} from "../../../../../src/core/domains/ingest/pipeline/chunker/infra/pool.js";
import { processFiles } from "../../../../../src/core/domains/ingest/pipeline/file-processor.js";
import type { ChunkItem } from "../../../../../src/core/domains/ingest/pipeline/types.js";
import { StaticPayloadBuilder } from "../../../../../src/core/domains/trajectory/static/provider.js";

const SOURCE = `import { join } from "node:path";

export class Greeter {
  constructor(private readonly name: string) {}

  greet(): string {
    return join("hello", this.name);
  }

  farewell(): string {
    return "bye " + this.name;
  }
}

export function helper(value: number): number {
  return value * 2;
}
`;

describe("buildChunkPointPayload", () => {
  let tempDir: string;
  let codebaseDir: string;

  beforeEach(async () => {
    ({ tempDir, codebaseDir } = await createTempTestDir());
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("should equal the payload the ingest file path stores for every chunk of a file", async () => {
    await createTestFile(codebaseDir, "src/greeter.ts", SOURCE);
    const filePath = join(codebaseDir, "src/greeter.ts");
    const pool = warmChunkerPoolFactory(1, { chunkSize: 2500, chunkOverlap: 300, maxChunkSize: 2500 });
    let parsed: FileChunkResult | undefined;
    const recordingPool: ChunkerPoolPort = {
      processFile: async (...args) => (parsed = await pool.processFile(...args)),
      shutdown: async () => pool.shutdown(),
    };
    const submitted: { chunk: ChunkItem["chunk"]; codebasePath: string }[] = [];
    const chunkPipeline = {
      addChunk: (chunk: ChunkItem["chunk"], _id: string, codebasePath: string) => {
        submitted.push({ chunk, codebasePath });
        return true;
      },
      isBackpressured: () => false,
      waitForBackpressure: async () => true,
    };

    await processFiles([filePath], codebaseDir, recordingPool, chunkPipeline as never, { enableGitMetadata: false });

    const payloadBuilder = new StaticPayloadBuilder();
    // processFiles post-processes the parsed chunks in place (navigation, doc
    // symbolIds, symbol mass), so `parsed.chunks` is what it submitted from.
    expect(parsed?.imports).toEqual(["node:path"]);
    expect(submitted.length).toBeGreaterThan(1);
    expect(parsed?.chunks).toHaveLength(submitted.length);
    const stored = submitted.map(({ chunk, codebasePath }) => payloadBuilder.buildPayload(chunk, codebasePath));
    const built = (parsed?.chunks ?? []).map((chunk) =>
      buildChunkPointPayload(chunk, { codebasePath: codebaseDir, imports: parsed?.imports ?? [], payloadBuilder }),
    );
    expect(built).toEqual(stored);
    expect(built[0]).toMatchObject({ relativePath: "src/greeter.ts", imports: ["node:path"], language: "typescript" });
  });

  it("should omit imports when the file declares none", async () => {
    const code = SOURCE.split("\n").slice(2).join("\n");
    await createTestFile(codebaseDir, "a.ts", code);
    const pool = warmChunkerPoolFactory(1, { chunkSize: 2500, chunkOverlap: 300, maxChunkSize: 2500 });
    const { chunks } = await pool.processFile(join(codebaseDir, "a.ts"), code, "typescript");

    const payload = buildChunkPointPayload(chunks[0], {
      codebasePath: codebaseDir,
      imports: [],
      payloadBuilder: new StaticPayloadBuilder(),
    });

    expect(payload).not.toHaveProperty("imports");
    expect(payload.relativePath).toBe("a.ts");
  });
});
