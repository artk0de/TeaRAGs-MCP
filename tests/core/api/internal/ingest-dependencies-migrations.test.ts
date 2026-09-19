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
    expect(summary).toMatchObject({ fromVersion: 15, toVersion: 18 });
  });

  // bd tea-rags-mcp-9mwny — the same sweep then gives the self-index the
  // last-commit timestamp indexes the age / modifiedAfter filters range over,
  // and bd tea-rags-mcp-y1870 the recentAuthors keyword index the `contributor`
  // typed filter matches on.
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
    ]);
    expect(qdrant.ensurePayloadIndex).toHaveBeenCalledWith("code_8b243ffe", "git.file.lastModifiedAt", "integer");
    expect(qdrant.ensurePayloadIndex).toHaveBeenCalledWith("code_8b243ffe", "git.chunk.lastModifiedAt", "integer");
    expect(qdrant.ensurePayloadIndex).toHaveBeenCalledWith("code_8b243ffe", "git.file.recentAuthors", "keyword");
  });

  it("stamps new collections at the latest version, which includes v16 through v18", async () => {
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
      expect.objectContaining({ payload: expect.objectContaining({ schemaVersion: 18 }) }),
    ]);
  });
});
