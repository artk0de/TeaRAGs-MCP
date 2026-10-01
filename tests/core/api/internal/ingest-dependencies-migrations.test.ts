import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QdrantManager } from "../../../../src/core/adapters/qdrant/client.js";
import { createIngestDependencies } from "../../../../src/core/api/internal/ingest-dependencies.js";
import type { PayloadBuilder } from "../../../../src/core/contracts/types/provider.js";

/**
 * Guards the migration sweep's composition: a pipeline that Migrator does not
 * know about throws on run(), so a missing registration is a runtime failure of
 * every reindex rather than a type error. These assertions are the cheap way to
 * catch that — no collection, no indexing, no build output required.
 */
describe("createIngestDependencies — migration pipelines", () => {
  let snapshotDir: string;

  beforeEach(() => {
    snapshotDir = mkdtempSync(join(tmpdir(), "ingest-deps-"));
  });

  afterEach(() => {
    rmSync(snapshotDir, { recursive: true, force: true });
  });

  function migrator() {
    const deps = createIngestDependencies(
      {} as QdrantManager,
      snapshotDir,
      {} as PayloadBuilder,
      undefined,
      false,
      undefined,
    );
    return deps.createMigrator("code_test", "/project");
  }

  it("registers every pipeline the reindex sweep runs", async () => {
    const m = migrator();
    // No stats file in a fresh directory — the runner reports the latest
    // version and the sweep is a no-op, which is the point: registration must
    // hold even when there is nothing to migrate.
    await expect(m.run("stats")).resolves.toMatchObject({ pipeline: "stats", steps: [] });
  });

  it("rejects a pipeline nobody registered", async () => {
    const m = migrator();
    await expect(m.run("nope" as "stats")).rejects.toThrow(/Unknown migration pipeline/);
  });
});

/**
 * `payload_schema` of the tea-rags self-index (`code_8b243ffe`, Qdrant 1.18.2),
 * read 2026-09-18 at schemaVersion 15: `[field, data_type, points]`. The seven
 * `git.{file,chunk}.*` codegraph keys are the rank_chunks orphans bd
 * tea-rags-mcp-q34ic is about; `git.file.skippedAs` is a declared key that
 * happens to hold no value.
 */
const SELF_INDEX_PAYLOAD_SCHEMA: [string, string, number][] = [
  ["_type", "keyword", 2],
  ["chunkType", "keyword", 24622],
  ["codegraph.symbols.chunk.enrichedAt", "datetime", 10726],
  ["codegraph.symbols.chunk.fanIn", "integer", 7718],
  ["codegraph.symbols.chunk.fanOut", "integer", 7846],
  ["codegraph.symbols.chunk.pageRank", "float", 7846],
  ["codegraph.symbols.chunk.skippedAs", "keyword", 13896],
  ["codegraph.symbols.file.connectionCount", "integer", 10152],
  ["codegraph.symbols.file.enrichedAt", "datetime", 10726],
  ["codegraph.symbols.file.fanIn", "integer", 10152],
  ["codegraph.symbols.file.fanOut", "integer", 10152],
  ["codegraph.symbols.file.instability", "float", 10152],
  ["codegraph.symbols.file.isHub", "bool", 10152],
  ["codegraph.symbols.file.isLeaf", "bool", 10152],
  ["codegraph.symbols.file.skippedAs", "keyword", 13896],
  ["codegraph.symbols.file.transitiveImpact", "integer", 10152],
  ["fileExtension", "keyword", 24622],
  ["git.chunk.ageDays", "integer", 20603],
  ["git.chunk.blameContributorCount", "integer", 22173],
  ["git.chunk.bugFixRate", "float", 22173],
  ["git.chunk.changeDensity", "float", 22173],
  ["git.chunk.churnRatio", "float", 22173],
  ["git.chunk.churnVolatility", "float", 22173],
  ["git.chunk.commitCount", "integer", 22173],
  ["git.chunk.enrichedAt", "datetime", 22178],
  ["git.chunk.fanIn", "float", 0],
  ["git.chunk.fanOut", "float", 0],
  ["git.chunk.pageRank", "float", 0],
  ["git.chunk.recencyWeightedFreq", "float", 22173],
  ["git.chunk.relativeChurn", "float", 22173],
  ["git.chunk.skippedAs", "keyword", 2449],
  ["git.file.bugFixRate", "float", 24572],
  ["git.file.commitCount", "integer", 24572],
  ["git.file.enrichedAt", "datetime", 24622],
  ["git.file.fanIn", "float", 0],
  ["git.file.fanOut", "float", 0],
  ["git.file.isHub", "float", 0],
  ["git.file.skippedAs", "keyword", 0],
  ["git.file.transitiveImpact", "float", 0],
  ["language", "keyword", 24622],
  ["methodDensity", "float", 24568],
  ["methodLines", "integer", 12892],
  ["moduleMethodCount", "integer", 21569],
  ["parentSymbolId", "text", 18812],
  ["relativePath", "text", 24622],
  ["symbolId", "text", 24139],
];

