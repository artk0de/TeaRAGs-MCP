import { describe, expect, it, vi } from "vitest";

import type { QdrantManager } from "../../../../../src/core/adapters/qdrant/client.js";
import {
  cleanupOrphanedVersions,
  discardFailedCollectionBuild,
  sweepCodegraphOrphans,
} from "../../../../../src/core/domains/ingest/infra/alias-cleanup.js";

function createMockQdrant(
  aliases: { aliasName: string; collectionName: string }[],
  collections: string[],
  /** collectionName → its `__indexing_metadata__` payload; absent ⇒ no marker. */
  markers: Record<string, Record<string, unknown>> = {},
) {
  return {
    aliases: {
      listAliases: vi.fn().mockResolvedValue(aliases),
    },
    listCollections: vi.fn().mockResolvedValue(collections),
    collectionExists: vi.fn().mockImplementation(async (name: string) => collections.includes(name)),
    deleteCollection: vi.fn().mockResolvedValue(undefined),
    getPoint: vi
      .fn()
      .mockImplementation(async (collection: string) =>
        Promise.resolve(markers[collection] ? { payload: markers[collection] } : null),
      ),
  } as unknown as QdrantManager;
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60 * 1000).toISOString();

describe("cleanupOrphanedVersions", () => {
  it("deletes versioned collections not pointed to by alias", async () => {
    const qdrant = createMockQdrant(
      [{ aliasName: "code_abc", collectionName: "code_abc_v2" }],
      ["code_abc_v1", "code_abc_v2", "code_abc_v3"],
    );

    const result = await cleanupOrphanedVersions(qdrant, "code_abc");

    expect(result).toBe(2);
    expect(qdrant.deleteCollection).toHaveBeenCalledWith("code_abc_v1");
    expect(qdrant.deleteCollection).toHaveBeenCalledWith("code_abc_v3");
    expect(qdrant.deleteCollection).not.toHaveBeenCalledWith("code_abc_v2");
  });

  // A versioned collection is not an orphan just because the alias does not
  // point at it yet — that is exactly what a force reindex is building. Deleting
  // it kills the run that owns it: the foreground reindex dies on its next
  // upload with "Collection <base>_v60 doesn't exist" while the background
  // auto-update run that deleted it reports success (bd tea-rags-mcp-nrylk).
  it("spares a versioned collection an indexing run is still building", async () => {
    const qdrant = createMockQdrant(
      [{ aliasName: "code_abc", collectionName: "code_abc_v2" }],
      ["code_abc_v1", "code_abc_v2", "code_abc_v3"],
      { code_abc_v3: { indexingComplete: false, startedAt: minutesAgo(2), lastHeartbeat: minutesAgo(1) } },
    );

    const result = await cleanupOrphanedVersions(qdrant, "code_abc");

    expect(qdrant.deleteCollection).not.toHaveBeenCalledWith("code_abc_v3");
    // The genuinely abandoned one still goes.
    expect(qdrant.deleteCollection).toHaveBeenCalledWith("code_abc_v1");
    expect(result).toBe(1);
  });

  it("reclaims a versioned collection whose indexing run went stale", async () => {
    const qdrant = createMockQdrant(
      [{ aliasName: "code_abc", collectionName: "code_abc_v2" }],
      ["code_abc_v2", "code_abc_v3"],
      // In progress on paper, but nothing has advanced it for 11 minutes: the
      // run that owned it is gone, so this is a crash leftover, not a live build.
      { code_abc_v3: { indexingComplete: false, startedAt: minutesAgo(30), lastHeartbeat: minutesAgo(11) } },
    );

    const result = await cleanupOrphanedVersions(qdrant, "code_abc");

    expect(qdrant.deleteCollection).toHaveBeenCalledWith("code_abc_v3");
    expect(result).toBe(1);
  });

  it("reclaims a versioned collection whose indexing already completed", async () => {
    const qdrant = createMockQdrant(
      [{ aliasName: "code_abc", collectionName: "code_abc_v2" }],
      ["code_abc_v2", "code_abc_v3"],
      { code_abc_v3: { indexingComplete: true, completedAt: minutesAgo(1) } },
    );

    const result = await cleanupOrphanedVersions(qdrant, "code_abc");

    expect(qdrant.deleteCollection).toHaveBeenCalledWith("code_abc_v3");
    expect(result).toBe(1);
  });

  it("does nothing when no orphans exist", async () => {
    const qdrant = createMockQdrant([{ aliasName: "code_abc", collectionName: "code_abc_v2" }], ["code_abc_v2"]);

    const result = await cleanupOrphanedVersions(qdrant, "code_abc");

    expect(result).toBe(0);
    expect(qdrant.deleteCollection).not.toHaveBeenCalled();
  });

  it("does nothing when alias not found", async () => {
    const qdrant = createMockQdrant(
      [{ aliasName: "other_collection", collectionName: "other_collection_v1" }],
      ["code_abc_v1", "code_abc_v2"],
    );

    const result = await cleanupOrphanedVersions(qdrant, "code_abc");

    expect(result).toBe(0);
    expect(qdrant.deleteCollection).not.toHaveBeenCalled();
  });

  it("does not delete unrelated collections", async () => {
    const qdrant = createMockQdrant(
      [{ aliasName: "code_abc", collectionName: "code_abc_v2" }],
      ["code_abc_v1", "code_abc_v2", "other_collection", "another_v1"],
    );

    const result = await cleanupOrphanedVersions(qdrant, "code_abc");

    expect(result).toBe(1);
    expect(qdrant.deleteCollection).toHaveBeenCalledWith("code_abc_v1");
    expect(qdrant.deleteCollection).not.toHaveBeenCalledWith("other_collection");
    expect(qdrant.deleteCollection).not.toHaveBeenCalledWith("another_v1");
  });

  describe("codegraph DB cleanup", () => {
    it("removes the codegraph DB for each deleted orphan", async () => {
      const qdrant = createMockQdrant(
        [{ aliasName: "code_abc", collectionName: "code_abc_v2" }],
        ["code_abc_v1", "code_abc_v2", "code_abc_v3"],
      );
      const removeCodegraphDb = vi.fn().mockResolvedValue(undefined);

      const result = await cleanupOrphanedVersions(qdrant, "code_abc", removeCodegraphDb);

      expect(result).toBe(2);
      expect(removeCodegraphDb).toHaveBeenCalledWith("code_abc_v1");
      expect(removeCodegraphDb).toHaveBeenCalledWith("code_abc_v3");
      expect(removeCodegraphDb).not.toHaveBeenCalledWith("code_abc_v2");
    });

    it("does not call the codegraph remover when there are no orphans", async () => {
      const qdrant = createMockQdrant([{ aliasName: "code_abc", collectionName: "code_abc_v2" }], ["code_abc_v2"]);
      const removeCodegraphDb = vi.fn().mockResolvedValue(undefined);

      await cleanupOrphanedVersions(qdrant, "code_abc", removeCodegraphDb);

      expect(removeCodegraphDb).not.toHaveBeenCalled();
    });

    it("treats a codegraph remover failure as non-fatal and keeps deleting other orphans", async () => {
      const qdrant = createMockQdrant(
        [{ aliasName: "code_abc", collectionName: "code_abc_v3" }],
        ["code_abc_v1", "code_abc_v2", "code_abc_v3"],
      );
      const removeCodegraphDb = vi.fn().mockRejectedValueOnce(new Error("unlink failed")).mockResolvedValue(undefined);

      const result = await cleanupOrphanedVersions(qdrant, "code_abc", removeCodegraphDb);

      expect(result).toBe(2);
      // Both orphan Qdrant collections still deleted despite the first remover throwing.
      expect(qdrant.deleteCollection).toHaveBeenCalledWith("code_abc_v1");
      expect(qdrant.deleteCollection).toHaveBeenCalledWith("code_abc_v2");
      expect(removeCodegraphDb).toHaveBeenCalledWith("code_abc_v1");
      expect(removeCodegraphDb).toHaveBeenCalledWith("code_abc_v2");
    });

    it("works without a codegraph remover (backwards compatible)", async () => {
      const qdrant = createMockQdrant(
        [{ aliasName: "code_abc", collectionName: "code_abc_v2" }],
        ["code_abc_v1", "code_abc_v2"],
      );

      const result = await cleanupOrphanedVersions(qdrant, "code_abc");

      expect(result).toBe(1);
      expect(qdrant.deleteCollection).toHaveBeenCalledWith("code_abc_v1");
    });
  });
});

