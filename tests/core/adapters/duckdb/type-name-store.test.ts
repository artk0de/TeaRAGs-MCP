/**
 * `readTypeNameRows` — the type-level declarations the naming lexicon derives
 * type roles from (bd tea-rags-mcp-vi0wx): each row carries its ancestors, rows
 * of unknown kind are excluded, diff mode's `excludePaths` drops the changed
 * files, and the non-production masks drop tooling and test files exactly as
 * the ontology report does.
 *
 * INVARIANT CHANGED (bd tea-rags-mcp-l2pkp, spec §1b): the single source is
 * `cg_type_declarations` (migration 038), not `cg_symbols` joined to
 * `cg_symbols_inheritance` — so the fixture seeds that table, and a
 * re-opening (`reopens = true`) is never a type of the project. Every
 * expectation of the read is unchanged.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type {
  SymbolDefinitionKind,
  TypeDeclarationRow,
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

function decl(
  typeId: string,
  symbolKind: SymbolDefinitionKind,
  extra: Partial<TypeDeclarationRow> = {},
): TypeDeclarationRow {
  return {
    language: "typescript",
    typeId,
    shortName: typeId.split(".").at(-1) ?? typeId,
    symbolKind,
    line: 1,
    reopens: false,
    supertypes: [],
    ...extra,
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
    await db.replaceTypeDeclarationsBulk([
      {
        relPath: "src/strategies/exact.ts",
        rows: [decl("ExactStrategy", "class", { supertypes: ["BaseStrategy", "Named"] })],
      },
      {
        relPath: "src/strategies/fuzzy.ts",
        rows: [decl("FuzzyStrategy", "class"), decl("fuzzyScore", "constant")],
      },
      { relPath: "src/stores/kinds.ts", rows: [decl("StoreKind", "enum")] },
      { relPath: "scripts/tool.ts", rows: [decl("ToolRunner", "class")] },
      { relPath: "tests/strategies/exact.test.ts", rows: [decl("FakeStrategy", "class")] },
      // A re-opening of a type declared elsewhere is not one of the project's types.
      { relPath: "src/stores/extensions.ts", rows: [decl("StoreKind", "enum", { reopens: true })] },
    ]);
    // A row of unknown kind: the column is nullable, a walker never writes one.
    await db.run(
      "INSERT INTO cg_type_declarations (rel_path, language, type_id, short_name, symbol_kind, line, reopens, supertypes) VALUES ('src/stores/legacy.ts', 'typescript', 'LegacyStore', 'LegacyStore', NULL, 1, false, [])",
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

  // bd tea-rags-mcp-icuxg: a type draft is judged within its language's type namespace.
  it("scopes to the languages asked, every language when none are", async () => {
    await db.replaceTypeDeclarationsBulk([
      { relPath: "app/services/result.rb", rows: [decl("Result", "class", { language: "ruby" })] },
      { relPath: "web/result.js", rows: [decl("JsResult", "class", { language: "javascript" })] },
    ]);
    const ruby = await db.readTypeNameRows(query({ languages: ["ruby"] }));
    expect(ruby.map((r) => r.symbolId)).toEqual(["Result"]);
    const ecmascript = await db.readTypeNameRows(query({ languages: ["typescript", "javascript"] }));
    expect(ecmascript.map((r) => r.symbolId)).not.toContain("Result");
    expect(ecmascript.map((r) => r.symbolId)).toContain("JsResult");
    expect(ecmascript.map((r) => r.symbolId)).toContain("ExactStrategy");
    expect((await db.readTypeNameRows(query())).map((r) => r.symbolId)).toContain("Result");
  });

  it("never reads a re-opening", async () => {
    const paths = (await db.readTypeNameRows(query())).map((r) => r.relPath);
    expect(paths).not.toContain("src/stores/extensions.ts");
  });

  // The primary-type pick breaks ties by the first declared type of a file.
  it("returns a file's types in declaration-line order, not by id", async () => {
    await db.replaceTypeDeclarationsBulk([
      {
        relPath: "src/explore/reranker.ts",
        rows: [
          decl("ResolvedMode", "type_alias", { line: 30 }),
          decl("Reranker", "class", { line: 50 }),
          decl("RerankOptions", "interface", { line: 10 }),
        ],
      },
    ]);
    const rows = await db.readTypeNameRows(query({ pathPrefixes: ["src/explore/"] }));
    expect(rows.map((r) => r.symbolId)).toEqual(["RerankOptions", "ResolvedMode", "Reranker"]);
  });
});

/**
 * `replaceTypeDeclarationsBulk` — per-file replace of `cg_type_declarations`,
 * the `replaceIdentifiersBulk` contract (bd tea-rags-mcp-vi0wx), and the
 * table's rows leave with their file.
 */