describe("createIngestDependencies — schema v16 reconciliation", () => {
  let snapshotDir: string;

  beforeEach(() => {
    snapshotDir = mkdtempSync(join(tmpdir(), "ingest-deps-v16-"));
  });

  afterEach(() => {
    rmSync(snapshotDir, { recursive: true, force: true });
  });

  /** A collection stamped at schema v15 whose field indexes are the self-index's. */
  function selfIndexQdrant() {
    return {
      getPoint: vi.fn().mockResolvedValue({
        id: "__schema_metadata__",
        payload: { _type: "schema_metadata", schemaVersion: 15, indexes: [] },
      }),
      getCollectionInfo: vi.fn().mockResolvedValue({ vectorSize: 8, hybridEnabled: false }),
      addPoints: vi.fn().mockResolvedValue(undefined),
      listPayloadIndexes: vi
        .fn()
        .mockResolvedValue(SELF_INDEX_PAYLOAD_SCHEMA.map(([field, dataType, points]) => ({ field, dataType, points }))),
      deletePayloadIndex: vi.fn().mockResolvedValue(undefined),
      ensurePayloadIndex: vi.fn().mockResolvedValue(true),
    };
  }

  it("drops exactly the seven legacy git.* codegraph indexes from the self-index inventory", async () => {
    const qdrant = selfIndexQdrant();
    const deps = createIngestDependencies(
      qdrant as unknown as QdrantManager,
      snapshotDir,
      {} as PayloadBuilder,
      undefined,
      false,
      undefined,
    );

    const summary = await deps.createMigrator("code_8b243ffe", "/project").run("schema");

    expect(qdrant.deletePayloadIndex.mock.calls.map(([, field]) => field as string)).toEqual([
      "git.chunk.fanIn",
      "git.chunk.fanOut",
      "git.chunk.pageRank",
      "git.file.fanIn",
      "git.file.fanOut",
      "git.file.isHub",
      "git.file.transitiveImpact",
    ]);
    expect(summary).toMatchObject({ fromVersion: 15, toVersion: 19 });
  });

  // bd tea-rags-mcp-9mwny — the same sweep then gives the self-index the
  // last-commit timestamp indexes the age / modifiedAfter filters range over,
  // and bd tea-rags-mcp-y1870 the recentAuthors keyword index the `contributor`
  // typed filter matches on, and bd tea-rags-mcp-5xpq4 the exampleSymbolIds
  // text index find_symbol resolves a grouped test example through.
  it("ensures both last-commit timestamp indexes after the drop", async () => {
    const qdrant = selfIndexQdrant();
    const deps = createIngestDependencies(
      qdrant as unknown as QdrantManager,
      snapshotDir,
      {} as PayloadBuilder,
      undefined,
      false,
      undefined,
    );

    const summary = await deps.createMigrator("code_8b243ffe", "/project").run("schema");

    expect(summary.steps.map((step) => step.name)).toEqual([
      "schema-v16-drop-undeclared-payload-indexes",
      "schema-v17-last-commit-time-indexes",
      "schema-v18-recent-authors-index",
      "schema-v19-example-symbol-ids-text",
    ]);
    expect(qdrant.ensurePayloadIndex).toHaveBeenCalledWith("code_8b243ffe", "git.file.lastModifiedAt", "integer");
    expect(qdrant.ensurePayloadIndex).toHaveBeenCalledWith("code_8b243ffe", "git.chunk.lastModifiedAt", "integer");
    expect(qdrant.ensurePayloadIndex).toHaveBeenCalledWith("code_8b243ffe", "git.file.recentAuthors", "keyword");
    expect(qdrant.ensurePayloadIndex).toHaveBeenCalledWith("code_8b243ffe", "exampleSymbolIds", "text");
  });

  it("stamps new collections at the latest version, which includes v16 through v19", async () => {
    const qdrant = { ...selfIndexQdrant(), getPoint: vi.fn().mockResolvedValue(null), createPayloadIndex: vi.fn() };
    const deps = createIngestDependencies(
      qdrant as unknown as QdrantManager,
      snapshotDir,
      {} as PayloadBuilder,
      undefined,
      false,
      undefined,
    );

    await deps.createSchemaManager("code_new").initializeSchema("code_new");

    expect(qdrant.addPoints).toHaveBeenCalledWith("code_new", [
      expect.objectContaining({ payload: expect.objectContaining({ schemaVersion: 19 }) }),
    ]);
  });
});

