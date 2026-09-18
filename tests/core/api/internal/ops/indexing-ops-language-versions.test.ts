/**
 * IndexingOps — when the per-language code-version stamp advances
 * (bd tea-rags-mcp-frwka).
 *
 * The stamp is a claim that the indexed data was produced by THIS build, so it
 * may only advance for the layer the run actually rebuilt. A plain incremental
 * rebuilds nothing corpus-wide, so it must leave the stamp alone — advancing it
 * there is the failure mode that matters, because auto-update fires an
 * incremental on its own and would silently clear the hint.
 */

import { describe, expect, it, vi } from "vitest";

import { IndexingOps, type IndexingOpsDeps } from "../../../../../src/core/api/internal/ops/indexing-ops.js";
import type { LanguageCodeVersions } from "../../../../../src/core/contracts/types/language.js";
import { resolveCollectionName } from "../../../../../src/core/infra/collection-name.js";
import type { ChangeStats } from "../../../../../src/core/types.js";

const changeStats: ChangeStats = {
  filesAdded: 0,
  filesModified: 0,
  filesDeleted: 0,
  filesNewlyIgnored: 0,
  filesNewlyUnignored: 0,
  filesRetried: 0,
  chunksAdded: 0,
  chunksDeleted: 0,
  durationMs: 5,
  status: "completed",
};

const languageCodeVersions = new Map<string, LanguageCodeVersions>([
  ["typescript", { grammar: "0.23.2", chunking: 1, walker: 2, codegraphSchema: 1 }],
  ["ruby", { grammar: "0.23.1", chunking: 1, walker: 1, codegraphSchema: 1 }],
]);

function makeDeps(overrides: Partial<IndexingOpsDeps> = {}): IndexingOpsDeps {
  return {
    qdrant: {
      collectionExists: vi.fn().mockResolvedValue(true),
      aliases: { listAliases: vi.fn().mockResolvedValue([]) },
    } as never,
    embeddings: {
      embed: vi.fn().mockResolvedValue([0]),
      resolveModelInfo: vi.fn().mockResolvedValue(undefined),
    } as never,
    config: { chunkSize: 1000, userSetChunkSize: false } as never,
    indexing: { indexCodebase: vi.fn().mockResolvedValue({ status: "completed" }) } as never,
    reindex: { reindexChanges: vi.fn().mockResolvedValue(changeStats) } as never,
    enrichment: {
      setEnrichmentProgress: vi.fn(),
      whenComplete: vi.fn().mockResolvedValue(undefined),
      whenCompletionsSettled: vi.fn().mockResolvedValue(undefined),
      runRecovery: vi.fn().mockResolvedValue(undefined),
      recomputeEnrichments: vi.fn().mockResolvedValue(undefined),
    } as never,
    snapshotDir: "/tmp/snap",
    languageCodeVersions,
    ...overrides,
  };
}

function makeRegistry() {
  return { stampLanguageVersions: vi.fn() };
}

const collection = resolveCollectionName(process.cwd());

describe("IndexingOps — language version stamping", () => {
  it("stamps every axis after a full reindex", async () => {
    const collectionRegistry = makeRegistry();
    const ops = new IndexingOps(makeDeps({ collectionRegistry }));

    await ops.run(process.cwd(), { forceReindex: true });

    expect(collectionRegistry.stampLanguageVersions).toHaveBeenCalledWith(collection, {
      typescript: { grammar: "0.23.2", chunking: 1, walker: 2, codegraphSchema: 1 },
      ruby: { grammar: "0.23.1", chunking: 1, walker: 1, codegraphSchema: 1 },
    });
  });

  it("stamps every axis on a first index", async () => {
    const collectionRegistry = makeRegistry();
    const deps = makeDeps({
      collectionRegistry,
      qdrant: {
        collectionExists: vi.fn().mockResolvedValue(false),
        aliases: { listAliases: vi.fn().mockResolvedValue([]) },
      } as never,
    });

    await new IndexingOps(deps).run(process.cwd());

    expect(collectionRegistry.stampLanguageVersions).toHaveBeenCalledTimes(1);
  });

  it("stamps only the codegraph axes after a codegraph enrichment recompute", async () => {
    const collectionRegistry = makeRegistry();
    const ops = new IndexingOps(makeDeps({ collectionRegistry }));

    await ops.run(process.cwd(), { forceEnrichments: ["codegraph"] });

    expect(collectionRegistry.stampLanguageVersions).toHaveBeenCalledWith(collection, {
      typescript: { walker: 2, codegraphSchema: 1 },
      ruby: { walker: 1, codegraphSchema: 1 },
    });
  });

  it("narrows the stamp to the requested languages", async () => {
    const collectionRegistry = makeRegistry();
    const ops = new IndexingOps(makeDeps({ collectionRegistry }));

    await ops.run(process.cwd(), { forceEnrichments: ["codegraph"], languages: ["typescript"] });

    expect(collectionRegistry.stampLanguageVersions).toHaveBeenCalledWith(collection, {
      typescript: { walker: 2, codegraphSchema: 1 },
    });
  });

  it("leaves the stamp alone after a git-only recompute — no language layer was rebuilt", async () => {
    const collectionRegistry = makeRegistry();
    const ops = new IndexingOps(makeDeps({ collectionRegistry }));

    await ops.run(process.cwd(), { forceEnrichments: ["git"] });

    expect(collectionRegistry.stampLanguageVersions).not.toHaveBeenCalled();
  });

  it("leaves the stamp alone on a plain incremental — nothing was rebuilt corpus-wide", async () => {
    const collectionRegistry = makeRegistry();
    const deps = makeDeps({
      collectionRegistry,
      reindex: { reindexChanges: vi.fn().mockResolvedValue(changeStats) } as never,
    });

    await new IndexingOps(deps).run(process.cwd());

    expect(collectionRegistry.stampLanguageVersions).not.toHaveBeenCalled();
  });

  it("runs without a registry wired", async () => {
    const ops = new IndexingOps(makeDeps());

    await expect(ops.run(process.cwd(), { forceReindex: true })).resolves.toBeDefined();
  });
});
