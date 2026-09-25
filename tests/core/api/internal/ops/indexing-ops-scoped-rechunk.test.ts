/**
 * IndexingOps — scoped force (bd tea-rags-mcp-j4oww).
 *
 * `forceReindex` plus a file filter runs the INCREMENTAL pipeline with the
 * selection forced into its work set — never the full rebuild — and on success
 * advances exactly the chunk-set stamps whose pending bumps the selection
 * covered. A partial run claims nothing.
 */

import { describe, expect, it, vi } from "vitest";

import { IndexingOps, type IndexingOpsDeps } from "../../../../../src/core/api/internal/ops/indexing-ops.js";
import type { LanguageCodeVersions } from "../../../../../src/core/contracts/types/language.js";
import type { ChunkSetBumpScopes } from "../../../../../src/core/contracts/types/rechunk.js";
import { resolveCollectionName } from "../../../../../src/core/infra/collection-name.js";
import type { ChangeStats } from "../../../../../src/core/types.js";

const completed: ChangeStats = {
  filesAdded: 0,
  filesModified: 3,
  filesDeleted: 0,
  filesNewlyIgnored: 0,
  filesNewlyUnignored: 0,
  filesRetried: 0,
  chunksAdded: 9,
  chunksDeleted: 7,
  durationMs: 5,
  status: "completed",
  filesRechunked: 3,
};

const languageCodeVersions = new Map<string, LanguageCodeVersions>([
  ["typescript", { grammar: "0.23.2", chunking: 2, walker: 2, codegraphSchema: 1 }],
  ["ruby", { grammar: "0.23.1", chunking: 2, walker: 1, codegraphSchema: 1 }],
]);

const scopes = new Map<string, ChunkSetBumpScopes>([
  ["typescript", { chunking: { 2: { testFile: "only" } } }],
  ["ruby", { chunking: { 2: { testFile: "only" } } }],
]);

const stampedAtOne = {
  typescript: { grammar: "0.23.2", chunking: 1, walker: 2, codegraphSchema: 1 },
  ruby: { grammar: "0.23.1", chunking: 1, walker: 1, codegraphSchema: 1 },
};

function makeDeps(overrides: Partial<IndexingOpsDeps> = {}, reindexResult: ChangeStats = completed): IndexingOpsDeps {
  return {
    qdrant: {
      collectionExists: vi.fn().mockResolvedValue(true),
      aliases: { listAliases: vi.fn().mockResolvedValue([]) },
      getPoint: vi.fn().mockResolvedValue(null),
      getPointOrThrow: vi.fn().mockResolvedValue(null),
    } as never,
    embeddings: {
      embed: vi.fn().mockResolvedValue([0]),
      resolveModelInfo: vi.fn().mockResolvedValue(undefined),
    } as never,
    config: { chunkSize: 1000, userSetChunkSize: false } as never,
    indexing: { indexCodebase: vi.fn().mockResolvedValue({ status: "completed" }) } as never,
    reindex: { reindexChanges: vi.fn().mockResolvedValue(reindexResult) } as never,
    enrichment: {
      setEnrichmentProgress: vi.fn(),
      whenComplete: vi.fn().mockResolvedValue(undefined),
      whenCompletionsSettled: vi.fn().mockResolvedValue(undefined),
      runRecovery: vi.fn().mockResolvedValue(undefined),
      recomputeEnrichments: vi.fn().mockResolvedValue(undefined),
    } as never,
    snapshotDir: "/tmp/snap",
    languageCodeVersions,
    languageChunkSetBumpScopes: scopes,
    ...overrides,
  };
}

function makeRegistry() {
  return {
    stampLanguageVersions: vi.fn(),
    get: vi.fn().mockReturnValue({ languageVersions: stampedAtOne }),
  };
}

const collection = resolveCollectionName(process.cwd());

describe("IndexingOps — scoped force", () => {
  it("runs the incremental pipeline with the selection, never the full rebuild", async () => {
    const deps = makeDeps();
    const ops = new IndexingOps(deps);

    const stats = await ops.run(process.cwd(), { forceReindex: true, testFile: "only", languages: ["ruby"] });

    expect(deps.indexing.indexCodebase).not.toHaveBeenCalled();
    expect(deps.reindex.reindexChanges).toHaveBeenCalledWith(
      process.cwd(),
      undefined,
      expect.objectContaining({ rechunk: { testFile: "only", languages: ["ruby"] } }),
    );
    expect(stats.changeDetails?.filesRechunked).toBe(3);
  });

  it("keeps a bare forceReindex on the full rebuild", async () => {
    const deps = makeDeps();

    await new IndexingOps(deps).run(process.cwd(), { forceReindex: true });

    expect(deps.indexing.indexCodebase).toHaveBeenCalled();
  });

  it("advances the chunking stamp of every language whose pending scoped bump the selection covered", async () => {
    const collectionRegistry = makeRegistry();
    const ops = new IndexingOps(makeDeps({ collectionRegistry }));

    await ops.run(process.cwd(), { forceReindex: true, testFile: "only", languages: ["ruby"] });

    expect(collectionRegistry.stampLanguageVersions).toHaveBeenCalledWith(collection, { ruby: { chunking: 2 } });
  });

  it("advances nothing when the selection is narrower than the pending bump", async () => {
    const collectionRegistry = makeRegistry();
    const ops = new IndexingOps(makeDeps({ collectionRegistry }));

    await ops.run(process.cwd(), { forceReindex: true, testFile: "only", pathPattern: "spec/models/**" });

    expect(collectionRegistry.stampLanguageVersions).not.toHaveBeenCalled();
  });

  it("claims nothing after a partial run — some selected files kept their old chunks", async () => {
    const collectionRegistry = makeRegistry();
    const ops = new IndexingOps(makeDeps({ collectionRegistry }, { ...completed, status: "partial" }));

    await ops.run(process.cwd(), { forceReindex: true, testFile: "only" });

    expect(collectionRegistry.stampLanguageVersions).not.toHaveBeenCalled();
  });

  it("re-arms the drift report after the stamp moved", async () => {
    const driftReporter = { reset: vi.fn() };
    const collectionRegistry = makeRegistry();
    const ops = new IndexingOps(makeDeps({ collectionRegistry, driftReporter }));

    await ops.run(process.cwd(), { forceReindex: true, testFile: "only" });

    expect(driftReporter.reset).toHaveBeenCalledWith(collection);
    expect(collectionRegistry.stampLanguageVersions.mock.invocationCallOrder[0]).toBeLessThan(
      driftReporter.reset.mock.invocationCallOrder[0],
    );
  });
});
