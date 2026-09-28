/**
 * `languages` on every evidence read of the naming lexicon (bd
 * tea-rags-mcp-0qaht): a draft is judged within its language namespace, so in a
 * polyglot repo Ruby locals never vote on a TypeScript field. Each read below
 * sees one Ruby file and one TypeScript file; scoping to Ruby drops exactly the
 * TypeScript rows, an empty scope reads nothing, and no scope reads both.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { IdentifierRow } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

const RUBY = "app/account.rb";
const TS = "src/account.ts";

function row(ownerSymbolId: string, name: string, line: number): IdentifierRow {
  return {
    ownerSymbolId,
    kind: "local",
    name,
    line,
    typeName: "User",
    typeSource: "binding",
    boundMember: "find",
    boundReceiver: "User",
  };
}

describe("identifier evidence reads honour languages", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-language-scope-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
    await db.replaceIdentifiersBulk([
      { relPath: RUBY, rows: [row("Account#run", "account", 1)] },
      { relPath: TS, rows: [row("AccountService#run", "user", 1)] },
    ]);
    await db.run("INSERT INTO cg_symbols_files (rel_path, language) VALUES (?, 'ruby'), (?, 'typescript')", [RUBY, TS]);
    await db.upsertSymbols(RUBY, [
      { symbolId: "Account", fqName: "Account", shortName: "Account", relPath: RUBY, scope: [] },
    ]);
    await db.upsertSymbols(TS, [
      { symbolId: "AccountService", fqName: "AccountService", shortName: "AccountService", relPath: TS, scope: [] },
    ]);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const ruby = ["ruby"];
  const none: string[] = [];

  it("by type: aggregate and count stay within the languages", async () => {
    const names = async (languages?: string[]) =>
      (await db.aggregateIdentifiersByType({ types: ["User"], ...(languages ? { languages } : {}) }))
        .map((r) => r.name)
        .sort();
    expect(await names()).toEqual(["account", "user"]);
    expect(await names(ruby)).toEqual(["account"]);
    expect(await names(none)).toEqual([]);
    expect(await db.countIdentifiers({ types: ["User"] })).toBe(2);
    expect(await db.countIdentifiers({ types: ["User"], languages: ruby })).toBe(1);
    expect(await db.countIdentifiers({ types: ["User"], languages: none })).toBe(0);
  });

  it("by callee stays within the languages", async () => {
    const names = async (languages?: string[]) =>
      (
        await db.aggregateIdentifiersByCallee({
          callees: [{ member: "find", receiver: "User" }],
          ...(languages ? { languages } : {}),
        })
      )
        .map((r) => r.name)
        .sort();
    expect(await names()).toEqual(["account", "user"]);
    expect(await names(ruby)).toEqual(["account"]);
    expect(await names(none)).toEqual([]);
  });

  it("by name and the name's types (homonymy) stay within the languages", async () => {
    const byName = async (languages?: string[]) =>
      (await db.aggregateIdentifiersByName({ names: ["account", "user"], ...(languages ? { languages } : {}) }))
        .map((r) => r.name)
        .sort();
    expect(await byName()).toEqual(["account", "user"]);
    expect(await byName(ruby)).toEqual(["account"]);
    expect(await byName(none)).toEqual([]);
    expect((await db.identifierNameTypes(["account", "user"])).map((r) => r.name)).toEqual(["account", "user"]);
    expect(await db.identifierNameTypes(["account", "user"], undefined, ruby)).toEqual([
      { name: "account", typeName: "User", n: 1 },
    ]);
    expect(await db.identifierNameTypes(["account", "user"], [], none)).toEqual([]);
  });

  it("language counts stay within the languages", async () => {
    expect(await db.identifierLanguageCounts({})).toHaveLength(2);
    expect(await db.identifierLanguageCounts({ languages: ruby })).toEqual([{ language: "ruby", n: 1 }]);
    expect(await db.identifierLanguageCounts({ languages: none })).toEqual([]);
  });

  it("the shape-prior sample is drawn within the languages", async () => {
    const names = async (languages?: string[]) =>
      (await db.sampleIdentifierShapes({ limit: 100, ...(languages ? { languages } : {}) })).map((r) => r.name).sort();
    expect(await names()).toEqual(["account", "user"]);
    expect(await names(ruby)).toEqual(["account"]);
    expect(await names(none)).toEqual([]);
  });

  it("short-name collisions read only symbols of files in the languages", async () => {
    expect(await db.existingSymbolShortNames(["Account", "AccountService"])).toEqual(["Account", "AccountService"]);
    expect(await db.existingSymbolShortNames(["Account", "AccountService"], undefined, ruby)).toEqual(["Account"]);
    expect(await db.existingSymbolShortNames(["Account", "AccountService"], [], none)).toEqual([]);
  });

  it("a row of a file with no files row has no known language: no scope places it outside", async () => {
    await db.replaceIdentifiersBulk([{ relPath: "lib/orphan.rb", rows: [row("Orphan#run", "orphan", 1)] }]);
    expect(
      (await db.aggregateIdentifiersByType({ types: ["User"], languages: ruby })).map((r) => r.name).sort(),
    ).toEqual(["account", "orphan"]);
    expect(await db.aggregateIdentifiersByType({ types: ["User"], languages: none })).toEqual([]);
  });
});