/**
 * `payload_schema` field names of taxdome (`code_27622aef` → `code_27622aef_v13`,
 * Qdrant 1.18.2), read 2026-09-24 (bd tea-rags-mcp-mimq0): 42 indexes, missing
 * five that the self-index's rank_chunks history had created on it.
 */
const TAXDOME_PAYLOAD_INDEX_FIELDS = [
  "_type",
  "chunkType",
  "codegraph.symbols.chunk.enrichedAt",
  "codegraph.symbols.chunk.fanIn",
  "codegraph.symbols.chunk.fanOut",
  "codegraph.symbols.chunk.pageRank",
  "codegraph.symbols.chunk.skippedAs",
  "codegraph.symbols.file.connectionCount",
  "codegraph.symbols.file.enrichedAt",
  "codegraph.symbols.file.fanIn",
  "codegraph.symbols.file.fanOut",
  "codegraph.symbols.file.instability",
  "codegraph.symbols.file.isHub",
  "codegraph.symbols.file.isLeaf",
  "codegraph.symbols.file.skippedAs",
  "codegraph.symbols.file.transitiveImpact",
  "fileExtension",
  "git.chunk.ageDays",
  "git.chunk.blameContributorCount",
  "git.chunk.bugFixRate",
  "git.chunk.changeDensity",
  "git.chunk.churnRatio",
  "git.chunk.churnVolatility",
  "git.chunk.commitCount",
  "git.chunk.enrichedAt",
  "git.chunk.lastModifiedAt",
  "git.chunk.recencyWeightedFreq",
  "git.chunk.skippedAs",
  "git.file.blameContributorCount",
  "git.file.bugFixRate",
  "git.file.changeDensity",
  "git.file.churnVolatility",
  "git.file.commitCount",
  "git.file.enrichedAt",
  "git.file.lastModifiedAt",
  "git.file.recentAuthors",
  "git.file.recentDominantAuthorPct",
  "git.file.skippedAs",
  "language",
  "parentSymbolId",
  "relativePath",
  "symbolId",
];

