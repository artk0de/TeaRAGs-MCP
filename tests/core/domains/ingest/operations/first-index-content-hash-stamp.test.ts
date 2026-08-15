/**
 * A first index (and a `--force` rebuild) must stamp the run's REAL content
 * hashes onto the provider's per-file rows (bd tea-rags-mcp-o317j).
 *
 * The codegraph repair pass decides drift by diffing the synchronizer's current
 * file hashes against the hash each row was stamped with on the previous run.
 * Only the incremental path ever supplied those hashes: `runRepairPass` set
 * `EnrichmentCoordinator#runContentHashes`, and `beginRun` handed it to the file
 * phase. First-index and `--force` run the streaming path with no hash map at
 * all, so every row was written with a NULL hash — and the NEXT run then read
 * `hash ≠ persisted` for EVERY file and re-extracted the whole corpus.
 *
 * Measured on taxdome (path matrix, 2026-08-15): a full redundant pass-1 +
 * pass-2 + flush cycle, ~128s, on the first run after a `--force`. On the
 * 296-file fixture the same matrix showed `repaired: 296` where a converged
 * store shows a clean single cycle.
 *
 * The graph data itself was never wrong — only the hash column was empty, which
 * is why a green suite and a healthy index both missed it.
 *
 * Driven through `IngestFacade` because the defect lives in the WIRING: each
 * layer (synchronizer, coordinator, file phase, provider) behaves correctly on
 * its own, and only the composed run shows that nobody hands the map over. The
 * recording executor stands in for the codegraph provider's write path: it
 * remembers whichever dispatch carried the run's hashes and stamps them onto
 * the rows at the finalize (pass-2) seam, exactly where `graph-finalizer` does.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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

/** Every path dispatched for extraction since the last reset, in order. */
const extractedPaths: string[] = [];
/** Paths extracted in the CURRENT run, awaiting the run's pass-2 write. */
const pendingRows = new Set<string>();
/**
 * The provider's `cg_symbols_files` rows: relPath → the stamped content hash,
 * `null` for a row written without one. `null` is the shape the repair check
 * reads as "unknown, re-extract", so it must be modelled, not omitted.
 */
const persistedRows = new Map<string, string | null>();
/**
 * The run's hash map as the provider would hold it in `runState.contentHashes`
 * — assigned by whichever dispatch carried it, read at pass-2.
 */
let runContentHashes: ReadonlyMap<string, string> | undefined;

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
    finalizeSignals: vi.fn().mockResolvedValue(new Map()),
    // Declaring the extraction seams is what makes the pipeline run its
    // CROSS-PASS shape (`acceptsExtractions()` → `crossPassExtractionEnabled`),
    // which is the shape a real first index with codegraph on actually takes.
    acceptExtraction: vi.fn(),
    beginExtractionRun: vi.fn(),
    endExtractionRun: vi.fn().mockResolvedValue(undefined),
    readPersistedFileHashes: vi.fn(async () => new Map<string, string | null>(persistedRows)),
    handleDeletedPaths: vi.fn().mockResolvedValue(undefined),
  } as unknown as EnrichmentProvider;
}

/**
 * Stands in for the codegraph write path. Extraction only queues a file; the
 * row — and its hash stamp — is written at the finalize seam, which is where
 * `graph-finalizer` buffers `{ relPath, language, contentHash }` during pass-2.
 */
function recordingExecutor(): EnrichmentExecutor {
  return {
    runFileBatch: vi.fn(
      async (_provider, _root, paths: string[], options?: { contentHashes?: ReadonlyMap<string, string> }) => {
        extractedPaths.push(...paths);
        for (const path of paths) pendingRows.add(path);
        if (options?.contentHashes) runContentHashes = options.contentHashes;
        return new Map();
      },
    ),
    runFileSignalsRecovery: vi.fn().mockResolvedValue(new Map()),
    runChunkBatch: vi.fn().mockResolvedValue(new Map()),
    runFinalize: vi.fn(async (_provider, _root, options?: { contentHashes?: ReadonlyMap<string, string> }) => {
      if (options?.contentHashes) runContentHashes = options.contentHashes;
      for (const path of pendingRows) persistedRows.set(path, runContentHashes?.get(path) ?? null);
      pendingRows.clear();
      runContentHashes = undefined;
      return new Map();
    }),
    releaseCollection: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as EnrichmentExecutor;
}

/** A file big enough for the chunker to emit points for. */
function sourceOf(name: string): string {
  return Array.from({ length: 60 }, (_, i) => `export const ${name}Value${i} = ${i};`).join("\n");
}

function sha256Of(dir: string, relPath: string): string {
  return createHash("sha256")
    .update(readFileSync(join(dir, relPath), "utf-8"))
    .digest("hex");
}

describe("first index / --force stamps real content hashes (bd tea-rags-mcp-o317j)", () => {
  let ingest: IngestFacade;
  let qdrant: MockQdrantManager;
  let config: IngestCodeConfig;
  let tempDir: string;
  let codebaseDir: string;

  beforeEach(async () => {
    extractedPaths.length = 0;
    pendingRows.clear();
    persistedRows.clear();
    runContentHashes = undefined;
    ({ tempDir, codebaseDir } = await createTempTestDir());
    qdrant = new MockQdrantManager() as never;
    config = { ...defaultTestConfig(), supportedExtensions: [".ts", ".rb"] };
    ingest = new IngestFacade({
      qdrant: qdrant as never,
      embeddings: new MockEmbeddingProvider(),
      config,
      trajectoryConfig: defaultTrajectoryConfig(),
      enrichmentProviders: [graphProvider()],
      enrichmentExecutor: recordingExecutor(),
    } as never);

    await createTestFile(codebaseDir, "app.ts", sourceOf("app"));
    await createTestFile(codebaseDir, "widget.rb", `# widget\n${sourceOf("widget")}`);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  it("stamps every persisted row with the synchronizer's own SHA256", async () => {
    await ingest.indexCodebase(codebaseDir);

    expect(persistedRows).toEqual(
      new Map([
        ["app.ts", sha256Of(codebaseDir, "app.ts")],
        ["widget.rb", sha256Of(codebaseDir, "widget.rb")],
      ]),
    );
  });

  it("leaves the next incremental nothing to repair", async () => {
    await ingest.indexCodebase(codebaseDir);
    extractedPaths.length = 0;

    await ingest.indexCodebase(codebaseDir);

    expect(extractedPaths).toEqual([]);
  });

  it("leaves the next incremental nothing to repair after a --force rebuild", async () => {
    await ingest.indexCodebase(codebaseDir);
    await ingest.indexCodebase(codebaseDir, { forceReindex: true });
    extractedPaths.length = 0;

    await ingest.indexCodebase(codebaseDir);

    expect(extractedPaths).toEqual([]);
  });

  it("still repairs a file whose content changed after the index", async () => {
    // The control: a stamp that matched everything unconditionally would satisfy
    // the assertions above while disabling drift detection entirely.
    await ingest.indexCodebase(codebaseDir);
    await createTestFile(codebaseDir, "app.ts", sourceOf("appEdited"));
    extractedPaths.length = 0;

    await ingest.indexCodebase(codebaseDir);

    expect([...new Set(extractedPaths)]).toEqual(["app.ts"]);
  });
});
