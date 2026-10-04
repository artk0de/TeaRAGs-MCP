/**
 * Every index-run completion path reaches a provider's whole-collection work
 * (bd tea-rags-mcp-l1ot.2).
 *
 * Codegraph rebuilds its co-change sub-graph (`cg_temporal_*`) at collection
 * completion, and always through ONE seam — `EnrichmentProvider#completeCollection`
 * on the main-thread instance. A run that opens an enrichment run asks it once
 * its completion sequence settled, i.e. after the provider's finalize
 * (`EnrichmentExecutor#runFinalize`) — never from inside that finalize, which
 * executes in the enrichment worker beside the whole-project `ts.Program` (bd
 * tea-rags-mcp-vtuu4: the co-change build on top of it ran a 17k-file worker out
 * of heap). A run that takes one of `ReindexPipeline#reindexChanges`'s early
 * returns — only deletions, or nothing to chunk — opens no run, and used to
 * reach nothing: live on a clone of pixelclocktiles, a committed `git rm` left
 * the deleted file's 78 pairs and the old HEAD in `cg_temporal_meta`. Such a
 * run asks the same seam directly.
 *
 * The contract pinned here, per path: the collection-completion work runs
 * exactly once per run, after that run's finalize when it has one — a run
 * whose repair finalize completed the collection is not followed by a second
 * ask.
 *
 * MCP `index_codebase` and the auto-updater both enter through
 * `App.indexCodebase` → `IngestFacade#indexCodebase`, the entry every case below
 * drives.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

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
import { warmChunkerPoolFactory } from "../__helpers__/warm-chunker-pool.js";
import { IngestFacade } from "../../../../../src/core/api/index.js";
import type { EnrichmentExecutor } from "../../../../../src/core/contracts/types/enrichment-executor.js";
import type { EnrichmentProvider } from "../../../../../src/core/contracts/types/provider.js";

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

const GRAPH_KEY = "codegraph.symbols";

/** The graph provider's finalizes and collection completions, in order. */
const completions: ("finalize" | "completeCollection")[] = [];
/** What the fake graph store "persisted": content hashes of the last extraction, like the real rows. */
const persistedHashes = new Map<string, string>();

function baseProvider(key: string): EnrichmentProvider {
  return {
    key,
    signals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
    resolveRoot: (p: string) => p,
    buildFileSignals: vi.fn().mockResolvedValue(new Map()),
    buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
  };
}

function graphProvider(): EnrichmentProvider {
  return {
    ...baseProvider(GRAPH_KEY),
    streamFileBatch: vi.fn().mockResolvedValue(new Map()),
    finalizeSignals: vi.fn().mockResolvedValue(new Map()),
    readPersistedFileHashes: vi.fn(async () => new Map<string, string | null>(persistedHashes)),
    handleDeletedPaths: vi.fn(async (paths: string[]) => {
      for (const path of paths) persistedHashes.delete(path);
    }),
    completeCollection: vi.fn(async () => {
      completions.push("completeCollection");
    }),
  };
}

