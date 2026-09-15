import { describe, expect, it, vi } from "vitest";

import type { QdrantManager } from "../../../../../src/core/adapters/qdrant/client.js";
import { CollectionAlreadyExistsError } from "../../../../../src/core/adapters/qdrant/errors.js";
import { VersionedCollectionClaimError } from "../../../../../src/core/domains/ingest/errors.js";
import {
  claimVersionedCollection,
  isCollectionBuildInFlight,
  isCollectionIndexingInFlight,
  VERSION_CLAIM_ATTEMPT_LIMIT,
} from "../../../../../src/core/domains/ingest/infra/collection-build-lease.js";

/**
 * @param collections collection names Qdrant reports as existing
 * @param markers collectionName → its `__indexing_metadata__` payload; absent ⇒ no marker
 */
function createMockQdrant(collections: string[], markers: Record<string, Record<string, unknown>> = {}) {
  const live = new Set(collections);
  return {
    collectionExists: vi.fn().mockImplementation(async (name: string) => Promise.resolve(live.has(name))),
    deleteCollection: vi.fn().mockImplementation(async (name: string) => {
      live.delete(name);
      return Promise.resolve();
    }),
    getPoint: vi
      .fn()
      .mockImplementation(async (collection: string) =>
        Promise.resolve(markers[collection] ? { payload: markers[collection] } : null),
      ),
  } as unknown as QdrantManager;
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60 * 1000).toISOString();
const liveMarker = () => ({ indexingComplete: false, startedAt: minutesAgo(2), lastHeartbeat: minutesAgo(1) });

describe("isCollectionBuildInFlight", () => {
  it("reports a fresh in-progress marker as a live build", async () => {
    const qdrant = createMockQdrant(["code_abc_v7"], { code_abc_v7: liveMarker() });

    expect(await isCollectionBuildInFlight(qdrant, "code_abc_v7")).toBe(true);
  });

  it("reports an absent, completed or stale marker as no live build", async () => {
    const qdrant = createMockQdrant(["code_abc_v7", "code_abc_v8", "code_abc_v9"], {
      code_abc_v8: { indexingComplete: true, completedAt: minutesAgo(1) },
      code_abc_v9: { indexingComplete: false, startedAt: minutesAgo(30), lastHeartbeat: minutesAgo(11) },
    });

    expect(await isCollectionBuildInFlight(qdrant, "code_abc_v7")).toBe(false);
    expect(await isCollectionBuildInFlight(qdrant, "code_abc_v8")).toBe(false);
    expect(await isCollectionBuildInFlight(qdrant, "code_abc_v9")).toBe(false);
  });

  it("answers no when the marker read throws", async () => {
    const qdrant = createMockQdrant([]);
    vi.mocked(qdrant.getPoint).mockRejectedValueOnce(new Error("qdrant down"));

    expect(await isCollectionBuildInFlight(qdrant, "code_abc_v7")).toBe(false);
  });
});

