/**
 * `excludePaths` on every evidence read of the naming lexicon (bd
 * tea-rags-mcp-vi0wx, spec §6.4): diff mode judges a changed file against the
 * project WITHOUT that file, so an incremental reindex that already stored the
 * change cannot let a new name vote for itself. Each read below sees the same
 * two files; excluding one drops exactly its rows, and an empty list reads
 * everything.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { IdentifierRow, OntologyReportQuery } from "../../../../src/core/contracts/types/codegraph.js";
import { languageTestFileConventions } from "../../../../src/core/domains/language/capability/native.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";
import { nonProductionPathPatterns } from "../../../../src/core/infra/file-classification/index.js";

const KEPT = "app/kept.rb";
const CHANGED = "app/changed.rb";

function row(ownerSymbolId: string, name: string, typeName: string, line: number): IdentifierRow {
  return {
    ownerSymbolId,
    kind: "local",
    name,
    line,
    typeName,
    typeSource: "binding",
    boundMember: "find",
    boundReceiver: typeName,
  };
}

describe("identifier evidence reads honour excludePaths", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-exclude-paths-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
    // `result` bound to five types in the changed file, once to Doc in the kept one.
    await db.replaceIdentifiersBulk([
      { relPath: KEPT, rows: [row("Kept#run", "doc", "Doc", 1)] },
      {
        relPath: CHANGED,
        rows: [
          row("Changed#run", "meta", "Doc", 1),
          ...["TypeA", "TypeB", "TypeC", "TypeD", "TypeE"].flatMap((typeName, i) => [
            row(`Changed#r${i}`, "result", typeName, 10 + 2 * i),
            row(`Changed#r${i}`, "result", typeName, 11 + 2 * i),
          ]),
        ],
      },
    ]);
    await db.upsertSymbols(KEPT, [{ symbolId: "Kept", fqName: "Kept", shortName: "Kept", relPath: KEPT, scope: [] }]);
    await db.upsertSymbols(CHANGED, [
      { symbolId: "Meta", fqName: "Meta", shortName: "Meta", relPath: CHANGED, scope: [] },
    ]);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const excludePaths = [CHANGED];

  it("by type: aggregate and count", async () => {
    expect((await db.aggregateIdentifiersByType({ types: ["Doc"] })).map((r) => r.name).sort()).toEqual([
      "doc",
      "meta",
    ]);
    expect((await db.aggregateIdentifiersByType({ types: ["Doc"], excludePaths })).map((r) => r.name)).toEqual(["doc"]);
    expect(await db.countIdentifiers({ types: ["Doc"], excludePaths })).toBe(1);
    expect(await db.countIdentifiers({ types: ["Doc"], excludePaths: [] })).toBe(2);
  });

  it("by callee", async () => {
    const rows = await db.aggregateIdentifiersByCallee({
      callees: [{ member: "find", receiver: "Doc" }],
      excludePaths,
    });
    expect(rows.map((r) => r.name)).toEqual(["doc"]);
  });

  it("by name, and the name's types (homonymy)", async () => {
    expect(await db.aggregateIdentifiersByName({ names: ["meta", "doc"], excludePaths })).toEqual([
      expect.objectContaining({ name: "doc" }),
    ]);
    expect(await db.identifierNameTypes(["meta", "doc"], excludePaths)).toEqual([
      { name: "doc", typeName: "Doc", n: 1 },
    ]);
  });

  it("the shape-prior sample", async () => {
    const sample = await db.sampleIdentifierShapes({ limit: 100, excludePaths });
    expect(sample.map((r) => r.name)).toEqual(["doc"]);
  });

  it("short-name collisions over cg_symbols", async () => {
    expect(await db.existingSymbolShortNames(["Meta", "Kept"])).toEqual(["Kept", "Meta"]);
    expect(await db.existingSymbolShortNames(["Meta", "Kept"], excludePaths)).toEqual(["Kept"]);
  });

  it("the generic-name summary of the ontology read", async () => {
    const q: OntologyReportQuery = {
      names: ["result"],
      nonConceptTypes: [],
      nonProductionPaths: nonProductionPathPatterns(languageTestFileConventions()),
      shadowsMethodExtensions: [],
      sections: [],
      limit: 1,
      thresholds: {
        minSupport: 5,
        synonymDominantShareCeiling: 0.8,
        genericMinTypes: 5,
        genericMaxTopTypeShare: 0.5,
        homonymMinTypeRows: 2,
        homonymMinTypeShare: 0.1,
        outlierMinDominantShare: 0.5,
        confidenceSupport: 20,
        namesPerItem: 6,
        groupPool: 40,
      },
    };
    expect((await db.readOntologyReportSummary(q)).genericNames.map((g) => g.name)).toEqual(["result"]);
    expect((await db.readOntologyReportSummary({ ...q, excludePaths })).genericNames).toEqual([]);
  });
});
