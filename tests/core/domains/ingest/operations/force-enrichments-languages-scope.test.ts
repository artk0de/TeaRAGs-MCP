/**
 * `--force-enrichments <keys> --languages <langs>` — the WIRED path, end to end
 * (bd tea-rags-mcp-df1rn).
 *
 * The unit contracts on both ends of this chain were green while the live run
 * ignored the flag entirely: `tests/cli/index-codebase-languages-flag.test.ts`
 * pinned the parse, `coordinator-recompute-languages.test.ts` pinned the scroll
 * filter — and in between, `IndexingOps#recomputeEnrichments` handed the sync
 * leg its force selectors WITHOUT the language selection, so the repair pass
 * force-re-extracted every scanned file of every language. Observed on taxdome
 * 2026-08-14: `index-codebase --force-enrichments codegraph --languages
 * typescript` logged `REPAIR_PASS repaired:19966 forcedResolve:true` and
 * extracted + resolved ruby (8817 files), bash (39) and js (7) alongside the
 * 10621 typescript ones.
 *
 * So these drive the REAL facade → IndexingOps → ReindexPipeline →
 * EnrichmentCoordinator wiring with the option object the CLI builds, and
 * assert on what the executor was actually asked to re-extract. A test that
 * stops at any one seam is what let the leak through.
 */

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
import type { EnrichmentExecutor } from "../../../../../src/core/contracts/types/enrichment-executor.js";
import type { EnrichmentProvider } from "../../../../../src/core/contracts/types/provider.js";
import { EnrichmentCoordinator } from "../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";
import type { IngestCodeConfig } from "../../../../../src/core/types.js";

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
vi.mock("tree-sitter-ruby", () => ({ default: {} }));
vi.mock("tree-sitter-rust", () => ({ default: {} }));
vi.mock("tree-sitter-typescript", () => ({ default: { typescript: {}, tsx: {} } }));

/** Every path the repair pass asked the executor to re-extract, in order. */
const repairedPaths: string[] = [];
/** Every path a provider was told to prune rows for. */
const prunedPaths: string[] = [];

/**
 * Stand-in for the codegraph provider: the only kind that owns a per-file store
 * and therefore the only kind `runRepairPass` can force. `null` hashes make
 * every file look drifted, so the repair set is decided purely by scope — which
 * is the thing under test.
 */
function graphProvider(): EnrichmentProvider {
  return {
    key: "codegraph.symbols",
    signals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
    resolveRoot: (p: string) => p,
    buildFileSignals: vi.fn().mockResolvedValue(new Map()),
    buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    readPersistedFileHashes: vi.fn().mockResolvedValue(new Map<string, string | null>()),
    handleDeletedPaths: vi.fn(async (paths: string[]) => {
      prunedPaths.push(...paths);
    }),
  } as unknown as EnrichmentProvider;
}

function recordingExecutor(): EnrichmentExecutor {
  return {
    runFileBatch: vi.fn(async (_provider, _root, paths: string[]) => {
      repairedPaths.push(...paths);
      return new Map();
    }),
    runFileSignalsRecovery: vi.fn().mockResolvedValue(new Map()),
    runChunkBatch: vi.fn().mockResolvedValue(new Map()),
    runFinalize: vi.fn().mockResolvedValue(new Map()),
    releaseCollection: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as EnrichmentExecutor;
}

describe("--force-enrichments with --languages — repair-pass scope (bd tea-rags-mcp-df1rn)", () => {
  let ingest: IngestFacade;
  let qdrant: MockQdrantManager;
  let config: IngestCodeConfig;
  let tempDir: string;
  let codebaseDir: string;

  beforeEach(async () => {
    repairedPaths.length = 0;
    prunedPaths.length = 0;
    ({ tempDir, codebaseDir } = await createTempTestDir());
    qdrant = new MockQdrantManager() as never;
    // Two languages in one corpus is the whole fixture: the default helper
    // config scans neither ruby nor anything else that could stand in for it.
    config = { ...defaultTestConfig(), supportedExtensions: [".ts", ".rb"] };
    ingest = new IngestFacade({
      qdrant: qdrant as never,
      embeddings: new MockEmbeddingProvider(),
      config,
      trajectoryConfig: defaultTrajectoryConfig(),
      enrichmentProviders: [graphProvider()],
      enrichmentExecutor: recordingExecutor(),
    } as never);

    await createTestFile(codebaseDir, "app.ts", "export const app = 1;\nconsole.log('App');");
    await createTestFile(codebaseDir, "worker.rb", "class Worker\n  def run\n    1\n  end\nend\n");
    await ingest.indexCodebase(codebaseDir);

    // The recompute leg reads its own chunk set back from Qdrant under a
    // language filter that `coordinator-recompute-languages.test.ts` already
    // pins — and MockQdrantManager's scroll ignores filters, so leaving it live
    // would drown the repair pass's calls in unfiltered ones. Stubbed so what
    // remains is exactly the SYNC leg, which is where the selection was lost.
    vi.spyOn(EnrichmentCoordinator.prototype, "recomputeEnrichments").mockResolvedValue({} as never);
    repairedPaths.length = 0;
    prunedPaths.length = 0;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  it("re-extracts only the selected language's files", async () => {
    await ingest.indexCodebase(codebaseDir, { forceEnrichments: ["codegraph"], languages: ["typescript"] });

    expect(repairedPaths).toContain("app.ts");
    expect(repairedPaths.filter((p) => p.endsWith(".rb"))).toEqual([]);
  });

  it("forces every language when the flag is absent, so the default run is unchanged", async () => {
    // The control: without it, a fix that simply repaired nothing would pass
    // the assertion above.
    await ingest.indexCodebase(codebaseDir, { forceEnrichments: ["codegraph"] });

    expect(repairedPaths).toContain("app.ts");
    expect(repairedPaths).toContain("worker.rb");
  });

  it("does not prune the unselected language's rows as orphans", async () => {
    // Narrowing the REPAIR set must never narrow the ELIGIBLE set: a file the
    // run declines to re-extract is still a file the provider owns rows for.
    // Filtering before `computeExtractionRepair` would report every ruby row as
    // an orphan and delete the graph this run was told not to touch.
    await ingest.indexCodebase(codebaseDir, { forceEnrichments: ["codegraph"], languages: ["typescript"] });

    expect(prunedPaths).toEqual([]);
  });
});
