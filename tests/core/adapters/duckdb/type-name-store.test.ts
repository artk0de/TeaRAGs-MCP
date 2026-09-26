/**
 * `readTypeNameRows` — the type-level symbols the naming lexicon derives type
 * roles from (bd tea-rags-mcp-vi0wx): each row carries its inheritance
 * ancestors from `cg_symbols_inheritance`, rows of unknown kind (`NULL`
 * `symbol_kind`, pre-migration-035) are excluded, diff mode's `excludePaths`
 * drops the changed files, and the non-production masks drop tooling and test
 * files exactly as the ontology report does.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type {
  InheritanceEdgeRow,
  SymbolDefinition,
  SymbolDefinitionKind,
  TypeNameQuery,
} from "../../../../src/core/contracts/types/codegraph.js";
import { languageTestFileConventions } from "../../../../src/core/domains/language/capability/native.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";
import { nonProductionPathPatterns } from "../../../../src/core/infra/file-classification/index.js";

const TYPE_KINDS: readonly SymbolDefinitionKind[] = ["class", "module", "interface", "enum", "type_alias"];
const NON_PRODUCTION_PATHS = nonProductionPathPatterns(languageTestFileConventions());

function query(partial: Partial<TypeNameQuery> = {}): TypeNameQuery {
  return { pathPrefixes: [], kinds: TYPE_KINDS, nonProductionPaths: NON_PRODUCTION_PATHS, ...partial };
}

function def(relPath: string, name: string, symbolKind?: SymbolDefinitionKind): SymbolDefinition {
  return {
    relPath,
    symbolId: name,
    fqName: name,
    shortName: name,
    scope: [],
    ...(symbolKind ? { symbolKind } : {}),
  };
}

function inherits(source: string, ancestor: string, ordinal: number): InheritanceEdgeRow {
  return {
    sourceFqName: source,
    sourceSymbolId: source,
    ancestorFqName: ancestor,
    ancestorSymbolId: null,
    kind: ordinal === 0 ? "super" : "implements",
    ordinal,
  };
}

describe("readTypeNameRows", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-type-names-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
    await db.upsertSymbolsBulk([
      { relPath: "src/strategies/exact.ts", definitions: [def("src/strategies/exact.ts", "ExactStrategy", "class")] },
      {
        relPath: "src/strategies/fuzzy.ts",
        definitions: [
          def("src/strategies/fuzzy.ts", "FuzzyStrategy", "class"),
          def("src/strategies/fuzzy.ts", "fuzzyScore", "function"),
        ],
      },
      { relPath: "src/stores/legacy.ts", definitions: [def("src/stores/legacy.ts", "LegacyStore")] },
      { relPath: "src/stores/kinds.ts", definitions: [def("src/stores/kinds.ts", "StoreKind", "enum")] },
      { relPath: "scripts/tool.ts", definitions: [def("scripts/tool.ts", "ToolRunner", "class")] },
      {
        relPath: "tests/strategies/exact.test.ts",
        definitions: [def("tests/strategies/exact.test.ts", "FakeStrategy", "class")],
      },
    ]);
    await db.upsertFile(
      { relPath: "src/strategies/exact.ts", language: "typescript" },
      {
        fileEdges: [],
        methodEdges: [],
        inheritance: [inherits("ExactStrategy", "BaseStrategy", 0), inherits("ExactStrategy", "Named", 1)],
      },
    );
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns type-level rows carrying their ancestors in declaration order", async () => {
    const rows = await db.readTypeNameRows(query());
    expect(rows).toEqual([
      {
        symbolId: "StoreKind",
        relPath: "src/stores/kinds.ts",
        shortName: "StoreKind",
        symbolKind: "enum",
        ancestors: [],
      },
      {
        symbolId: "ExactStrategy",
        relPath: "src/strategies/exact.ts",
        shortName: "ExactStrategy",
        symbolKind: "class",
        ancestors: ["BaseStrategy", "Named"],
      },
      {
        symbolId: "FuzzyStrategy",
        relPath: "src/strategies/fuzzy.ts",
        shortName: "FuzzyStrategy",
        symbolKind: "class",
        ancestors: [],
      },
    ]);
  });

  it("excludes rows of unknown kind and kinds outside the requested set", async () => {
    const ids = (await db.readTypeNameRows(query())).map((r) => r.symbolId);
    expect(ids).not.toContain("LegacyStore");
    expect(ids).not.toContain("fuzzyScore");
    expect((await db.readTypeNameRows(query({ kinds: ["enum"] }))).map((r) => r.symbolId)).toEqual(["StoreKind"]);
  });

  it("drops every row of a file named in excludePaths", async () => {
    const rows = await db.readTypeNameRows(query({ excludePaths: ["src/strategies/exact.ts"] }));
    expect(rows.map((r) => r.symbolId)).toEqual(["StoreKind", "FuzzyStrategy"]);
  });

  it("keeps non-production paths out: tooling and test files are absent", async () => {
    const paths = (await db.readTypeNameRows(query())).map((r) => r.relPath);
    expect(paths).not.toContain("scripts/tool.ts");
    expect(paths).not.toContain("tests/strategies/exact.test.ts");
  });

  it("scopes to the path prefixes", async () => {
    const rows = await db.readTypeNameRows(query({ pathPrefixes: ["src/stores/"] }));
    expect(rows.map((r) => r.symbolId)).toEqual(["StoreKind"]);
  });
});