describe("isCollectionIndexingInFlight (bd tea-rags-mcp-62pgi)", () => {
  const withCollections = (qdrant: QdrantManager, collections: string[]): QdrantManager =>
    Object.assign(qdrant, { listCollections: vi.fn().mockResolvedValue(collections) });

  const liveRun = (extra: Record<string, unknown> = {}) => ({
    indexingComplete: true,
    enrichment: {
      _run: { runId: "r1", startedAt: minutesAgo(1), lastProgressAt: minutesAgo(0.5), providers: ["git"] },
      ...extra,
    },
  });

  it("answers yes for a live indexing marker and for a live enrichment run", async () => {
    const building = withCollections(createMockQdrant(["code_abc"], { code_abc: liveMarker() }), ["code_abc"]);
    const enriching = withCollections(createMockQdrant(["code_abc"], { code_abc: liveRun() }), ["code_abc"]);

    expect(await isCollectionIndexingInFlight(building, "code_abc")).toBe(true);
    expect(await isCollectionIndexingInFlight(enriching, "code_abc")).toBe(true);
  });

  it("answers yes for a versioned build in flight next to the served collection", async () => {
    const qdrant = withCollections(
      createMockQdrant(["code_abc_v1", "code_abc_v2"], {
        code_abc: { indexingComplete: true },
        code_abc_v2: liveMarker(),
      }),
      ["code_abc_v1", "code_abc_v2", "code_abcd_v9"],
    );

    expect(await isCollectionIndexingInFlight(qdrant, "code_abc")).toBe(true);
  });

  it("ignores a live build of a DIFFERENT base that merely shares the prefix", async () => {
    const qdrant = withCollections(createMockQdrant(["code_abcd_v9"], { code_abcd_v9: liveMarker() }), [
      "code_abcd_v9",
    ]);

    expect(await isCollectionIndexingInFlight(qdrant, "code_abc")).toBe(false);
  });

  it("answers no once every provider of the run has both terminal markers for its runId", async () => {
    const qdrant = withCollections(
      createMockQdrant(["code_abc"], {
        code_abc: liveRun({
          git: { file: { runId: "r1", status: "completed" }, chunk: { runId: "r1", status: "failed" } },
        }),
      }),
      ["code_abc"],
    );

    expect(await isCollectionIndexingInFlight(qdrant, "code_abc")).toBe(false);
  });

  it("answers no when the terminal markers carry an older runId but progress went stale", async () => {
    const qdrant = withCollections(
      createMockQdrant(["code_abc"], {
        code_abc: {
          indexingComplete: true,
          enrichment: {
            _run: { runId: "r2", startedAt: minutesAgo(9), lastProgressAt: minutesAgo(3), providers: ["git"] },
            git: { file: { runId: "r1", status: "completed" }, chunk: { runId: "r1", status: "completed" } },
          },
        },
      }),
      ["code_abc"],
    );

    expect(await isCollectionIndexingInFlight(qdrant, "code_abc")).toBe(false);
  });

  it("discounts evidence written at or before this process's own run settled", async () => {
    const heartbeat = Date.now() - 20_000;
    const qdrant = withCollections(
      createMockQdrant(["code_abc"], {
        code_abc: {
          indexingComplete: false,
          startedAt: new Date(heartbeat).toISOString(),
          lastHeartbeat: new Date(heartbeat).toISOString(),
        },
      }),
      ["code_abc"],
    );

    expect(await isCollectionIndexingInFlight(qdrant, "code_abc", { ownRunsSettledAt: heartbeat })).toBe(false);
    expect(await isCollectionIndexingInFlight(qdrant, "code_abc", { ownRunsSettledAt: heartbeat - 1 })).toBe(true);
  });

  it("answers no when nothing can be read", async () => {
    const qdrant = createMockQdrant([]);
    vi.mocked(qdrant.getPoint).mockRejectedValue(new Error("qdrant down"));
    Object.assign(qdrant, { listCollections: vi.fn().mockRejectedValue(new Error("qdrant down")) });

    expect(await isCollectionIndexingInFlight(qdrant, "code_abc")).toBe(false);
  });
});