describe("sweepCodegraphOrphans", () => {
  it("removes codegraph DBs whose Qdrant collection is absent, skipping the active alias target", async () => {
    // Codegraph dir holds DBs for v1 (ancient orphan — no Qdrant collection),
    // v2 (active alias target), and v3 (still has a Qdrant collection).
    const qdrant = createMockQdrant(
      [{ aliasName: "code_abc", collectionName: "code_abc_v2" }],
      ["code_abc_v2", "code_abc_v3"],
    );
    const listCodegraphDbs = vi.fn().mockReturnValue(["code_abc_v1", "code_abc_v2", "code_abc_v3"]);
    const removeCodegraphDb = vi.fn().mockResolvedValue(undefined);

    const removed = await sweepCodegraphOrphans(qdrant, "code_abc", listCodegraphDbs, removeCodegraphDb);

    expect(removed).toBe(1);
    expect(listCodegraphDbs).toHaveBeenCalledWith("code_abc");
    // v1 has no Qdrant collection and is not the active target → removed.
    expect(removeCodegraphDb).toHaveBeenCalledWith("code_abc_v1");
    // v2 is the active alias target → never removed even though it has a DB.
    expect(removeCodegraphDb).not.toHaveBeenCalledWith("code_abc_v2");
    // v3 still has a live Qdrant collection → never removed.
    expect(removeCodegraphDb).not.toHaveBeenCalledWith("code_abc_v3");
  });

  it("never removes the active alias target even when its Qdrant collection is missing from listCollections", async () => {
    const qdrant = createMockQdrant([{ aliasName: "code_abc", collectionName: "code_abc_v2" }], []);
    const listCodegraphDbs = vi.fn().mockReturnValue(["code_abc_v2"]);
    const removeCodegraphDb = vi.fn().mockResolvedValue(undefined);

    const removed = await sweepCodegraphOrphans(qdrant, "code_abc", listCodegraphDbs, removeCodegraphDb);

    expect(removed).toBe(0);
    expect(removeCodegraphDb).not.toHaveBeenCalled();
  });

  it("is a no-op when the lister returns no codegraph DBs", async () => {
    const qdrant = createMockQdrant([{ aliasName: "code_abc", collectionName: "code_abc_v2" }], ["code_abc_v2"]);
    const listCodegraphDbs = vi.fn().mockReturnValue([]);
    const removeCodegraphDb = vi.fn().mockResolvedValue(undefined);

    const removed = await sweepCodegraphOrphans(qdrant, "code_abc", listCodegraphDbs, removeCodegraphDb);

    expect(removed).toBe(0);
    expect(removeCodegraphDb).not.toHaveBeenCalled();
  });

  it("treats a remover failure as non-fatal and keeps sweeping other orphans", async () => {
    const qdrant = createMockQdrant([{ aliasName: "code_abc", collectionName: "code_abc_v3" }], ["code_abc_v3"]);
    const listCodegraphDbs = vi.fn().mockReturnValue(["code_abc_v1", "code_abc_v2", "code_abc_v3"]);
    const removeCodegraphDb = vi.fn().mockRejectedValueOnce(new Error("unlink failed")).mockResolvedValue(undefined);

    const removed = await sweepCodegraphOrphans(qdrant, "code_abc", listCodegraphDbs, removeCodegraphDb);

    // Both v1 and v2 are orphan codegraph DBs; the first remover throws but the
    // second still runs. The counter reflects successful removals only.
    expect(removed).toBe(1);
    expect(removeCodegraphDb).toHaveBeenCalledWith("code_abc_v1");
    expect(removeCodegraphDb).toHaveBeenCalledWith("code_abc_v2");
    expect(removeCodegraphDb).not.toHaveBeenCalledWith("code_abc_v3");
  });
});

