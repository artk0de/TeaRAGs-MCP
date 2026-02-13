/**
 * Regression test: enrichmentStatus should reflect actual completion state.
 *
 * Bug: enrichmentStatus was always "background" even when awaitCompletion
 * resolved before indexCodebase returned.
 *
 * Fix: track the enrichment promise and check if it resolved before returning.
 * If enrichment finished (small repos), report "completed".
 * If still running (large repos), report "background".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodeIndexer } from "../../../src/code/indexer.js";
import type { CodeConfig } from "../../../src/code/types.js";
import {
  cleanupTempDir,
  createTempTestDir,
  createTestFile,
  defaultTestConfig,
  MockEmbeddingProvider,
  MockQdrantManager,
} from "./test-helpers.js";

// --- Tree-sitter mocks (required for chunker) ---
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

// --- EnrichmentModule mock ---
// Fast enrichment: awaitCompletion resolves immediately (simulates small repo)
vi.mock("../../../src/code/indexer/enrichment-module.js", () => ({
  EnrichmentModule: class MockEnrichmentModule {
    prefetchGitLog = vi.fn();
    onChunksStored = vi.fn();
    startChunkChurn = vi.fn();
    awaitCompletion = vi.fn().mockResolvedValue({});
  },
}));

describe("Enrichment status detection", () => {
  let indexer: CodeIndexer;
  let qdrant: MockQdrantManager;
  let embeddings: MockEmbeddingProvider;
  let config: CodeConfig;
  let tempDir: string;
  let codebaseDir: string;

  beforeEach(async () => {
    ({ tempDir, codebaseDir } = await createTempTestDir());
    qdrant = new MockQdrantManager() as any;
    embeddings = new MockEmbeddingProvider();
    config = defaultTestConfig();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("should report 'completed' when enrichment finishes before return", async () => {
    config.enableGitMetadata = true;
    indexer = new CodeIndexer(qdrant as any, embeddings, config);

    await createTestFile(
      codebaseDir,
      "test.ts",
      // eslint-disable-next-line no-template-curly-in-string
      'export function hello(name: string): string {\n  console.log("Greeting user");\n  return `Hello, ${name}!`;\n}',
    );

    const stats = await indexer.indexCodebase(codebaseDir);

    // awaitCompletion resolves immediately (mock), so enrichment completes
    // before the snapshot save and indexing marker finish.
    // The status should reflect this.
    expect(stats.enrichmentStatus).toBe("completed");
  });

  it("should report 'background' when enrichment is still running", async () => {
    config.enableGitMetadata = true;

    // Replace mock with slow enrichment that never resolves before return
    const { EnrichmentModule } = await import("../../../src/code/indexer/enrichment-module.js");
    const slowEnrichment = new EnrichmentModule(qdrant as any);
    slowEnrichment.awaitCompletion = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves
    slowEnrichment.prefetchGitLog = vi.fn();
    slowEnrichment.onChunksStored = vi.fn();
    slowEnrichment.startChunkChurn = vi.fn();

    // Inject slow enrichment into the indexer
    indexer = new CodeIndexer(qdrant as any, embeddings, config);
    (indexer as any).enrichment = slowEnrichment;
    (indexer as any).indexing = new (await import("../../../src/code/indexer/indexing-module.js")).IndexingModule(
      qdrant,
      embeddings,
      config,
      slowEnrichment,
    );

    await createTestFile(
      codebaseDir,
      "test.ts",
      // eslint-disable-next-line no-template-curly-in-string
      'export function hello(name: string): string {\n  console.log("Greeting user");\n  return `Hello, ${name}!`;\n}',
    );

    const stats = await indexer.indexCodebase(codebaseDir);

    // awaitCompletion never resolves, so enrichment is still running
    expect(stats.enrichmentStatus).toBe("background");
  });

  /**
   * MANDATORY: Fire-and-forget contract test.
   *
   * Proves that indexCodebase does NOT await enrichment.awaitCompletion().
   * If this test breaks (times out), it means someone added `await` to
   * awaitCompletion — which would block indexing on large repos.
   *
   * The enrichment promise is deferred (never resolves during indexing),
   * yet indexCodebase must return promptly. After return, we resolve
   * the deferred to confirm the background .then() callback still fires.
   */
  it("MANDATORY: indexCodebase must not block on awaitCompletion (fire-and-forget)", async () => {
    config.enableGitMetadata = true;

    // Deferred promise: we control when awaitCompletion resolves
    let resolveEnrichment!: () => void;
    const enrichmentPromise = new Promise<void>((resolve) => {
      resolveEnrichment = resolve;
    });

    const { EnrichmentModule } = await import("../../../src/code/indexer/enrichment-module.js");
    const deferredEnrichment = new EnrichmentModule(qdrant as any);
    deferredEnrichment.awaitCompletion = vi.fn().mockReturnValue(enrichmentPromise);
    deferredEnrichment.prefetchGitLog = vi.fn();
    deferredEnrichment.onChunksStored = vi.fn();
    deferredEnrichment.startChunkChurn = vi.fn();

    indexer = new CodeIndexer(qdrant as any, embeddings, config);
    (indexer as any).enrichment = deferredEnrichment;
    (indexer as any).indexing = new (await import("../../../src/code/indexer/indexing-module.js")).IndexingModule(
      qdrant,
      embeddings,
      config,
      deferredEnrichment,
    );

    await createTestFile(codebaseDir, "test.ts", "export function compute(x: number): number {\n  return x * 2;\n}");

    // indexCodebase MUST return even though enrichment hasn't resolved.
    // If someone adds `await` to awaitCompletion, this will hang and timeout.
    const stats = await indexer.indexCodebase(codebaseDir);

    // Enrichment is still pending → status is "background"
    expect(stats.enrichmentStatus).toBe("background");
    expect(deferredEnrichment.awaitCompletion).toHaveBeenCalledOnce();

    // Now resolve the deferred — simulate enrichment finishing in background
    resolveEnrichment();
    // Flush microtask queue so .then() callback fires
    await new Promise((r) => setTimeout(r, 0));

    // The .then() callback on the fire-and-forget promise should have run.
    // We can't directly observe enrichmentDone (it's local), but we proved:
    // 1. indexCodebase returned BEFORE enrichment resolved (fire-and-forget)
    // 2. The background promise still resolves cleanly (no unhandled rejection)
  });
});
