/**
 * Bounded method-name reads over `cg_symbols` (naming coverage for untyped
 * methods, spec §D4 / §D4a): the store answers "which heads open names with how
 * many noun tails, and how often they end a name", "which verbs contest a tail"
 * and "which method names match these patterns" in SQL, so the naming
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
import type {
  IdentifierDeclarationKind,
  IdentifierRow,
  SymbolDefinition,
  SymbolDefinitionKind,
} from "../../../../src/core/contracts/types/codegraph.js";
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
  [
    "app/g.rb",
    "ruby",
    [
      symbol("app/g.rb", "G#update_user", "method"),
      symbol("app/g.rb", "G#update_account", "method"),
      symbol("app/g.rb", "G#user_name", "method"),
    ],
  ],
  ["app/k.rb", "ruby", [symbol("app/k.rb", "K#update_user!", "method")]],
  [
    "web/h.ts",
    "typescript",
    [symbol("web/h.ts", "H#updateOrder", "method"), symbol("web/h.ts", "H#updateUser", "method")],
  ],
  ["spec/i_spec.rb", "ruby", [symbol("spec/i_spec.rb", "I#update_invoice", "method")]],
  ["lib/m.py", "python", [symbol("lib/m.py", "M#__init__", "method")]],
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

  describe("readMethodHeadWords", () => {
    it("counts a head's holders, distinct noun tails across casings, and the names it ends", async () => {
      // update: update_user, update_user!, update_account, updateOrder, updateUser — tails user/account/order.
      // load and fetch open one tail each, so two tails keep them out.
      expect(await db.readMethodHeadWords({ ...scope, minTails: 2 })).toEqual([
        { head: "update", headHolders: 5, headTails: 3, lastHolders: 0, valueCompounds: 0 },
      ]);
    });

    it("computes lastHolders from the last word of snake and camel names, markers dropped", async () => {
      // user opens user_name once and ends load_user ×2, fetch_user, loadUser, update_user, update_user!, updateUser.
      expect(await db.readMethodHeadWords({ ...scope, minTails: 1 })).toEqual([
        { head: "update", headHolders: 5, headTails: 3, lastHolders: 0, valueCompounds: 0 },
        { head: "load", headHolders: 3, headTails: 1, lastHolders: 0, valueCompounds: 0 },
        { head: "fetch", headHolders: 1, headTails: 1, lastHolders: 0, valueCompounds: 0 },
        { head: "user", headHolders: 1, headTails: 1, lastHolders: 7, valueCompounds: 0 },
      ]);
    });

    it("stays within the languages; an empty language scope reads nothing", async () => {
      expect(await db.readMethodHeadWords({ ...scope, minTails: 1, languages: ["typescript"] })).toEqual([
        { head: "update", headHolders: 2, headTails: 2, lastHolders: 0, valueCompounds: 0 },
        { head: "load", headHolders: 1, headTails: 1, lastHolders: 0, valueCompounds: 0 },
      ]);
      expect(await db.readMethodHeadWords({ ...scope, minTails: 1, languages: [] })).toEqual([]);
    });

    it("drops the excluded files and never reads a non-production file", async () => {
      // spec/i_spec.rb declares update_invoice: counted, update would open four tails.
      expect(await db.readMethodHeadWords({ ...scope, minTails: 2, excludePaths: ["app/g.rb", "app/k.rb"] })).toEqual([
        { head: "update", headHolders: 2, headTails: 2, lastHolders: 0, valueCompounds: 0 },
      ]);
    });

    it("never reads a constructor as a head or a last word", async () => {
      expect(await db.readMethodHeadWords({ ...scope, minTails: 1, languages: ["python"] })).toEqual([]);
    });

    it("applies minTails per file language when grouping by it", async () => {
      expect(await db.readMethodHeadWords({ ...scope, minTails: 2, groupByLanguage: true })).toEqual([
        { head: "update", headHolders: 3, headTails: 2, lastHolders: 0, valueCompounds: 0, language: "ruby" },
        { head: "update", headHolders: 2, headTails: 2, lastHolders: 0, valueCompounds: 0, language: "typescript" },
      ]);
    });
  });

  describe("readMethodHeadWords valueCompounds", () => {
    const identifier = (name: string, kind: IdentifierDeclarationKind): IdentifierRow => ({
      ownerSymbolId: "Owner#m",
      kind,
      name,
      line: 1,
    });

    beforeEach(async () => {
      const files: readonly (readonly [string, string, readonly IdentifierRow[]])[] = [
        // Fields name a value with their sigil dropped; two spellings of one compound count once.
        ["app/x.rb", "ruby", [identifier("@update_account", "field"), identifier("update_account", "local")]],
        ["app/y.rb", "ruby", [identifier("@@update_user", "field")]],
        // A ruby param spelled like the typescript method updateUser.
        ["app/q.rb", "ruby", [identifier("updateUser", "param")]],
        // A return row names no value; a non-production file is outside the evidence.
        ["web/r.ts", "typescript", [identifier("updateOrder", "return")]],
        ["spec/s_spec.rb", "ruby", [identifier("updateOrder", "local")]],
      ];
      for (const [relPath, language] of files) {
        await db.run("INSERT INTO cg_symbols_files (rel_path, language) VALUES (?, ?)", [relPath, language]);
      }
      await db.replaceIdentifiersBulk(files.map(([relPath, , rows]) => ({ relPath, rows: [...rows] })));
    });

    it("counts the distinct compounds a head opens that name a non-return value in scope", async () => {
      // update opens update_user(!), update_account, updateOrder, updateUser: three name a value.
      expect(await db.readMethodHeadWords({ ...scope, minTails: 1 })).toEqual([
        { head: "update", headHolders: 5, headTails: 3, lastHolders: 0, valueCompounds: 3 },
        { head: "load", headHolders: 3, headTails: 1, lastHolders: 0, valueCompounds: 0 },
        { head: "fetch", headHolders: 1, headTails: 1, lastHolders: 0, valueCompounds: 0 },
        { head: "user", headHolders: 1, headTails: 1, lastHolders: 7, valueCompounds: 0 },
      ]);
    });

    it("reads the values from the evidence scope the methods are read from", async () => {
      expect(await db.readMethodHeadWords({ ...scope, minTails: 2, excludePaths: ["app/q.rb"] })).toEqual([
        { head: "update", headHolders: 5, headTails: 3, lastHolders: 0, valueCompounds: 2 },
      ]);
      // typescript names updateUser, but the only value spelled so is declared in a ruby file.
      expect(await db.readMethodHeadWords({ ...scope, minTails: 2, languages: ["typescript"] })).toEqual([
        { head: "update", headHolders: 2, headTails: 2, lastHolders: 0, valueCompounds: 0 },
      ]);
    });

    it("matches a value within the method's file language when grouping by it", async () => {
      expect(await db.readMethodHeadWords({ ...scope, minTails: 2, groupByLanguage: true })).toEqual([
        { head: "update", headHolders: 3, headTails: 2, lastHolders: 0, valueCompounds: 2, language: "ruby" },
        { head: "update", headHolders: 2, headTails: 2, lastHolders: 0, valueCompounds: 0, language: "typescript" },
      ]);
    });
  });

  describe("readMethodTailVerbs", () => {
    it("returns only tails more than one of the heads opens, with the most-held spelling (ties by name)", async () => {
      // user: load ×3, fetch ×1, update ×3 — contested. account (update only) and order (update only) are not.
      expect(await db.readMethodTailVerbs({ ...scope, heads: ["load", "fetch", "update"] })).toEqual([
        { tail: "user", head: "load", holders: 3, name: "load_user" },
        { tail: "user", head: "update", holders: 3, name: "updateUser" },
        { tail: "user", head: "fetch", holders: 1, name: "fetch_user" },
      ]);
    });

    it("reads only the heads asked for; one head contests nothing", async () => {
      expect(await db.readMethodTailVerbs({ ...scope, heads: ["update"] })).toEqual([]);
      expect(await db.readMethodTailVerbs({ ...scope, heads: [] })).toEqual([]);
    });

    it("reports the file language per row when grouping by it", async () => {
      expect(await db.readMethodTailVerbs({ ...scope, heads: ["load", "update"], groupByLanguage: true })).toEqual([
        { tail: "user", head: "load", holders: 2, name: "load_user", language: "ruby" },
        { tail: "user", head: "update", holders: 2, name: "update_user", language: "ruby" },
        { tail: "user", head: "load", holders: 1, name: "loadUser", language: "typescript" },
        { tail: "user", head: "update", holders: 1, name: "updateUser", language: "typescript" },
      ]);
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