function recordingExecutor(): EnrichmentExecutor {
  return {
    runFileBatch: vi.fn(
      async (_provider, _root, paths: string[], options?: { contentHashes?: ReadonlyMap<string, string> }) => {
        for (const path of paths) {
          const hash = options?.contentHashes?.get(path);
          if (hash) persistedHashes.set(path, hash);
        }
        return new Map();
      },
    ),
    runFileSignalsRecovery: vi.fn().mockResolvedValue(new Map()),
    runChunkBatch: vi.fn().mockResolvedValue(new Map()),
    runFinalize: vi.fn(async (provider: EnrichmentProvider) => {
      if (provider.key === GRAPH_KEY) completions.push("finalize");
      return new Map();
    }),
    releaseRun: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

/** A file big enough for the chunker to emit points for. */
function sourceOf(name: string): string {
  return Array.from({ length: 60 }, (_, i) => `export const ${name}Value${i} = ${i};`).join("\n");
}

describe("collection completion on every index-run path (bd tea-rags-mcp-l1ot.2)", () => {
  let ingest: IngestFacade;
  let tempDir: string;
  let codebaseDir: string;

  /** Run one index call to the end of its enrichment and return the completions it caused. */
  async function completionsOf(run: () => Promise<unknown>): Promise<string[]> {
    completions.length = 0;
    await run();
    await ingest.whenEnrichmentComplete();
    return [...completions];
  }

  beforeEach(async () => {
    completions.length = 0;
    persistedHashes.clear();
    ({ tempDir, codebaseDir } = await createTempTestDir());
    ingest = new IngestFacade({
      qdrant: new MockQdrantManager() as never,
      embeddings: new MockEmbeddingProvider(),
      config: { ...defaultTestConfig(), supportedExtensions: [".ts"] },
      trajectoryConfig: defaultTrajectoryConfig(),
      createChunkerPool: warmChunkerPoolFactory,
      enrichmentProviders: [baseProvider("git"), graphProvider()],
      enrichmentExecutor: recordingExecutor(),
    } as never);
    await createTestFile(codebaseDir, "app.ts", sourceOf("app"));
    await createTestFile(codebaseDir, "util.ts", sourceOf("util"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  /** First index, then one plain incremental so the fake store is current. */
  async function indexed(): Promise<void> {
    await ingest.indexCodebase(codebaseDir);
    await ingest.whenEnrichmentComplete();
    await ingest.indexCodebase(codebaseDir);
    await ingest.whenEnrichmentComplete();
  }

  it("first index — once, after the finalize", async () => {
    expect(await completionsOf(async () => ingest.indexCodebase(codebaseDir))).toEqual([
      "finalize",
      "completeCollection",
    ]);
  });

  it("--force — once, after the finalize", async () => {
    await indexed();
    expect(await completionsOf(async () => ingest.indexCodebase(codebaseDir, { forceReindex: true }))).toEqual([
      "finalize",
      "completeCollection",
    ]);
  });

  it("incremental with a changed file — once, after the finalize", async () => {
    await indexed();
    await createTestFile(codebaseDir, "util.ts", sourceOf("changed"));
    expect(await completionsOf(async () => ingest.indexCodebase(codebaseDir))).toEqual([
      "finalize",
      "completeCollection",
    ]);
  });

  it("incremental delete-only — through completeCollection", async () => {
    await indexed();
    await fs.unlink(join(codebaseDir, "util.ts"));
    expect(await completionsOf(async () => ingest.indexCodebase(codebaseDir))).toEqual(["completeCollection"]);
  });

  it("incremental with no file change (HEAD may still have moved) — through completeCollection", async () => {
    await indexed();
    expect(await completionsOf(async () => ingest.indexCodebase(codebaseDir))).toEqual(["completeCollection"]);
  });

  it("incremental whose drift repair finalized — once, after that finalize, not a second ask", async () => {
    await indexed();
    persistedHashes.set("util.ts", "drifted");
    expect(await completionsOf(async () => ingest.indexCodebase(codebaseDir))).toEqual([
      "finalize",
      "completeCollection",
    ]);
  });

  it("--force-enrichments of the graph provider — sync leg asks, the recompute completes after its finalize", async () => {
    await indexed();
    expect(
      await completionsOf(async () => ingest.indexCodebase(codebaseDir, { forceEnrichments: ["codegraph"] })),
    ).toEqual(["completeCollection", "finalize", "completeCollection"]);
  });

  it("--force-enrichments of another provider only — the sync leg still asks the graph provider", async () => {
    await indexed();
    expect(await completionsOf(async () => ingest.indexCodebase(codebaseDir, { forceEnrichments: ["git"] }))).toEqual([
      "completeCollection",
    ]);
  });

  it("scoped --force selecting files — once, after the finalize of the in-place re-chunk", async () => {
    await indexed();
    expect(
      await completionsOf(async () => ingest.indexCodebase(codebaseDir, { forceReindex: true, pathPattern: "app.ts" })),
    ).toEqual(["finalize", "completeCollection"]);
  });

  it("scoped --force selecting nothing — through completeCollection", async () => {
    await indexed();
    expect(
      await completionsOf(async () => ingest.indexCodebase(codebaseDir, { forceReindex: true, testFile: "only" })),
    ).toEqual(["completeCollection"]);
  });
});
