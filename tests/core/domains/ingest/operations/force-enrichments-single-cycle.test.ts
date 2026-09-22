/**
 * `--force-enrichments <keys>` — the store repair PLUS the recompute cycle
 * (bd tea-rags-mcp-6aytq, reinstated scoped by bd tea-rags-mcp-cneu7).
 *
 * `IndexingOps#recomputeEnrichments` drives two legs in sequence: the sync
 * (`ReindexPipeline#reindexChanges` → `EnrichmentCoordinator#runRepairPass`)
 * and the recompute (`EnrichmentCoordinator#recomputeEnrichments`). 6aytq
 * removed the forcing because "the recompute's own file phase re-extracts
 * every stored file unconditionally" — which held for the Qdrant PAYLOAD but
 * NOT for the providers' persisted store rows: the recompute's DuckDB writes
 * are additive, so a stale edge row written by older resolver code survived
 * every run on an unchanged file (live on taxdome 2026-09-21: phantom
 * cross-language method edges outlived two `--force-enrichments codegraph`
 * runs; only a `CODEGRAPH_FORCE_RESOLVE=1` run, which forces the repair leg,
 * retired them). The recompute therefore now routes its selected STORE
 * providers through a forced repair first — the only diffing write path —
 * and pays the second extraction cycle on purpose.
 *
 * Both legs converge on `EnrichmentExecutor#runFileBatch`, so counting
 * dispatches per path across one invocation counts cycles. A unit test on
 * either leg alone cannot see the wiring — the coordinator-level contract
 * lives in `force-enrichments-provider-repair.test.ts`; this file pins the
 * composed invocation: exactly two cycles, repair first, nothing else.
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

/** Every path handed to `runFileBatch`, in order, across every leg. */
const extractedPaths: string[] = [];
/**
 * What the provider "persisted" — the content hashes of the last batch it was
 * asked to extract, exactly as the real codegraph provider stamps them onto its
 * rows at write time. Without this the repair pass sees an empty store, calls
 * every file drifted, and re-extracts on every run regardless of the force —
 * which would hide the very duplication under test.
 */
const persistedHashes = new Map<string, string>();

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
    // Declared so the file phase takes the deferred-extraction branch the real
    // codegraph provider takes; the recording executor intercepts before it.
    streamFileBatch: vi.fn().mockResolvedValue(new Map()),
    readPersistedFileHashes: vi.fn(async () => new Map<string, string | null>(persistedHashes)),
    handleDeletedPaths: vi.fn().mockResolvedValue(undefined),
  };
}

function recordingExecutor(): EnrichmentExecutor {
  return {
    runFileBatch: vi.fn(
      async (_provider, _root, paths: string[], options?: { contentHashes?: ReadonlyMap<string, string> }) => {
        extractedPaths.push(...paths);
        for (const path of paths) {
          const hash = options?.contentHashes?.get(path);
          if (hash) persistedHashes.set(path, hash);
        }
        return new Map();
      },
    ),
    runFileSignalsRecovery: vi.fn().mockResolvedValue(new Map()),
    runChunkBatch: vi.fn().mockResolvedValue(new Map()),
    runFinalize: vi.fn().mockResolvedValue(new Map()),
    releaseRun: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

/** A file big enough for the chunker to emit points for. */
function sourceOf(name: string): string {
  return Array.from({ length: 60 }, (_, i) => `export const ${name}Value${i} = ${i};`).join("\n");
}

/** How many times each path was dispatched for extraction. */
function dispatchCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const path of extractedPaths) counts.set(path, (counts.get(path) ?? 0) + 1);
  return counts;
}

describe("--force-enrichments — store repair, then the recompute cycle (6aytq / cneu7)", () => {
  let ingest: IngestFacade;
  let qdrant: MockQdrantManager;
  let config: IngestCodeConfig;
  let tempDir: string;
  let codebaseDir: string;

  beforeEach(async () => {
    extractedPaths.length = 0;
    persistedHashes.clear();
    ({ tempDir, codebaseDir } = await createTempTestDir());
    qdrant = new MockQdrantManager();
    config = { ...defaultTestConfig(), supportedExtensions: [".ts"] };
    ingest = new IngestFacade({
      qdrant: qdrant as never,
      embeddings: new MockEmbeddingProvider(),
      config,
      trajectoryConfig: defaultTrajectoryConfig(),
      enrichmentProviders: [graphProvider()],
      enrichmentExecutor: recordingExecutor(),
    } as never);

    // Long enough to survive chunking: the recompute leg derives its work set
    // from STORED CHUNKS, so a file that produced none leaves that leg an
    // empty-set no-op and the duplication cannot be observed at all.
    await createTestFile(codebaseDir, "app.ts", sourceOf("app"));
    await createTestFile(codebaseDir, "util.ts", sourceOf("util"));
    await ingest.indexCodebase(codebaseDir);
    // A run on a collection still enriching is refused (bd tea-rags-mcp-62pgi).
    await ingest.whenEnrichmentComplete();
    // One plain incremental so the store is populated and current: the repair
    // pass is only meaningful against a graph that already matches the code,
    // which is the state every real `--force-enrichments` run starts from.
    await ingest.indexCodebase(codebaseDir);
    await ingest.whenEnrichmentComplete();
    extractedPaths.length = 0;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  it("dispatches each file exactly twice — the forced store repair, then the recompute cycle", async () => {
    await ingest.indexCodebase(codebaseDir, { forceEnrichments: ["codegraph"] });

    expect(dispatchCounts()).toEqual(
      new Map([
        ["app.ts", 2],
        ["util.ts", 2],
      ]),
    );
    // The FIRST dispatch is the forced repair: one batch carrying the whole
    // stored corpus (the recompute's file phase batches per stored batch, and
    // would arrive with or without the repair — the repair is what must lead).
    expect(extractedPaths.slice(0, 2).sort()).toEqual(["app.ts", "util.ts"]);
  });

  it("still re-extracts every file, so the force is not merely cheaper", async () => {
    // The control for the assertion above: a fix that stopped extracting
    // altogether would satisfy an "at most once" check and silently return the
    // flag to the no-op it was before bd tea-rags-mcp-ub76a.
    await ingest.indexCodebase(codebaseDir, { forceEnrichments: ["codegraph"] });

    expect([...dispatchCounts().keys()].sort()).toEqual(["app.ts", "util.ts"]);
  });

  it("leaves the plain incremental alone — a current store re-extracts nothing", async () => {
    await ingest.indexCodebase(codebaseDir);

    expect(extractedPaths).toEqual([]);
  });
});
