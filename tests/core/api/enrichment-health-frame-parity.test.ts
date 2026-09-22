/**
 * `get_index_status` and `get_index_metrics` frame enrichment health on the
 * SAME per-project provider list (bd tea-rags-mcp-uebug).
 *
 * The frame is the enrichment providers a project's composition runs
 * (bd tea-rags-mcp-x2u65). A project whose registry env disables a trajectory
 * is served by its own ingest slice — `AppDeps.ingestForPath`, wired to
 * `ProjectIngestFactory#forPath` — whose provider list omits it. Both read
 * surfaces must answer from that slice; framing either one on the server's
 * top-level composition shows a row the project does not run.
 *
 * Real facades over an in-memory Qdrant: the claim is about which provider
 * list each surface ends up framing on, which only the wired chain can show.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExploreFacade } from "../../../src/core/api/internal/facades/explore-facade.js";
import { IngestFacade } from "../../../src/core/api/internal/facades/ingest-facade.js";
import { createApp, type App } from "../../../src/core/api/public/app.js";
import { INDEXING_METADATA_ID } from "../../../src/core/contracts/constants.js";
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

const SERVER_PROVIDERS = [{ key: "git" }, { key: "codegraph.symbols" }];
/** The same project, with git switched off by its registry env. */
const GIT_DISABLED_PROVIDERS = [{ key: "codegraph.symbols" }];

describe("enrichment health frame — status and metrics agree per project", () => {
  let qdrant: MockQdrantManager;
  let embeddings: MockEmbeddingProvider;
  let tempDir: string;
  let codebaseDir: string;

  beforeEach(async () => {
    ({ tempDir, codebaseDir } = await createTempTestDir());
    qdrant = new MockQdrantManager();
    embeddings = new MockEmbeddingProvider();
    await seedIndexedCollection();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  /** A completed index whose marker carries both providers' blocks. */
  async function seedIndexedCollection(): Promise<void> {
    const collectionName = resolveCollectionName(await validatePath(codebaseDir));
    const now = new Date().toISOString();
    await qdrant.createCollection(collectionName, 384, "Cosine", false);
    await qdrant.addPoints(collectionName, [
      {
        id: INDEXING_METADATA_ID,
        vector: new Array(384).fill(0),
        payload: {
          indexingComplete: true,
          completedAt: now,
          enrichment: {
            _run: { runId: "run-2", startedAt: now, lastProgressAt: now, providers: ["codegraph.symbols"] },
            git: {
              file: { runId: "run-1", status: "completed", unenrichedChunks: 0 },
              chunk: { runId: "run-1", status: "completed", unenrichedChunks: 0 },
            },
            codegraph: {
              symbols: {
                file: { runId: "run-2", status: "completed", unenrichedChunks: 0 },
                chunk: { runId: "run-2", status: "completed", unenrichedChunks: 0 },
              },
            },
          },
        },
      },
      { id: "chunk-1", vector: new Array(384).fill(0.1), payload: { relativePath: "a.ts" } },
    ]);
  }

  function ingestFacade(enrichmentProviders: { key: string }[]): IngestFacade {
    return new IngestFacade({
      qdrant: qdrant as never,
      embeddings,
      config: defaultTestConfig(),
      trajectoryConfig: defaultTrajectoryConfig(),
      enrichmentProviders,
    } as never);
  }

  /** The App as bootstrap assembles it: one process slice, one per-project resolver. */
  function appFor(projectIngest: IngestFacade): App {
    const processIngest = ingestFacade(SERVER_PROVIDERS);
    const ingestForPath = (): IngestFacade => projectIngest;
    const explore = new ExploreFacade({
      qdrant: qdrant as never,
      embeddings,
      reranker: {
        hasCollectionStats: true,
        hasCollectionStatsFor: vi.fn().mockReturnValue(true),
        setCollectionStats: vi.fn(),
        getDescriptors: vi.fn().mockReturnValue([]),
        getPreset: vi.fn().mockReturnValue(null),
      } as never,
      registry: { getAllPayloadSignalDescriptors: vi.fn().mockReturnValue([]) } as never,
      collectionRegistry: undefined as never,
      statsCache: {
        lastWrittenAt: () => 1,
        load: () => ({
          perSignal: new Map(),
          perLanguage: new Map(),
          distributions: {
            totalFiles: 1,
            language: {},
            chunkType: {},
            documentation: { docs: 0, code: 1 },
            topAuthors: [],
            othersCount: 0,
          },
          computedAt: Date.now(),
        }),
      } as never,
      enrichmentHealthFrameForPath: (path: string) => ingestForPath(path).enrichmentProviderKeys,
    });
    return createApp({
      qdrant: qdrant as never,
      embeddings,
      ingest: processIngest,
      ingestForPath,
      explore,
      reranker: {} as never,
      driftReporter: {} as never,
      projectRegistryOps: {} as never,
      quantizationScalar: false,
      turboQuant: false,
    });
  }

  async function providerRows(app: App): Promise<{ status: string[]; metrics: string[] }> {
    const status = await app.getIndexStatus(codebaseDir);
    const metrics = await app.getIndexMetrics(codebaseDir);
    return {
      status: Object.keys(status.enrichment ?? {}).sort(),
      metrics: Object.keys(metrics.enrichment ?? {}).sort(),
    };
  }

  it("omits a trajectory the project's registry env disables from BOTH surfaces", async () => {
    const rows = await providerRows(appFor(ingestFacade(GIT_DISABLED_PROVIDERS)));

    expect(rows.status).toEqual(["codegraph.symbols"]);
    expect(rows.metrics).toEqual(rows.status);
  });

  it("keeps every provider on both surfaces for a project on the server's own configuration", async () => {
    const rows = await providerRows(appFor(ingestFacade(SERVER_PROVIDERS)));

    expect(rows.status).toEqual(["codegraph.symbols", "git"]);
    expect(rows.metrics).toEqual(rows.status);
  });
});
