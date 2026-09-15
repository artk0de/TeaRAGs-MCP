import { describe, expect, it, vi } from "vitest";

import { SchemaMetadataPointStore } from "../../../../src/core/adapters/qdrant/schema-metadata-point.js";

const POINT_ID = "__schema_metadata__";

const STORED = {
  _type: "schema_metadata",
  schemaVersion: 7,
  indexes: ["relativePath"],
  sparseVersion: 3,
  migratedAt: "2020-01-01T00:00:00.000Z",
  futureField: "written by a later build",
} as const;

/** In-memory Qdrant whose upsert replaces the stored payload, like the real one. */
function makeQdrant(opts: { hybridEnabled?: boolean; seed?: Record<string, unknown> | null } = {}) {
  const stored = new Map<string | number, Record<string, unknown>>();
  if (opts.seed !== null) stored.set(POINT_ID, structuredClone(opts.seed ?? STORED));
  const upsert = async (_collection: string, points: { id: string | number; payload: Record<string, unknown> }[]) => {
    for (const point of points) stored.set(point.id, structuredClone(point.payload));
    return Promise.resolve();
  };
  return {
    stored,
    getCollectionInfo: vi.fn(async () =>
      Promise.resolve({ vectorSize: 4, hybridEnabled: opts.hybridEnabled ?? false }),
    ),
    getPoint: vi.fn(async (_collection: string, id: string | number) =>
      Promise.resolve(stored.has(id) ? { id, payload: stored.get(id) } : null),
    ),
    // Two distinct spies over one replacing upsert, so each path's calls are its own.
    addPoints: vi.fn(upsert),
    addPointsWithSparse: vi.fn(upsert),
  };
}

type FakeQdrant = ReturnType<typeof makeQdrant>;

interface SetterCase {
  setter: string;
  owns: readonly string[];
  writes: Record<string, unknown>;
  run: (store: SchemaMetadataPointStore) => Promise<void>;
}

const SETTERS: readonly SetterCase[] = [
  {
    setter: "setSchemaVersion",
    owns: ["schemaVersion", "indexes", "migratedAt"],
    writes: { schemaVersion: 43, indexes: ["language"] },
    run: async (store) => store.setSchemaVersion("col", 43, ["language"]),
  },
  {
    setter: "setSparseVersion",
    owns: ["sparseVersion", "migratedAt"],
    writes: { sparseVersion: 5 },
    run: async (store) => store.setSparseVersion("col", 5),
  },
  {
    setter: "setCreationVersions",
    owns: ["schemaVersion", "sparseVersion", "indexes", "migratedAt"],
    writes: { schemaVersion: 42, sparseVersion: 9, indexes: ["symbolId"] },
    run: async (store) =>
      store.setCreationVersions("col", { schemaVersion: 42, sparseVersion: 9, indexes: ["symbolId"] }),
  },
];

function storeOver(qdrant: FakeQdrant): SchemaMetadataPointStore {
  return new SchemaMetadataPointStore(qdrant as never);
}

describe("SchemaMetadataPointStore", () => {
  describe("per-field setters merge onto the stored point", () => {
    for (const { setter, owns, writes, run } of SETTERS) {
      it(`${setter} preserves every field it does not own`, async () => {
        const qdrant = makeQdrant();

        await run(storeOver(qdrant));

        const after = qdrant.stored.get(POINT_ID);
        for (const [field, value] of Object.entries(STORED)) {
          if (owns.includes(field)) continue;
          expect(after?.[field], `${setter} changed "${field}"`).toEqual(value);
        }
        expect(after).toMatchObject(writes);
        expect(after?.migratedAt).not.toBe(STORED.migratedAt);
      });

      it(`${setter} writes nothing when the stored point cannot be read`, async () => {
        const qdrant = makeQdrant();
        qdrant.getPoint.mockRejectedValueOnce(new Error("qdrant down"));

        await expect(run(storeOver(qdrant))).rejects.toThrow("qdrant down");

        expect(qdrant.addPoints).not.toHaveBeenCalled();
        expect(qdrant.addPointsWithSparse).not.toHaveBeenCalled();
        expect(qdrant.stored.get(POINT_ID)).toEqual(STORED);
      });
    }
  });

  it("creates the point with version defaults when none is stored yet", async () => {
    const qdrant = makeQdrant({ seed: null });

    await storeOver(qdrant).setSparseVersion("col", 2);

    expect(qdrant.stored.get(POINT_ID)).toMatchObject({
      _type: "schema_metadata",
      schemaVersion: 0,
      indexes: [],
      sparseVersion: 2,
    });
  });

  it("does not invent a sparse version for a schema-only write on an empty collection", async () => {
    const qdrant = makeQdrant({ seed: null });

    await storeOver(qdrant).setSchemaVersion("col", 8, ["relativePath"]);

    expect(qdrant.stored.get(POINT_ID)).not.toHaveProperty("sparseVersion");
  });

  it("upserts through the sparse-aware path on a hybrid collection, with a zero vector of the collection's width", async () => {
    const qdrant = makeQdrant({ hybridEnabled: true });

    await storeOver(qdrant).setSparseVersion("col", 4);

    expect(qdrant.addPointsWithSparse).toHaveBeenCalledWith("col", [
      expect.objectContaining({ id: POINT_ID, vector: [0, 0, 0, 0], sparseVector: { indices: [], values: [] } }),
    ]);
  });

  it("upserts through the dense path on a non-hybrid collection", async () => {
    const qdrant = makeQdrant({ hybridEnabled: false });

    await storeOver(qdrant).setSparseVersion("col", 4);

    expect(qdrant.addPoints).toHaveBeenCalledWith("col", [
      expect.objectContaining({ id: POINT_ID, vector: [0, 0, 0, 0] }),
    ]);
    expect(qdrant.addPointsWithSparse).not.toHaveBeenCalled();
  });

  describe("read", () => {
    it("returns the stored payload", async () => {
      expect(await storeOver(makeQdrant()).read("col")).toEqual(STORED);
    });

    it("returns null when the collection carries no metadata point", async () => {
      expect(await storeOver(makeQdrant({ seed: null })).read("col")).toBeNull();
    });

    it("returns null for a point at that id that is not schema metadata", async () => {
      expect(await storeOver(makeQdrant({ seed: { _type: "something_else" } })).read("col")).toBeNull();
    });

    it("propagates a read failure instead of reporting an absent point", async () => {
      const qdrant = makeQdrant();
      qdrant.getPoint.mockRejectedValueOnce(new Error("qdrant down"));

      await expect(storeOver(qdrant).read("col")).rejects.toThrow("qdrant down");
    });
  });
});