describe("claimVersionedCollection", () => {
  it("takes the computed version when nothing holds it", async () => {
    const qdrant = createMockQdrant([]);
    const createLeasedCollection = vi.fn().mockResolvedValue(undefined);

    const claim = await claimVersionedCollection({
      qdrant,
      baseCollectionName: "code_abc",
      firstVersion: 62,
      createLeasedCollection,
    });

    expect(claim).toEqual({ collectionName: "code_abc_v62", version: 62 });
    expect(createLeasedCollection).toHaveBeenCalledExactlyOnceWith("code_abc_v62");
    expect(qdrant.deleteCollection).not.toHaveBeenCalled();
  });

  // The hole this module closes. Two force runs that start close together read
  // the same alias target and compute the SAME next version. The second one used
  // to treat the first one's freshly created, actively filling collection as "a
  // stale target from a previously failed attempt" and delete it — the exact
  // symptom cleanupOrphanedVersions was taught to avoid, reached by the other
  // branch (bd tea-rags-mcp-nrylk).
  it("never deletes a version a live run is building, and takes the next free one", async () => {
    const qdrant = createMockQdrant(["code_abc_v62"], { code_abc_v62: liveMarker() });
    const createLeasedCollection = vi.fn().mockResolvedValue(undefined);

    const claim = await claimVersionedCollection({
      qdrant,
      baseCollectionName: "code_abc",
      firstVersion: 62,
      createLeasedCollection,
    });

    expect(qdrant.deleteCollection).not.toHaveBeenCalled();
    expect(claim).toEqual({ collectionName: "code_abc_v63", version: 63 });
    expect(createLeasedCollection).toHaveBeenCalledExactlyOnceWith("code_abc_v63");
  });

  it("walks past a run of live versions until it finds a free one", async () => {
    const qdrant = createMockQdrant(["code_abc_v62", "code_abc_v63", "code_abc_v64"], {
      code_abc_v62: liveMarker(),
      code_abc_v63: liveMarker(),
      code_abc_v64: liveMarker(),
    });
    const createLeasedCollection = vi.fn().mockResolvedValue(undefined);

    const claim = await claimVersionedCollection({
      qdrant,
      baseCollectionName: "code_abc",
      firstVersion: 62,
      createLeasedCollection,
    });

    expect(claim.version).toBe(65);
    expect(qdrant.deleteCollection).not.toHaveBeenCalled();
  });

  // The obvious way to "fix" the race badly is to stop deleting anything, which
  // leaks a collection per crashed run and climbs the version number forever.
  it("still reclaims a version whose indexing run went stale", async () => {
    const qdrant = createMockQdrant(["code_abc_v62"], {
      code_abc_v62: { indexingComplete: false, startedAt: minutesAgo(40), lastHeartbeat: minutesAgo(11) },
    });
    const createLeasedCollection = vi.fn().mockResolvedValue(undefined);

    const claim = await claimVersionedCollection({
      qdrant,
      baseCollectionName: "code_abc",
      firstVersion: 62,
      createLeasedCollection,
    });

    expect(qdrant.deleteCollection).toHaveBeenCalledExactlyOnceWith("code_abc_v62");
    expect(claim).toEqual({ collectionName: "code_abc_v62", version: 62 });
  });

  it("still reclaims a version left behind with no marker at all", async () => {
    const qdrant = createMockQdrant(["code_abc_v62"]);
    const createLeasedCollection = vi.fn().mockResolvedValue(undefined);

    const claim = await claimVersionedCollection({
      qdrant,
      baseCollectionName: "code_abc",
      firstVersion: 62,
      createLeasedCollection,
    });

    expect(qdrant.deleteCollection).toHaveBeenCalledExactlyOnceWith("code_abc_v62");
    expect(claim.version).toBe(62);
  });

  // The residual window: the other run created the collection but has not
  // published its marker yet, so no read can tell us it is alive. Qdrant's own
  // create is the only atomic arbiter — losing it means the version is taken.
  it("advances when the create itself loses the race", async () => {
    const qdrant = createMockQdrant([]);
    const createLeasedCollection = vi
      .fn()
      .mockRejectedValueOnce(new CollectionAlreadyExistsError("code_abc_v62"))
      .mockResolvedValue(undefined);

    const claim = await claimVersionedCollection({
      qdrant,
      baseCollectionName: "code_abc",
      firstVersion: 62,
      createLeasedCollection,
    });

    expect(claim).toEqual({ collectionName: "code_abc_v63", version: 63 });
    expect(createLeasedCollection).toHaveBeenNthCalledWith(1, "code_abc_v62");
    expect(createLeasedCollection).toHaveBeenNthCalledWith(2, "code_abc_v63");
  });

  it("propagates a create failure that is not a lost race", async () => {
    const qdrant = createMockQdrant([]);
    const createLeasedCollection = vi.fn().mockRejectedValue(new Error("vector size rejected"));

    await expect(
      claimVersionedCollection({
        qdrant,
        baseCollectionName: "code_abc",
        firstVersion: 62,
        createLeasedCollection,
      }),
    ).rejects.toThrow("vector size rejected");
    expect(createLeasedCollection).toHaveBeenCalledTimes(1);
  });

  it("gives up with a typed error once the attempt window is exhausted", async () => {
    const taken = Array.from({ length: VERSION_CLAIM_ATTEMPT_LIMIT }, (_, i) => `code_abc_v${62 + i}`);
    const markers = Object.fromEntries(taken.map((name) => [name, liveMarker()]));
    const qdrant = createMockQdrant(taken, markers);
    const createLeasedCollection = vi.fn().mockResolvedValue(undefined);

    await expect(
      claimVersionedCollection({
        qdrant,
        baseCollectionName: "code_abc",
        firstVersion: 62,
        createLeasedCollection,
      }),
    ).rejects.toBeInstanceOf(VersionedCollectionClaimError);
    expect(createLeasedCollection).not.toHaveBeenCalled();
    expect(qdrant.deleteCollection).not.toHaveBeenCalled();
  });
});
