/**
 * BaseIndexingPipeline.finalizeProcessing — registry write contract.
 *
 * Verifies that after a successful indexing run, the pipeline records a full
 * CollectionEntry in CollectionRegistry (T14 of the Project Registry epic).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { CollectionRegistry } from "../../../../../src/core/infra/registry/collection-registry.js";
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
vi.mock("tree-sitter-rust", () => ({ default: {} }));
vi.mock("tree-sitter-typescript", () => ({
  default: { typescript: {}, tsx: {} },
}));

describe("BaseIndexingPipeline.finalizeProcessing — registry write", () => {
  let ingest: IngestFacade;
  let qdrant: MockQdrantManager;
  let embeddings: MockEmbeddingProvider;
  let config: IngestCodeConfig;
  let tempDir: string;
  let codebaseDir: string;
  let registryDir: string;
  let registry: CollectionRegistry;

  beforeEach(async () => {
    ({ tempDir, codebaseDir } = await createTempTestDir());
    registryDir = mkdtempSync(join(tmpdir(), "tea-rags-registry-"));
    registry = new CollectionRegistry(registryDir);
    qdrant = new MockQdrantManager() as any;
    Object.defineProperty(qdrant, "url", { value: "http://localhost:6333", configurable: true });
    embeddings = new MockEmbeddingProvider();
    config = defaultTestConfig();
    ingest = new IngestFacade({
      qdrant: qdrant as any,
      embeddings,
      config,
      trajectoryConfig: defaultTrajectoryConfig(),
      collectionRegistry: registry,
    });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
    rmSync(registryDir, { recursive: true, force: true });
  });

  it("records a CollectionEntry with embeddingModel, qdrantUrl, chunksCount and indexedAt after indexing", async () => {
    await createTestFile(
      codebaseDir,
      "test.ts",
      "export const APP_CONFIG = {\n  port: 3000,\n  host: 'localhost',\n  debug: true,\n  apiUrl: 'https://api.example.com',\n  timeout: 5000\n};\nconsole.log('Config loaded');",
    );
    const stats = await ingest.indexCodebase(codebaseDir);
    expect(stats.filesScanned).toBeGreaterThan(0);

    const status = await ingest.getIndexStatus(codebaseDir);
    expect(status.collectionName).toBeDefined();
    const collectionName = status.collectionName!;

    const entry = registry.get(collectionName);
    expect(entry).not.toBeNull();
    expect(entry!.collectionName).toBe(collectionName);
    // validatePath canonicalises (macOS resolves /var -> /private/var); accept either form
    expect(entry!.path.endsWith(codebaseDir) || codebaseDir.endsWith(entry!.path)).toBe(true);
    expect(entry!.name).toBeNull();
    expect(entry!.embeddingModel).toBe(embeddings.getModel());
    expect(entry!.embeddingDimensions).toBe(embeddings.getDimensions());
    expect(entry!.qdrantUrl).toBe("http://localhost:6333");
    expect(entry!.chunksCount).toBeGreaterThanOrEqual(0);
    expect(entry!.indexedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry!.teaRagsVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("preserves sticky name on reindex of same collection", async () => {
    await createTestFile(codebaseDir, "a.ts", "export const x = 1;");
    await ingest.indexCodebase(codebaseDir);
    const status = await ingest.getIndexStatus(codebaseDir);
    const collectionName = status.collectionName!;

    registry.setName(collectionName, "my-project");
    expect(registry.get(collectionName)?.name).toBe("my-project");

    await createTestFile(codebaseDir, "b.ts", "export const y = 2;");
    await ingest.indexCodebase(codebaseDir);

    const entry = registry.get(collectionName);
    expect(entry?.name).toBe("my-project");
  });
});
