/**
 * `__schema_metadata__` has ONE owner (bd tea-rags-mcp-906df).
 *
 * The point carries fields owned by different pipelines — `schemaVersion` and
 * `indexes` by the schema pipeline, `sparseVersion` by the sparse one — and a
 * Qdrant upsert REPLACES the whole payload of the id it writes. A writer that
 * rebuilds the payload from only the fields it knows erases the others: that is
 * how a schema migration used to wipe `sparseVersion` and pay for a full BM25
 * rebuild on the next sync (bd tea-rags-mcp-vy26b).
 *
 * Two invariants, pinned from the outside:
 *  1. every production writer preserves every field it does not own — including
 *     a field no writer knows yet, which is what a fourth writer would add;
 *  2. no source file outside the owner addresses the point, so a new writer
 *     cannot bypass the merge.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { SchemaManager } from "../../../../../src/core/adapters/qdrant/schema-manager.js";
import { IndexStoreAdapter } from "../../../../../src/core/domains/maintenance/migration/adapters/index-store-adapter.js";
import { SparseStoreAdapter } from "../../../../../src/core/domains/maintenance/migration/adapters/sparse-store-adapter.js";

const POINT_ID = "__schema_metadata__";

/** A point as a previous build left it, plus a field today's writers have never heard of. */
const STORED = {
  _type: "schema_metadata",
  schemaVersion: 7,
  indexes: ["relativePath"],
  sparseVersion: 3,
  migratedAt: "2020-01-01T00:00:00.000Z",
  futureField: "written by a later build",
} as const;

/** In-memory Qdrant whose upsert replaces the stored payload, like the real one. */
function makeReplacingQdrant(opts: { hybridEnabled: boolean; failRead?: boolean }) {
  const stored = new Map<string | number, Record<string, unknown>>([[POINT_ID, structuredClone(STORED)]]);
  const upsert = async (_collection: string, points: { id: string | number; payload: Record<string, unknown> }[]) => {
    for (const point of points) stored.set(point.id, structuredClone(point.payload));
    return Promise.resolve();
  };
  return {
    stored,
    createPayloadIndex: async () => Promise.resolve(),
    getCollectionInfo: async () => Promise.resolve({ vectorSize: 4, hybridEnabled: opts.hybridEnabled }),
    getPoint: async (_collection: string, id: string | number) => {
      if (opts.failRead) throw new Error("transient read failure");
      return Promise.resolve(stored.has(id) ? { id, payload: stored.get(id) } : null);
    },
    addPoints: upsert,
    addPointsWithSparse: upsert,
  };
}

type ReplacingQdrant = ReturnType<typeof makeReplacingQdrant>;

interface WriterCase {
  writer: string;
  /** Payload fields this writer is entitled to change. */
  owns: readonly string[];
  /** The values it must have written. */
  writes: Record<string, unknown>;
  run: (qdrant: ReplacingQdrant) => Promise<void>;
}

const WRITERS: readonly WriterCase[] = [
  {
    writer: "SchemaManager#initializeSchema",
    owns: ["schemaVersion", "sparseVersion", "indexes", "migratedAt"],
    writes: { schemaVersion: 42, sparseVersion: 9 },
    run: async (qdrant) => new SchemaManager(qdrant as never, 42, 9).initializeSchema("col"),
  },
  {
    writer: "IndexStoreAdapter#storeSchemaVersion",
    owns: ["schemaVersion", "indexes", "migratedAt"],
    writes: { schemaVersion: 43, indexes: ["language"] },
    run: async (qdrant) => new IndexStoreAdapter(qdrant as never).storeSchemaVersion("col", 43, ["language"]),
  },
  {
    writer: "SparseStoreAdapter#storeSparseVersion",
    owns: ["sparseVersion", "migratedAt"],
    writes: { sparseVersion: 5 },
    run: async (qdrant) => new SparseStoreAdapter(qdrant as never).storeSparseVersion("col", 5),
  },
];

describe("schema metadata point — every writer preserves the fields it does not own", () => {
  for (const { writer, owns, writes, run } of WRITERS) {
    for (const hybridEnabled of [false, true]) {
      describe(`${writer} (hybrid=${hybridEnabled})`, () => {
        it("leaves every field it does not own exactly as stored", async () => {
          const qdrant = makeReplacingQdrant({ hybridEnabled });

          await run(qdrant);

          const after = qdrant.stored.get(POINT_ID);
          for (const [field, value] of Object.entries(STORED)) {
            if (owns.includes(field)) continue;
            expect(after?.[field], `${writer} changed "${field}"`).toEqual(value);
          }
        });

        it("writes the fields it owns", async () => {
          const qdrant = makeReplacingQdrant({ hybridEnabled });

          await run(qdrant);

          expect(qdrant.stored.get(POINT_ID)).toMatchObject(writes);
        });

        it("never turns a failed read of the stored point into a blind overwrite", async () => {
          const qdrant = makeReplacingQdrant({ hybridEnabled, failRead: true });

          await run(qdrant);

          expect(qdrant.stored.get(POINT_ID)).toEqual(STORED);
        });
      });
    }
  }
});

describe("schema metadata point — single owner guard", () => {
  const SRC_ROOT = join(__dirname, "../../../../../src");
  const OWNER = "core/adapters/qdrant/schema-metadata-point.ts";
  const PAYLOAD_TYPE = "core/contracts/types/schema-metadata.ts";

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.name.endsWith(".ts") ? [full] : [];
    });
  }

  function filesMatching(pattern: RegExp): string[] {
    return sourceFiles(SRC_ROOT)
      .filter((file) => pattern.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC_ROOT, file).split(sep).join("/"))
      .sort();
  }

  it("names the point id only inside its owner", () => {
    expect(filesMatching(/__schema_metadata__/)).toEqual([OWNER]);
  });

  it("builds a schema_metadata payload only inside its owner and the payload type", () => {
    expect(filesMatching(/_type:\s*"schema_metadata"/)).toEqual([OWNER, PAYLOAD_TYPE].sort());
  });
});
