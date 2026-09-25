import { describe, expect, it, vi } from "vitest";

import type { PayloadFieldIndex } from "../../../../../src/core/adapters/qdrant/payload-index.js";
import type { PayloadFieldIndexSchema } from "../../../../../src/core/adapters/qdrant/schema-manager.js";
import { Migrator } from "../../../../../src/core/domains/maintenance/migration/migrator.js";
import { PayloadIndexMigrator } from "../../../../../src/core/domains/maintenance/migration/payload-index-migrator.js";
import type {
  MigrationRunner,
  PayloadIndexStore,
} from "../../../../../src/core/domains/maintenance/migration/types.js";

const ALIAS = "code_27622aef";
const PHYSICAL = "code_27622aef_v13";

/**
 * A store with a live inventory keyed by PHYSICAL collection: an index created
 * on the alias name lands nowhere, so a runner that forgets to resolve the
 * physical name keeps reporting the index missing.
 */
function createStore(indexes: PayloadFieldIndex[]): PayloadIndexStore & {
  inventory: Map<string, PayloadFieldIndex>;
} {
  const inventory = new Map(indexes.map((index) => [index.field, index]));
  return {
    inventory,
    resolvePhysicalCollection: vi.fn(async (name: string) => (name === ALIAS ? PHYSICAL : name)),
    listPayloadIndexes: vi.fn(async (collection: string) => (collection === PHYSICAL ? [...inventory.values()] : [])),
    createPayloadIndex: vi.fn(async (collection: string, field: string, schema: PayloadFieldIndexSchema) => {
      if (collection === PHYSICAL) inventory.set(field, { field, dataType: schema, points: 0 });
    }),
  };
}

/** The index set this build requires on every collection. */
const REQUIRED = new Map<string, PayloadFieldIndexSchema>([
  ["relativePath", "text"],
  ["methodLines", "float"],
  ["git.file.recentDominantAuthorPct", "float"],
  ["git.chunk.relativeChurn", "float"],
]);

/** Keys an index may exist on without being required (every declared payload signal). */
const KNOWN = new Set([...REQUIRED.keys(), "git.chunk.ageDays", "startLine"]);

function runnerFor(store: PayloadIndexStore): MigrationRunner & PayloadIndexMigrator {
  return new PayloadIndexMigrator(ALIAS, store, { required: REQUIRED, known: KNOWN });
}

describe("PayloadIndexMigrator", () => {
  it("reports the latest version when every required index exists and nothing is undeclared", async () => {
    const store = createStore([
      { field: "relativePath", dataType: "text", points: 10 },
      { field: "methodLines", dataType: "integer", points: 10 },
      { field: "git.file.recentDominantAuthorPct", dataType: "float", points: 10 },
      { field: "git.chunk.relativeChurn", dataType: "float", points: 10 },
      { field: "git.chunk.ageDays", dataType: "integer", points: 10 },
    ]);
    const runner = runnerFor(store);

    expect(await runner.getVersion()).toBe(runner.latestVersion);
    expect(store.listPayloadIndexes).toHaveBeenCalledWith(PHYSICAL);
  });

  it("creates only the missing required indexes, on the physical collection, with the declared schema", async () => {
    const store = createStore([
      { field: "relativePath", dataType: "text", points: 10 },
      { field: "git.file.recentDominantAuthorPct", dataType: "float", points: 10 },
    ]);

    const summary = await new Migrator({ payloadIndexes: runnerFor(store) } as never).run("payloadIndexes");

    expect(vi.mocked(store.createPayloadIndex).mock.calls).toEqual([
      [PHYSICAL, "git.chunk.relativeChurn", "float"],
      [PHYSICAL, "methodLines", "float"],
    ]);
    expect(summary.steps.flatMap((step) => step.applied ?? [])).toEqual([
      `created git.chunk.relativeChurn:float on ${PHYSICAL}`,
      `created methodLines:float on ${PHYSICAL}`,
    ]);
  });

  // An existing index of another data type (the legacy `integer` methodLines
  // the pre-q34ic name heuristic created) serves the filter; recreating it
  // would drop and rebuild an index on every point for nothing.
  it("treats an index as present by field, whatever data type it was created with", async () => {
    const store = createStore([
      { field: "relativePath", dataType: "text", points: 10 },
      { field: "methodLines", dataType: "integer", points: 10 },
      { field: "git.file.recentDominantAuthorPct", dataType: "float", points: 10 },
    ]);

    await new Migrator({ payloadIndexes: runnerFor(store) } as never).run("payloadIndexes");

    expect(vi.mocked(store.createPayloadIndex).mock.calls.map(([, field]) => field)).toEqual([
      "git.chunk.relativeChurn",
    ]);
  });

  it("is a single read and no write on the second run", async () => {
    const store = createStore([{ field: "relativePath", dataType: "text", points: 10 }]);
    const migrator = new Migrator({ payloadIndexes: runnerFor(store) } as never);

    await migrator.run("payloadIndexes");
    vi.mocked(store.createPayloadIndex).mockClear();
    vi.mocked(store.listPayloadIndexes).mockClear();

    const second = await migrator.run("payloadIndexes");

    expect(second.steps).toEqual([]);
    expect(store.createPayloadIndex).not.toHaveBeenCalled();
    expect(store.listPayloadIndexes).toHaveBeenCalledTimes(1);
  });

  // Dropping is a schema migration's call (v16 is the one-shot precedent): an
  // index this build does not know may be one a NEWER build declared, and a
  // per-run drop by an older install would turn that build's filter into a
  // silent full scan. The reconcile names it and leaves it.
  it("reports an undeclared index without dropping it", async () => {
    const store = createStore([
      { field: "relativePath", dataType: "text", points: 10 },
      { field: "methodLines", dataType: "float", points: 10 },
      { field: "git.file.recentDominantAuthorPct", dataType: "float", points: 10 },
      { field: "git.chunk.relativeChurn", dataType: "float", points: 10 },
      { field: "git.file.fanIn", dataType: "float", points: 0 },
    ]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const runner = runnerFor(store);

    expect(await runner.getVersion()).toBeLessThan(runner.latestVersion);
    const summary = await new Migrator({ payloadIndexes: runner } as never).run("payloadIndexes");

    expect(store.createPayloadIndex).not.toHaveBeenCalled();
    expect(store.inventory.has("git.file.fanIn")).toBe(true);
    expect(summary.steps.flatMap((step) => step.applied ?? [])).toEqual([
      `undeclared git.file.fanIn:float (0 points) on ${PHYSICAL} — kept`,
    ]);
    expect(errors.mock.calls.flat().join(" ")).toContain("git.file.fanIn");
    errors.mockRestore();
  });

  it("refuses an empty required set — a failed build of the declaration, not an empty one", () => {
    expect(() => new PayloadIndexMigrator(ALIAS, createStore([]), { required: new Map(), known: new Set() })).toThrow(
      /required/,
    );
  });
});