// An interrupted force reindex used to leave its half-built `<base>_vN` in
// Qdrant until some LATER run happened to sweep it — on taxdome that left
// code_27622aef_v12 (12830 points) sitting next to a healthy v11 with nothing
// automatic to remove it (bd tea-rags-mcp-8pymz). Discarding the build the
// moment the run fails closes that window, but only where a prior good version
// is provably still serving: a first-ever index has no fallback, and its
// partial data is the only data that exists.
describe("discardFailedCollectionBuild", () => {
  it("deletes the half-built version when the alias still serves the previous one", async () => {
    const qdrant = createMockQdrant(
      [{ aliasName: "code_abc", collectionName: "code_abc_v11" }],
      ["code_abc_v11", "code_abc_v12"],
    );

    const discarded = await discardFailedCollectionBuild(qdrant, "code_abc", "code_abc_v12");

    expect(discarded).toBe(true);
    expect(qdrant.deleteCollection).toHaveBeenCalledWith("code_abc_v12");
    expect(qdrant.deleteCollection).not.toHaveBeenCalledWith("code_abc_v11");
  });

  // THE scope boundary. A bootstrap index owns no fallback: the base name is
  // neither an alias nor a real collection, so `_v1` holds every point the
  // project has. Deleting it turns a resumable/diagnosable partial index into
  // total data loss.
  it("keeps the partial collection when nothing else serves the base name (bootstrap)", async () => {
    const qdrant = createMockQdrant([], ["code_abc_v1"]);

    const discarded = await discardFailedCollectionBuild(qdrant, "code_abc", "code_abc_v1");

    expect(discarded).toBe(false);
    expect(qdrant.deleteCollection).not.toHaveBeenCalled();
  });

  // The other catastrophic direction: the run failed AFTER the alias swap, so
  // the "half-built" target is now the live index. Deleting it would destroy
  // the collection the swap just promoted.
  it("keeps the target when the alias already points at it", async () => {
    const qdrant = createMockQdrant([{ aliasName: "code_abc", collectionName: "code_abc_v12" }], ["code_abc_v12"]);

    const discarded = await discardFailedCollectionBuild(qdrant, "code_abc", "code_abc_v12");

    expect(discarded).toBe(false);
    expect(qdrant.deleteCollection).not.toHaveBeenCalled();
  });

  // Migration (pre-alias legacy layout): no alias yet, but the unversioned real
  // collection is still intact and still serving, so the new version is safe to
  // drop.
  it("deletes the half-built version when an unversioned collection still serves the base name", async () => {
    const qdrant = createMockQdrant([], ["code_abc", "code_abc_v2"]);

    const discarded = await discardFailedCollectionBuild(qdrant, "code_abc", "code_abc_v2");

    expect(discarded).toBe(true);
    expect(qdrant.deleteCollection).toHaveBeenCalledWith("code_abc_v2");
  });

  it("drops the discarded version's codegraph DB alongside it", async () => {
    const qdrant = createMockQdrant(
      [{ aliasName: "code_abc", collectionName: "code_abc_v11" }],
      ["code_abc_v11", "code_abc_v12"],
    );
    const removeCodegraphDb = vi.fn().mockResolvedValue(undefined);

    await discardFailedCollectionBuild(qdrant, "code_abc", "code_abc_v12", removeCodegraphDb);

    expect(removeCodegraphDb).toHaveBeenCalledWith("code_abc_v12");
  });

  // The Qdrant collection is what the discard is FOR; the codegraph DB is a
  // best-effort extra. A remover that throws must not turn a discard that
  // actually happened into a reported failure — same contract
  // cleanupOrphanedVersions holds for its own sweep.
  it("still reports the discard when the codegraph remover throws", async () => {
    const qdrant = createMockQdrant(
      [{ aliasName: "code_abc", collectionName: "code_abc_v11" }],
      ["code_abc_v11", "code_abc_v12"],
    );
    const removeCodegraphDb = vi.fn().mockRejectedValue(new Error("unlink failed"));

    const discarded = await discardFailedCollectionBuild(qdrant, "code_abc", "code_abc_v12", removeCodegraphDb);

    expect(discarded).toBe(true);
    expect(qdrant.deleteCollection).toHaveBeenCalledWith("code_abc_v12");
  });

  // Qdrant being unreachable is a plausible reason the run failed in the first
  // place. Unable to prove a fallback exists ⇒ keep the collection and leave it
  // to the next run's sweep, which can re-check when Qdrant answers again.
  it("keeps the target when the fallback cannot be established", async () => {
    const qdrant = createMockQdrant([], []);
    vi.mocked(qdrant.aliases.listAliases).mockRejectedValue(new Error("qdrant unreachable"));

    const discarded = await discardFailedCollectionBuild(qdrant, "code_abc", "code_abc_v12");

    expect(discarded).toBe(false);
    expect(qdrant.deleteCollection).not.toHaveBeenCalled();
  });

  it("reports a delete failure as not discarded instead of throwing", async () => {
    const qdrant = createMockQdrant(
      [{ aliasName: "code_abc", collectionName: "code_abc_v11" }],
      ["code_abc_v11", "code_abc_v12"],
    );
    vi.mocked(qdrant.deleteCollection).mockRejectedValue(new Error("delete failed"));

    const discarded = await discardFailedCollectionBuild(qdrant, "code_abc", "code_abc_v12");

    expect(discarded).toBe(false);
  });
});
