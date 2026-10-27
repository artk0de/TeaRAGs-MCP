import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkerTimeoutError } from "../../../../../src/core/domains/ingest/errors/index.js";
import type { ChunkPipeline } from "../../../../../src/core/domains/ingest/pipeline/chunk-pipeline.js";
import type { ChunkerPool } from "../../../../../src/core/domains/ingest/pipeline/chunker/infra/pool.js";
import { processFiles } from "../../../../../src/core/domains/ingest/pipeline/file-processor.js";
import { QuarantineStore } from "../../../../../src/core/domains/ingest/sync/quarantine-store.js";
import { SkippedFileStore } from "../../../../../src/core/domains/ingest/sync/skipped-file-store.js";
import { fileContentHash } from "../../../../../src/core/primitives/ids/content-hash.js";

/** Chunker double: no chunks for whitespace-only code, one chunk otherwise. */
const chunkerPool = {
  processFile: async (_filePath: string, code: string) => ({
    chunks:
      code.trim() === ""
        ? []
        : [
            {
              content: code,
              startLine: 1,
              endLine: 1,
              metadata: { filePath: "x", language: "typescript", chunkIndex: 0 },
            },
          ],
  }),
} as unknown as ChunkerPool;

const chunkPipeline = {
  isBackpressured: () => false,
  addChunk: () => undefined,
} as unknown as ChunkPipeline;

describe("processFiles — deterministic-skip record", () => {
  let baseDir: string;
  let store: SkippedFileStore;

  beforeEach(async () => {
    baseDir = join(tmpdir(), `fp-skipped-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(join(baseDir, "snapshots"), { recursive: true });
    store = new SkippedFileStore(join(baseDir, "snapshots"), "test-collection");
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  async function write(name: string, content: string): Promise<string> {
    const file = join(baseDir, name);
    await fs.writeFile(file, content, "utf-8");
    return file;
  }

  it("records a secrets-gate skip with the content hash of the file", async () => {
    const content = `export const password = "hunter2hunter2";\n`;
    const file = await write("creds.ts", content);

    await processFiles([file], baseDir, chunkerPool, chunkPipeline, {
      enableGitMetadata: false,
      skippedFileStore: store,
    });

    const entry = (await store.load()).get("creds.ts");
    expect(entry).toMatchObject({ reason: "secretsGate", contentHash: fileContentHash(content) });
  });

  it("records a compiled-bundle skip", async () => {
    const file = await write("bundle.js", "var a=1;\n//# sourceMappingURL=bundle.js.map\n");

    await processFiles([file], baseDir, chunkerPool, chunkPipeline, {
      enableGitMetadata: false,
      skippedFileStore: store,
    });

    expect((await store.load()).get("bundle.js")?.reason).toBe("compiled");
  });

  it("records a blank file that yields no chunk as emptyFile", async () => {
    const file = await write("blank.ts", "  \n\n");

    await processFiles([file], baseDir, chunkerPool, chunkPipeline, {
      enableGitMetadata: false,
      skippedFileStore: store,
    });

    expect((await store.load()).get("blank.ts")?.reason).toBe("emptyFile");
  });

  it("clears the entry once the same path ingests with chunks", async () => {
    await store.record("fixed.ts", "secretsGate", "old");
    const file = await write("fixed.ts", "export const ok = 1;\n");

    await processFiles([file], baseDir, chunkerPool, chunkPipeline, {
      enableGitMetadata: false,
      skippedFileStore: store,
    });

    expect((await new SkippedFileStore(join(baseDir, "snapshots"), "test-collection").load()).has("fixed.ts")).toBe(
      false,
    );
  });

  it("records a non-quarantinable chunker rejection as a retryable runtimeError (bd muj77)", async () => {
    const file = await write("slow.rb", "class Slow; end\n");
    const rejectingPool = {
      processFile: async () => {
        throw new WorkerTimeoutError("chunker", "slow.rb", 120_000);
      },
    } as unknown as ChunkerPool;

    const result = await processFiles([file], baseDir, rejectingPool, chunkPipeline, {
      enableGitMetadata: false,
      quarantineStore: new QuarantineStore(join(baseDir, "snapshots"), "test-collection"),
      skippedFileStore: store,
    });

    expect(result.filesProcessed).toBe(0);
    const entry = (await new SkippedFileStore(join(baseDir, "snapshots"), "test-collection").load()).get("slow.rb");
    expect(entry).toMatchObject({ reason: "runtimeError", errorClass: "WorkerTimeoutError", retryable: true });
  });
});
