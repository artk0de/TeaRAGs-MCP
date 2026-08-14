/**
 * `--force-enrichments <keys>` must cost ONE extraction+resolve cycle per
 * provider, not two (bd tea-rags-mcp-6aytq).
 *
 * `IndexingOps#recomputeEnrichments` drives two legs in sequence: the sync
 * (`ReindexPipeline#reindexChanges` → `EnrichmentCoordinator#runRepairPass`)
 * and the recompute (`EnrichmentCoordinator#recomputeEnrichments`). Only the
 * recompute writes payload — it is the leg that reads the chunk set back out of
 * the index, so it is the only one holding the chunk ids a file overlay is
 * applied through. Forcing the repair leg as well therefore bought a whole
 * extra pass-1 + pass-2 over the same corpus whose result was immediately
 * thrown away and rebuilt.
 *
 * Measured on taxdome 2026-08-14 17:30 (`--force-enrichments codegraph
 * --languages typescript`): the repair leg ran pass-1 over 10,621 files and
 * pass-2 over all of them, reached ALL_COMPLETE at +225.0s having applied
 * payload to `matchedFiles: 0`, and the recompute leg then started its own
 * pass-1 from zero at +262s. The run's 330s guard killed it mid-second-cycle.
 *
 * Both legs converge on `EnrichmentExecutor#runFileBatch`, so counting
 * dispatches per path across one invocation counts cycles. A unit test on
 * either leg alone cannot see the duplication — it only exists in the wiring.
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
  } as unknown as EnrichmentProvider;
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
    releaseCollection: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as EnrichmentExecutor;
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

describe("--force-enrichments — one extraction cycle per provider (bd tea-rags-mcp-6aytq)", () => {
  let ingest: IngestFacade;
  let qdrant: MockQdrantManager;
  let config: IngestCodeConfig;
  let tempDir: string;
  let codebaseDir: string;

  beforeEach(async () => {
    extractedPaths.length = 0;
    persistedHashes.clear();
    ({ tempDir, codebaseDir } = await createTempTestDir());
    qdrant = new MockQdrantManager() as never;
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
    // One plain incremental so the store is populated and current: the repair
    // pass is only meaningful against a graph that already matches the code,
    // which is the state every real `--force-enrichments` run starts from.
    await ingest.indexCodebase(codebaseDir);
    extractedPaths.length = 0;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  it("dispatches each file for extraction exactly once", async () => {
    await ingest.indexCodebase(codebaseDir, { forceEnrichments: ["codegraph"] });

    expect(dispatchCounts()).toEqual(
      new Map([
        ["app.ts", 1],
        ["util.ts", 1],
      ]),
    );
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
