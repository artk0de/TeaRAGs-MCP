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

  it("records codegraphEnabled=false when indexed without codegraph deps", async () => {
    // The default IngestFacade wires no codegraph remover/lister, so the
    // pipeline indexes without the codegraph trajectory family. The registry
    // entry must reflect that — prime reads codegraphEnabled back to decide
    // whether to declare codegraph signal descriptors (registry-first parity
    // with embeddingBaseUrl).
    await createTestFile(codebaseDir, "cg.ts", "export const x = 1;");
    await ingest.indexCodebase(codebaseDir);
    const status = await ingest.getIndexStatus(codebaseDir);
    const collectionName = status.collectionName!;

    const entry = registry.get(collectionName);
    expect(entry).not.toBeNull();
    expect(entry!.codegraphEnabled).toBe(false);
  });

  it("records the 'embedded' sentinel as qdrantUrl when indexed against the embedded daemon (2nfdm)", async () => {
    // The embedded daemon binds an ephemeral port that can change on restart —
    // persisting the concrete URL goes stale on every daemon restart. The
    // entry must store the SENTINEL; consumers resolve it through daemon
    // discovery (daemon.port / spawn) at every run.
    Object.defineProperty(qdrant, "isEmbedded", { value: true, configurable: true });
    await createTestFile(codebaseDir, "emb.ts", "export const x = 1;");
    await ingest.indexCodebase(codebaseDir);
    const status = await ingest.getIndexStatus(codebaseDir);

    const entry = registry.get(status.collectionName!);
    expect(entry).not.toBeNull();
    expect(entry!.qdrantUrl).toBe("embedded");
    expect(entry!.qdrantEmbedded).toBe(true);
  });

  it("records qdrantEmbedded=false when indexed against an external Qdrant", async () => {
    Object.defineProperty(qdrant, "isEmbedded", { value: false, configurable: true });
    await createTestFile(codebaseDir, "ext.ts", "export const x = 1;");
    await ingest.indexCodebase(codebaseDir);
    const status = await ingest.getIndexStatus(codebaseDir);

    const entry = registry.get(status.collectionName!);
    expect(entry).not.toBeNull();
    expect(entry!.qdrantEmbedded).toBe(false);
  });

  it("records the INJECTED env snapshot verbatim into entry.env (9vpnz: full effective set)", async () => {
    // The bootstrap composition root builds the full effective env set from
    // the parsed config (defaults materialized) and injects it — the pipeline
    // never reads process.env itself. A CLI reindex in a fresh shell re-applies
    // the map registry-first instead of silently using code defaults.
    const envSnapshot = {
      GIT_ADAPTER: "es-git",
      TRAJECTORY_GIT_CHUNK_CONCURRENCY: "10",
      INGEST_TUNE_FILE_CONCURRENCY: "25",
    };
    const tunedIngest = new IngestFacade({
      qdrant: qdrant as any,
      embeddings,
      config,
      trajectoryConfig: defaultTrajectoryConfig(),
      collectionRegistry: registry,
      envSnapshot,
    });
    await createTestFile(codebaseDir, "tune.ts", "export const x = 1;");
    await tunedIngest.indexCodebase(codebaseDir);
    const status = await tunedIngest.getIndexStatus(codebaseDir);

    const entry = registry.get(status.collectionName!);
    expect(entry).not.toBeNull();
    expect(entry!.env).toEqual(envSnapshot);
  });

  it("omits entry.env when no snapshot is injected (direct construction without bootstrap)", async () => {
    // Production paths always compose through bootstrap/factory (snapshot
    // always present); a facade constructed without it must not fabricate one.
    await createTestFile(codebaseDir, "untuned.ts", "export const x = 1;");
    await ingest.indexCodebase(codebaseDir);
    const status = await ingest.getIndexStatus(codebaseDir);

    const entry = registry.get(status.collectionName!);
    expect(entry).not.toBeNull();
    expect(entry!.env).toBeUndefined();
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
