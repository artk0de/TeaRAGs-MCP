/**
 * Bounded method-name reads over `cg_symbols` (naming coverage for untyped
 * methods, spec §D4): the store answers "how many production methods open with
 * verb V" and "which method names match these patterns" in SQL, so the naming
 * lexicon never pulls the project's method table into memory. Only `method` /
 * `function` symbols count, constructors never do, non-production files never
 * do, and the evidence scope (exclude paths, languages) applies as it does to
 * every other lexicon read.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { SymbolDefinition, SymbolDefinitionKind } from "../../../../src/core/contracts/types/codegraph.js";
import { languageTestFileConventions } from "../../../../src/core/domains/language/capability/native.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";
import { nonProductionPathPatterns } from "../../../../src/core/infra/file-classification/index.js";

const NON_PRODUCTION_PATHS = nonProductionPathPatterns(languageTestFileConventions());
const PATTERN = "^(?:load|fetch)(?:_user[!?]?|User)$";

function symbol(relPath: string, symbolId: string, symbolKind: SymbolDefinitionKind): SymbolDefinition {
  const shortName = symbolId.split("#").at(-1) ?? symbolId;
  return { symbolId, fqName: symbolId, shortName, relPath, scope: [], symbolKind };
}

const FILES: readonly (readonly [string, string, readonly SymbolDefinition[]])[] = [
  [
    "app/a.rb",
    "ruby",
    [symbol("app/a.rb", "User#load_user", "method"), symbol("app/a.rb", "User#initialize", "method")],
  ],
  ["app/b.rb", "ruby", [symbol("app/b.rb", "Account#load_user", "method")]],
  ["app/c.rb", "ruby", [symbol("app/c.rb", "User#fetch_user", "method"), symbol("app/c.rb", "User#loader", "method")]],
  ["app/d.rb", "ruby", [symbol("app/d.rb", "User", "class")]],
  ["web/e.ts", "typescript", [symbol("web/e.ts", "Api#loadUser", "method")]],
  ["spec/f_spec.rb", "ruby", [symbol("spec/f_spec.rb", "X#load_user", "method")]],
];

describe("method-name reads over cg_symbols", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-method-names-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
    for (const [relPath, language, definitions] of FILES) {
      await db.run("INSERT INTO cg_symbols_files (rel_path, language) VALUES (?, ?)", [relPath, language]);
      await db.upsertSymbols(relPath, [...definitions]);
    }
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const scope = { nonProductionPaths: NON_PRODUCTION_PATHS };

  describe("readMethodVerbs", () => {
    it("counts production method holders per leading verb, snake_case and camelCase alike", async () => {
      expect(await db.readMethodVerbs({ ...scope, verbs: ["load", "fetch"] })).toEqual([
        { verb: "load", holders: 3 },
        { verb: "fetch", holders: 1 },
      ]);
    });

    it("splits a camelCase name at its first capital", async () => {
      expect(await db.readMethodVerbs({ ...scope, verbs: ["load"], languages: ["typescript"] })).toEqual([
        { verb: "load", holders: 1 },
      ]);
    });

    it("stays within the languages; an empty language scope reads nothing", async () => {
      expect(await db.readMethodVerbs({ ...scope, verbs: ["load", "fetch"], languages: ["ruby"] })).toEqual([
        { verb: "load", holders: 2 },
        { verb: "fetch", holders: 1 },
      ]);
      expect(await db.readMethodVerbs({ ...scope, verbs: ["load", "fetch"], languages: [] })).toEqual([]);
    });

    it("drops the excluded files", async () => {
      expect(await db.readMethodVerbs({ ...scope, verbs: ["load"], excludePaths: ["app/a.rb"] })).toEqual([
        { verb: "load", holders: 2 },
      ]);
    });

    it("never counts a constructor", async () => {
      expect(await db.readMethodVerbs({ ...scope, verbs: ["initialize"] })).toEqual([]);
    });

    it("reports the file language per row when grouping by it", async () => {
      expect(await db.readMethodVerbs({ ...scope, verbs: ["load", "fetch"], groupByLanguage: true })).toEqual([
        { verb: "load", holders: 2, language: "ruby" },
        { verb: "fetch", holders: 1, language: "ruby" },
        { verb: "load", holders: 1, language: "typescript" },
      ]);
    });

    it("reads nothing for no verbs", async () => {
      expect(await db.readMethodVerbs({ ...scope, verbs: [] })).toEqual([]);
    });
  });

  describe("readMethodNamesMatching", () => {
    it("counts holders per matching production method name", async () => {
      expect(await db.readMethodNamesMatching({ ...scope, patterns: [PATTERN] })).toEqual([
        { shortName: "load_user", holders: 2 },
        { shortName: "fetch_user", holders: 1 },
        { shortName: "loadUser", holders: 1 },
      ]);
    });

    it("drops the excluded files and honours the language scope", async () => {
      expect(await db.readMethodNamesMatching({ ...scope, patterns: [PATTERN], excludePaths: ["app/a.rb"] })).toEqual([
        { shortName: "fetch_user", holders: 1 },
        { shortName: "loadUser", holders: 1 },
        { shortName: "load_user", holders: 1 },
      ]);
      expect(await db.readMethodNamesMatching({ ...scope, patterns: [PATTERN], languages: ["ruby"] })).toEqual([
        { shortName: "load_user", holders: 2 },
        { shortName: "fetch_user", holders: 1 },
      ]);
      expect(await db.readMethodNamesMatching({ ...scope, patterns: [PATTERN], languages: [] })).toEqual([]);
    });

    it("matches any of several patterns, and never a constructor or a class", async () => {
      expect(await db.readMethodNamesMatching({ ...scope, patterns: ["^initialize$", "^User$", "^loader$"] })).toEqual([
        { shortName: "loader", holders: 1 },
      ]);
    });

    it("reports the file language per row when grouping by it", async () => {
      expect(await db.readMethodNamesMatching({ ...scope, patterns: [PATTERN], groupByLanguage: true })).toEqual([
        { shortName: "load_user", holders: 2, language: "ruby" },
        { shortName: "fetch_user", holders: 1, language: "ruby" },
        { shortName: "loadUser", holders: 1, language: "typescript" },
      ]);
    });

    it("reads nothing for no patterns", async () => {
      expect(await db.readMethodNamesMatching({ ...scope, patterns: [] })).toEqual([]);
    });
  });
});