describe("replaceTypeDeclarationsBulk", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-type-decl-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function allRows(): Promise<{ rel_path: string; type_id: string }[]> {
    return db.queryAll("SELECT rel_path, type_id FROM cg_type_declarations ORDER BY rel_path, type_id");
  }

  it("round-trips every column", async () => {
    await db.replaceTypeDeclarationsBulk([
      {
        relPath: "Sources/Request.swift",
        rows: [
          decl("Request.State", "enum", { language: "swift", shortName: "State", line: 12, supertypes: ["Sendable"] }),
          decl("Request", "class", { language: "swift", reopens: true }),
        ],
      },
    ]);
    expect(
      await db.queryAll(
        "SELECT rel_path, language, type_id, short_name, symbol_kind, line, reopens, supertypes FROM cg_type_declarations ORDER BY type_id",
      ),
    ).toEqual([
      {
        rel_path: "Sources/Request.swift",
        language: "swift",
        type_id: "Request",
        short_name: "Request",
        symbol_kind: "class",
        line: 1,
        reopens: true,
        supertypes: [],
      },
      {
        rel_path: "Sources/Request.swift",
        language: "swift",
        type_id: "Request.State",
        short_name: "State",
        symbol_kind: "enum",
        line: 12,
        reopens: false,
        supertypes: ["Sendable"],
      },
    ]);
  });

  it("a second replace for the same relPath leaves only the second call's rows", async () => {
    await db.replaceTypeDeclarationsBulk([{ relPath: "a.ts", rows: [decl("Old", "class"), decl("Gone", "enum")] }]);
    await db.replaceTypeDeclarationsBulk([{ relPath: "a.ts", rows: [decl("Fresh", "class")] }]);
    expect(await allRows()).toEqual([{ rel_path: "a.ts", type_id: "Fresh" }]);
  });

  it("is last-wins per relPath within one call and leaves unnamed files alone", async () => {
    await db.replaceTypeDeclarationsBulk([{ relPath: "b.ts", rows: [decl("Kept", "class")] }]);
    await db.replaceTypeDeclarationsBulk([
      { relPath: "a.ts", rows: [decl("First", "class")] },
      { relPath: "a.ts", rows: [decl("Second", "class")] },
    ]);
    expect(await allRows()).toEqual([
      { rel_path: "a.ts", type_id: "Second" },
      { rel_path: "b.ts", type_id: "Kept" },
    ]);
  });

  it("an entry with no rows clears its file", async () => {
    await db.replaceTypeDeclarationsBulk([{ relPath: "a.ts", rows: [decl("X", "class")] }]);
    await db.replaceTypeDeclarationsBulk([{ relPath: "a.ts", rows: [] }]);
    expect(await allRows()).toEqual([]);
  });

  it("removeFile deletes the file's rows and no other file's", async () => {
    await db.replaceTypeDeclarationsBulk([
      { relPath: "a.ts", rows: [decl("A", "class")] },
      { relPath: "b.ts", rows: [decl("B", "class")] },
    ]);
    await db.removeFile("a.ts");
    expect(await allRows()).toEqual([{ rel_path: "b.ts", type_id: "B" }]);
  });
});

/**
 * Member counts (bd tea-rags-mcp-ffxfc, migration 040): a declaration's
 * method / field census persists on its row, and the read answers per TYPE —
 * the sum over every production row of the same language and type id, so a
 * Ruby class body re-opened in a second file, or a re-opening that adds
 * members, counts once as one type. A type none of whose rows carries a census
 * (an index written before 040, a walker that takes none) reads as unknown: both
 * fields absent, never zero.
 */
describe("member counts", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-type-members-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips the counts and writes NULL for a row without a census", async () => {
    await db.replaceTypeDeclarationsBulk([
      {
        relPath: "src/cache.ts",
        rows: [decl("CacheStore", "interface", { methodCount: 2, fieldCount: 1 }), decl("Legacy", "class")],
      },
    ]);
    expect(
      await db.queryAll("SELECT type_id, method_count, field_count FROM cg_type_declarations ORDER BY type_id"),
    ).toEqual([
      { type_id: "CacheStore", method_count: 2, field_count: 1 },
      { type_id: "Legacy", method_count: null, field_count: null },
    ]);
  });

  it("rewrites a file whose only change is its census", async () => {
    await db.replaceTypeDeclarationsBulk([{ relPath: "src/a.ts", rows: [decl("A", "class")] }]);
    await db.replaceTypeDeclarationsBulk([
      { relPath: "src/a.ts", rows: [decl("A", "class", { methodCount: 1, fieldCount: 0 })] },
    ]);
    expect(await db.queryAll("SELECT method_count, field_count FROM cg_type_declarations")).toEqual([
      { method_count: 1, field_count: 0 },
    ]);
  });

  it("reads a type's counts summed over its production rows of the same language, unknown when none has one", async () => {
    await db.replaceTypeDeclarationsBulk([
      {
        relPath: "app/models/user.rb",
        rows: [decl("User", "class", { language: "ruby", methodCount: 2, fieldCount: 1 })],
      },
      {
        relPath: "app/models/user/search.rb",
        rows: [decl("User", "class", { language: "ruby", line: 3, methodCount: 4, fieldCount: 0 })],
      },
      // A spec file re-opening the class is not the project's code.
      {
        relPath: "spec/models/user_spec.rb",
        rows: [decl("User", "class", { language: "ruby", methodCount: 9, fieldCount: 9 })],
      },
      // A namesake in another language is another type.
      { relPath: "web/user.ts", rows: [decl("User", "interface", { methodCount: 0, fieldCount: 5 })] },
      { relPath: "app/models/legacy.rb", rows: [decl("Legacy", "class", { language: "ruby" })] },
    ]);
    const rows = await db.readTypeNameRows(query());
    const counts = rows.map((r) => [r.relPath, r.methodCount, r.fieldCount]);
    expect(counts).toEqual([
      ["app/models/legacy.rb", undefined, undefined],
      ["app/models/user.rb", 6, 1],
      ["app/models/user/search.rb", 6, 1],
      ["web/user.ts", 0, 5],
    ]);
    const legacy = rows.find((r) => r.symbolId === "Legacy");
    expect(legacy).not.toHaveProperty("methodCount");
    expect(legacy).not.toHaveProperty("fieldCount");
  });
});