describe("createIngestDependencies — payload index reconcile (bd tea-rags-mcp-mimq0)", () => {
  let snapshotDir: string;

  beforeEach(() => {
    snapshotDir = mkdtempSync(join(tmpdir(), "ingest-deps-payload-indexes-"));
  });

  afterEach(() => {
    rmSync(snapshotDir, { recursive: true, force: true });
  });

  /**
   * taxdome's inventory, held under the PHYSICAL collection only — as Qdrant
   * stores it. The alias resolves to it through `aliases.listAliases`.
   */
  function taxdomeQdrant() {
    const inventory = new Map<string, Set<string>>([["code_27622aef_v13", new Set(TAXDOME_PAYLOAD_INDEX_FIELDS)]]);
    return {
      aliases: {
        listAliases: vi.fn().mockResolvedValue([{ aliasName: "code_27622aef", collectionName: "code_27622aef_v13" }]),
      },
      listPayloadIndexes: vi.fn(async (collection: string) =>
        [...(inventory.get(collection) ?? [])].map((field) => ({ field, dataType: "float", points: 1 })),
      ),
      createPayloadIndex: vi.fn(async (collection: string, field: string) => {
        inventory.get(collection)?.add(field);
      }),
    };
  }

  function depsFor(qdrant: unknown) {
    return createIngestDependencies(
      qdrant as QdrantManager,
      snapshotDir,
      {} as PayloadBuilder,
      undefined,
      false,
      undefined,
    );
  }

  it("creates the indexes taxdome lacks on the physical collection the alias points at", async () => {
    const qdrant = taxdomeQdrant();

    await depsFor(qdrant).createMigrator("code_27622aef", "/project").run("payloadIndexes");

    const created = qdrant.createPayloadIndex.mock.calls.map(([, field]) => field);
    expect(created).toEqual(
      expect.arrayContaining([
        "methodLines",
        "methodDensity",
        "moduleMethodCount",
        "git.chunk.relativeChurn",
        "git.file.recencyWeightedFreq",
      ]),
    );
    expect(created.filter((field) => TAXDOME_PAYLOAD_INDEX_FIELDS.includes(field))).toEqual([]);
    expect(qdrant.createPayloadIndex.mock.calls.every(([collection]) => collection === "code_27622aef_v13")).toBe(true);
  });

  it("does nothing on the next run once the collection carries the declared set", async () => {
    const qdrant = taxdomeQdrant();
    const deps = depsFor(qdrant);

    await deps.createMigrator("code_27622aef", "/project").run("payloadIndexes");
    qdrant.createPayloadIndex.mockClear();
    const second = await deps.createMigrator("code_27622aef", "/project").run("payloadIndexes");

    expect(second.steps).toEqual([]);
    expect(qdrant.createPayloadIndex).not.toHaveBeenCalled();
  });

  // A `--force` builds a new `_vN` through initializeSchema, and the reindex
  // sweep never runs on a fresh collection — without this the rebuilt index
  // would start with none of the rank_chunks fields again.
  it("gives a new collection the declared order-by indexes at creation", async () => {
    const qdrant = {
      getPoint: vi.fn().mockResolvedValue(null),
      addPoints: vi.fn().mockResolvedValue(undefined),
      getCollectionInfo: vi.fn().mockResolvedValue({ vectorSize: 8, hybridEnabled: false }),
      createPayloadIndex: vi.fn().mockResolvedValue(undefined),
    };

    await depsFor(qdrant).createSchemaManager("code_new_v1").initializeSchema("code_new_v1");

    expect(qdrant.createPayloadIndex).toHaveBeenCalledWith("code_new_v1", "methodLines", "float");
    expect(qdrant.createPayloadIndex).toHaveBeenCalledWith("code_new_v1", "git.file.recentDominantAuthorPct", "float");
    const fields = qdrant.createPayloadIndex.mock.calls.map(([, field]) => field as string);
    expect(fields.length).toBe(new Set(fields).size);
  });
});
