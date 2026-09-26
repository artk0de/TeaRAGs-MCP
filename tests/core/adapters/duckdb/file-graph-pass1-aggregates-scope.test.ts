/**
 * `listPass1Aggregates` reads only the languages the caller names. A
 * TypeScript-only recompute on taxdome used to pull 9,184 Ruby slices out of
 * `cg_pass1_aggregates` — and parse every one's JSON — only for the barrier to
 * park them in a family no TypeScript resolver reads. The filter belongs in the
 * SELECT, before the parse.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function seededDb(): Promise<DuckDbGraphClient> {
  const dir = mkdtempSync(join(tmpdir(), "cg-pass1-scope-"));
  const db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
  await db.init();
  await runMigrations(db, DATABASE_MIGRATIONS);
  cleanups.push(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const rows: [string, string, string][] = [
    ["src/base.ts", "typescript", JSON.stringify({ classExtends: { Service: "BaseService" } })],
    ["src/legacy.js", "javascript", JSON.stringify({ classExtends: { Legacy: "Base" } })],
    ["app/models/firm.rb", "ruby", JSON.stringify({ classExtends: { Firm: "ApplicationRecord" } })],
  ];
  for (const row of rows) {
    await db.run("INSERT INTO cg_pass1_aggregates (rel_path, language, aggregates_json) VALUES (?, ?, ?)", row);
  }
  return db;
}

const relPaths = (rows: readonly { relPath: string }[]): string[] => rows.map((r) => r.relPath).sort();

describe("DuckDbGraphClient.listPass1Aggregates", () => {
  it("returns only the rows of the named languages", async () => {
    const db = await seededDb();

    const rows = await db.listPass1Aggregates({ kind: "languages", languages: ["typescript", "javascript"] });

    expect(relPaths(rows)).toEqual(["src/base.ts", "src/legacy.js"]);
    expect(rows.find((r) => r.relPath === "src/base.ts")).toEqual({
      relPath: "src/base.ts",
      language: "typescript",
      classExtends: { Service: "BaseService" },
    });
  });

  it("returns nothing for an empty language list", async () => {
    const db = await seededDb();

    expect(await db.listPass1Aggregates({ kind: "languages", languages: [] })).toEqual([]);
  });

  it("returns every row only when the caller asks for all languages", async () => {
    const db = await seededDb();

    const rows = await db.listPass1Aggregates({ kind: "allLanguages" });

    expect(relPaths(rows)).toEqual(["app/models/firm.rb", "src/base.ts", "src/legacy.js"]);
  });
});
