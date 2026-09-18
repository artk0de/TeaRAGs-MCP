/**
 * bd tea-rags-mcp-39xca.12 — every chunk count agrees on one collection.
 *
 * Observed live on one collection at one moment: `get_index_metrics`
 * totalChunks 24366, `get_index_status` chunksCount 24365, the enrichment
 * recompute's RECOMPUTE_SCROLL 24364. The collection carries two service points
 * besides its chunks — the indexing marker and the schema metadata point — and
 * the three surfaces left out two, one and zero of them.
 *
 * One in-memory collection, three real read paths: the claim is that they
 * report the same number, which only reading all three against the same points
 * can show.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IngestFacade } from "../../../src/core/api/internal/facades/ingest-facade.js";
import { INDEXING_METADATA_ID } from "../../../src/core/contracts/constants.js";
import { IndexMetricsQuery } from "../../../src/core/domains/explore/queries/index-metrics.js";
import { EnrichmentCoordinator } from "../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";
import type { EnrichmentProvider } from "../../../src/core/domains/ingest/pipeline/enrichment/types.js";
import { pipelineLog } from "../../../src/core/domains/ingest/pipeline/infra/debug-logger.js";
import { resolveCollectionName, validatePath } from "../../../src/core/infra/collection-name.js";
import {
  cleanupTempDir,
  createTempTestDir,
  defaultTestConfig,
  defaultTrajectoryConfig,
  MockEmbeddingProvider,
  MockQdrantManager,
} from "../domains/ingest/__helpers__/test-helpers.js";

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

const CHUNK_COUNT = 3;

function gitProvider(): EnrichmentProvider {
  return {
    key: "git",
    signals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
    resolveRoot: (p: string) => p,
    buildFileSignals: vi.fn().mockResolvedValue(new Map()),
    buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
  };
}

describe("chunk counts — status, metrics and the recompute agree on one collection", () => {
  let qdrant: MockQdrantManager;
  let tempDir: string;
  let codebaseDir: string;
  let collectionName: string;

  beforeEach(async () => {
    ({ tempDir, codebaseDir } = await createTempTestDir());
    qdrant = new MockQdrantManager();
    collectionName = resolveCollectionName(await validatePath(codebaseDir));
    await seedCollectionWithBothServicePoints();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  /** A completed index: CHUNK_COUNT chunks plus the marker and the schema metadata point. */
  async function seedCollectionWithBothServicePoints(): Promise<void> {
    const now = new Date().toISOString();
    await qdrant.createCollection(collectionName, 384, "Cosine", false);
    const chunks = Array.from({ length: CHUNK_COUNT }, (_, i) => ({
      id: `chunk-${i}`,
      vector: new Array(384).fill(0.1),
      payload: { relativePath: `src/file${i}.ts`, startLine: 1, endLine: 10, language: "typescript" },
    }));
    await qdrant.addPoints(collectionName, [
      {
        id: INDEXING_METADATA_ID,
        vector: new Array(384).fill(0),
        payload: { _type: "indexing_metadata", indexingComplete: true, completedAt: now, embeddingModel: "mock-model" },
      },
      {
        id: "__schema_metadata__",
        vector: new Array(384).fill(0),
        payload: { _type: "schema_metadata", schemaVersion: 14, indexes: [], sparseVersion: 1, migratedAt: now },
      },
      ...chunks,
    ]);
  }

  async function statusChunks(): Promise<number | undefined> {
    const ingest = new IngestFacade({
      qdrant: qdrant as never,
      embeddings: new MockEmbeddingProvider(),
      config: defaultTestConfig(),
      trajectoryConfig: defaultTrajectoryConfig(),
    });
    return (await ingest.getIndexStatus(codebaseDir)).chunksCount;
  }

  async function metricsChunks(): Promise<number> {
    const statsCache = {
      load: () => ({
        perSignal: new Map(),
        perLanguage: new Map(),
        distributions: {
          totalFiles: CHUNK_COUNT,
          language: {},
          chunkType: {},
          documentation: { docs: 0, code: CHUNK_COUNT },
          topAuthors: [],
          othersCount: 0,
        },
        computedAt: Date.now(),
      }),
    };
    const query = new IndexMetricsQuery(qdrant as never, statsCache as never, []);
    return (await query.run(collectionName, codebaseDir)).totalChunks;
  }

  /** The chunk count the recompute logs for the set it read back from the index. */
  async function recomputeScrollChunks(): Promise<unknown> {
    const phases = vi.spyOn(pipelineLog, "enrichmentPhase");
    const coordinator = new EnrichmentCoordinator(qdrant as never, [gitProvider()]);
    await coordinator.recomputeEnrichments(collectionName, codebaseDir, ["git"]);
    const scroll = phases.mock.calls.find(([phase]) => phase === "RECOMPUTE_SCROLL");
    return (scroll?.[1] as { chunks?: number } | undefined)?.chunks;
  }

  it("get_index_status reports the chunks, not the service points", async () => {
    expect(await statusChunks()).toBe(CHUNK_COUNT);
  });

  it("get_index_metrics reports the chunks, not the service points", async () => {
    expect(await metricsChunks()).toBe(CHUNK_COUNT);
  });

  it("the recompute reads back the chunks, not the service points", async () => {
    expect(await recomputeScrollChunks()).toBe(CHUNK_COUNT);
  });

  it("all three report the same number", async () => {
    const counts = [await statusChunks(), await metricsChunks(), await recomputeScrollChunks()];

    expect(new Set(counts).size).toBe(1);
  });
});
