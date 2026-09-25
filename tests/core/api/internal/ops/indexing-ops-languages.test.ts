/**
 * IndexingOps — how the `languages` selector reaches each branch.
 *
 * Two different mechanisms, deliberately: the recompute passes the language
 * list straight to the coordinator (which filters the Qdrant scroll), while a
 * full reindex translates it into file extensions, because that is the filter
 * the scanner already understands. Getting the second one wrong is invisible in
 * a unit that only checks the first — the run would simply reindex everything.
 */

import { describe, expect, it, vi } from "vitest";

import { IndexingOps, type IndexingOpsDeps } from "../../../../../src/core/api/internal/ops/indexing-ops.js";
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

function makeDeps(overrides: Partial<IndexingOpsDeps> = {}): IndexingOpsDeps {
  return {
    qdrant: {
      collectionExists: vi.fn().mockResolvedValue(true),
      aliases: { listAliases: vi.fn().mockResolvedValue([]) },
      // The marker read a recompute makes for a pending worktree seed: none here.
      getPoint: vi.fn().mockResolvedValue(null),
      getPointOrThrow: vi.fn().mockResolvedValue(null),
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
    ...overrides,
  };
}

describe("IndexingOps — languages on the recompute branch", () => {
  it("hands the language list to the coordinator", async () => {
    const deps = makeDeps();
    await new IndexingOps(deps).run(process.cwd(), { forceEnrichments: ["git"], languages: ["ruby"] });

    const call = (deps.enrichment.recomputeEnrichments as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[2]).toEqual(["git"]);
    expect(call[3]).toEqual(["ruby"]);
  });

  it("passes undefined when no languages were requested", async () => {
    const deps = makeDeps();
    await new IndexingOps(deps).run(process.cwd(), { forceEnrichments: ["git"] });

    expect((deps.enrichment.recomputeEnrichments as ReturnType<typeof vi.fn>).mock.calls[0][3]).toBeUndefined();
  });
});

describe("IndexingOps — languages on the force branch", () => {
  // INVARIANT CHANGED (bd tea-rags-mcp-j4oww): `--force --languages` used to
  // build a NEW collection holding only those languages (the scanner's
  // extension filter). It is now a scoped force: the incremental pipeline
  // re-chunks the selected languages' files in place, every other point stays.
  const rechunkOf = (deps: IndexingOpsDeps) =>
    (deps.reindex.reindexChanges as ReturnType<typeof vi.fn>).mock.calls[0][2]?.rechunk;

  it("re-chunks the language's files in place instead of rebuilding the collection", async () => {
    const deps = makeDeps();
    await new IndexingOps(deps).run(process.cwd(), { forceReindex: true, languages: ["typescript"] });

    expect(deps.indexing.indexCodebase).not.toHaveBeenCalled();
    expect(rechunkOf(deps)).toEqual({ languages: ["typescript"] });
  });

  it("selects the files of several languages in one run", async () => {
    const deps = makeDeps();
    await new IndexingOps(deps).run(process.cwd(), { forceReindex: true, languages: ["typescript", "ruby"] });

    expect(deps.indexing.indexCodebase).not.toHaveBeenCalled();
    expect(rechunkOf(deps)).toEqual({ languages: ["typescript", "ruby"] });
  });

  it("leaves extensions alone when no languages were requested", async () => {
    // A plain force reindex must keep indexing everything.
    const deps = makeDeps();
    await new IndexingOps(deps).run(process.cwd(), { forceReindex: true });

    const passedOptions = (deps.indexing.indexCodebase as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(passedOptions?.extensions).toBeUndefined();
  });

  it("intersects with an explicit extension list rather than overriding it", async () => {
    // Both filters are restrictions; honouring only one would silently widen
    // the run past what the caller asked for. The selector is a conjunction, so
    // carrying both keeps the intersection.
    const deps = makeDeps();
    await new IndexingOps(deps).run(process.cwd(), {
      forceReindex: true,
      languages: ["typescript"],
      extensions: [".ts"],
    });

    expect(rechunkOf(deps)).toEqual({ languages: ["typescript"], fileExtensions: [".ts"] });
  });
});
