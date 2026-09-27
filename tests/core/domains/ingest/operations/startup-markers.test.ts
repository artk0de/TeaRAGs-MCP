import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanupTempDir,
  createTempTestDir,
  createTestFile,
  defaultTestConfig,
  defaultTrajectoryConfig,
  MockEmbeddingProvider,
  MockQdrantManager,
} from "../__helpers__/test-helpers.js";
import { IngestFacade } from "../../../../../src/core/api/index.js";
import { pipelineLog } from "../../../../../src/core/domains/ingest/pipeline/infra/debug-logger.js";
import { setDebug } from "../../../../../src/core/infra/runtime.js";

vi.mock("tree-sitter", () => ({
  default: class MockParser {
    setLanguage() {}
    parse() {
      return {
        rootNode: {
          type: "program",
          startPosition: { row: 0, column: 0 },
          endPosition: { row: 0, column: 0 },
          children: [],
          text: "",
          namedChildren: [],
        },
      };
    }
  },
}));
vi.mock("tree-sitter-bash", () => ({ default: {} }));
vi.mock("tree-sitter-go", () => ({ default: {} }));
vi.mock("tree-sitter-java", () => ({ default: {} }));
vi.mock("tree-sitter-javascript", () => ({ default: {} }));
vi.mock("tree-sitter-python", () => ({ default: {} }));
vi.mock("tree-sitter-rust", () => ({ default: {} }));
vi.mock("tree-sitter-typescript", () => ({
  default: { typescript: {}, tsx: {} },
}));

/**
 * A run that hangs BEFORE the first chunk is embedded is invisible in the
 * pipeline log today: the earliest per-event line is PIPELINE_START, ~16s into
 * a healthy run. The startup markers (RUN_START → SCAN_COMPLETE →
 * QDRANT_READY → HASHES_COMPLETE) decompose that window so a stall localizes
 * to a stage instead of reading as "indexing is slow".
 */
describe("IndexPipeline startup markers", () => {
  let ingest: IngestFacade;
  let tempDir: string;
  let codebaseDir: string;
  let stepSpy: ReturnType<typeof vi.spyOn>;
  let events: { message: string; data?: Record<string, unknown> }[];

  beforeEach(async () => {
    ({ tempDir, codebaseDir } = await createTempTestDir());
    ingest = new IngestFacade({
      qdrant: new MockQdrantManager() as any,
      embeddings: new MockEmbeddingProvider(),
      config: defaultTestConfig(),
      trajectoryConfig: defaultTrajectoryConfig(),
    });
    setDebug(true);
    events = [];
    stepSpy = vi.spyOn(pipelineLog, "step").mockImplementation((_ctx, message, data) => {
      events.push({ message, data });
    });
  });

  afterEach(async () => {
    stepSpy.mockRestore();
    setDebug(false);
    await cleanupTempDir(tempDir);
  });

  it("emits the startup stages in order before PIPELINE_START", async () => {
    await createTestFile(codebaseDir, "marker.ts", "export const marker = 1;");

    await ingest.indexCodebase(codebaseDir);

    const names = events.map((e) => e.message);
    expect(names).toContain("RUN_START");
    expect(names).toContain("SCAN_COMPLETE");
    expect(names).toContain("QDRANT_READY");
    const lastStartup = Math.max(
      names.lastIndexOf("RUN_START"),
      names.lastIndexOf("SCAN_COMPLETE"),
      names.lastIndexOf("QDRANT_READY"),
    );
    const pipelineStart = names.indexOf("PIPELINE_START");
    if (pipelineStart !== -1) {
      expect(lastStartup).toBeLessThan(pipelineStart);
    }
  });

  it("RUN_START carries the collection and force flag", async () => {
    await createTestFile(codebaseDir, "marker.ts", "export const marker = 1;");

    await ingest.indexCodebase(codebaseDir, { forceReindex: true });

    const runStart = events.find((e) => e.message === "RUN_START");
    expect(runStart?.data).toMatchObject({ force: true });
    expect(typeof runStart?.data?.collection).toBe("string");
  });
});
