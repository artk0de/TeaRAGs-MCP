/**
 * IndexingOps — which collection name the pre-reindex enrichment recovery is
 * handed on the incremental path.
 *
 * Recovery's codegraph leg opens the DuckDB file by the literal string it is
 * given (`GraphDbClientPool#acquireWrite` → `CodegraphDbFiles#pathFor`). Handed
 * the stable Qdrant ALIAS, it opens an empty shadow `<alias>.duckdb`, reads zero
 * symbols, and the applier still stamps `codegraph.symbols.chunk.enrichedAt` —
 * on taxdome that marked 52,205 live chunks enriched with no signals. Qdrant
 * resolves aliases server-side, so the physical name addresses the same points
 * for recovery's Qdrant/marker work (bd tea-rags-mcp-snbzk / 6goqa).
 */

import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { IndexingOps, type IndexingOpsDeps } from "../../../../../src/core/api/internal/ops/indexing-ops.js";
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

const REPO = "/repo";
const alias = resolveCollectionName(resolve(REPO));

function makeDeps(aliases: readonly { aliasName: string; collectionName: string }[]): IndexingOpsDeps {
  return {
    qdrant: {
      collectionExists: vi.fn().mockResolvedValue(true),
      aliases: { listAliases: vi.fn().mockResolvedValue(aliases) },
    } as never,
    embeddings: {
      embed: vi.fn().mockResolvedValue([0]),
      resolveModelInfo: vi.fn().mockResolvedValue(undefined),
    } as never,
    config: { chunkSize: 1000, userSetChunkSize: false } as never,
    indexing: { indexCodebase: vi.fn() } as never,
    reindex: { reindexChanges: vi.fn().mockResolvedValue(changeStats) } as never,
    enrichment: {
      setEnrichmentProgress: vi.fn(),
      whenComplete: vi.fn().mockResolvedValue(undefined),
      runRecovery: vi.fn().mockResolvedValue(undefined),
      recomputeEnrichments: vi.fn().mockResolvedValue(undefined),
    } as never,
    driftReporter: { reset: vi.fn() },
    snapshotDir: "/tmp/snap",
  };
}

describe("IndexingOps — pre-reindex recovery collection addressing", () => {
  it("hands recovery the PHYSICAL collection an alias points at, not the alias", async () => {
    const deps = makeDeps([{ aliasName: alias, collectionName: `${alias}_v7` }]);
    const ops = new IndexingOps(deps);

    await ops.run(REPO);

    expect(deps.enrichment.runRecovery).toHaveBeenCalledTimes(1);
    expect(deps.enrichment.runRecovery).toHaveBeenCalledWith(`${alias}_v7`, resolve(REPO));
    // Only recovery moves to the physical name: the alias-keyed consumers of the
    // incremental run keep addressing the alias.
    expect(deps.qdrant.collectionExists).toHaveBeenCalledWith(alias);
    expect(deps.driftReporter?.reset).toHaveBeenCalledWith(alias);
  });

  it("hands recovery the literal name when no alias points at it", async () => {
    const deps = makeDeps([{ aliasName: "code_other", collectionName: "code_other_v3" }]);
    const ops = new IndexingOps(deps);

    await ops.run(REPO);

    expect(deps.enrichment.runRecovery).toHaveBeenCalledWith(alias, resolve(REPO));
  });
});
