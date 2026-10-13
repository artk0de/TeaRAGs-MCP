/**
 * `cg_symbols_edges_field` persistence (bd tea-rags-mcp-zy6hx, D0): the
 * per-file replace with its unchanged-file skip, the two reads (a method's
 * whole access set, a file's rows), the removed-file cascade, and the
 * dead-row class migration 049 keeps the table out of.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { DuckDbGraphSession } from "../../../../src/core/adapters/duckdb/graph-session.js";
import type { FieldAccessRow } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

function access(sourceSymbolId: string, fieldName: string, extra: Partial<FieldAccessRow> = {}): FieldAccessRow {
  return {
    sourceSymbolId,
    ownerKind: "self",
    ownerType: "Order",
    fieldName,
    accessKind: "read",
    accessCount: 1,
    firstLine: 1,
    ...extra,
  };
}

describe("DuckDbFieldAccessStore", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-field-access-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a method's whole access set back with its file, absent columns staying absent", async () => {
    await db.replaceFieldAccessesBulk([
      {
        relPath: "app/order.rb",
        rows: [
          access("Order#total", "@items", { accessCount: 3, firstLine: 4 }),
          access("Order#total", "@total", { accessKind: "write", firstLine: 6 }),
          access("Order#merge", "@items", {
            ownerKind: "param",
            receiver: "other",
            firstLine: 12,
          }),
          access("Order#merge", "@cache", { ownerKind: "unknown", ownerType: undefined, accessKind: "unknown" }),
        ],
      },
      { relPath: "app/invoice.rb", rows: [access("Invoice#total", "@lines", { ownerType: "Invoice" })] },
    ]);

    expect(await db.readFieldAccessesBySymbols(["Order#total"])).toEqual([
      { relPath: "app/order.rb", ...access("Order#total", "@items", { accessCount: 3, firstLine: 4 }) },
      { relPath: "app/order.rb", ...access("Order#total", "@total", { accessKind: "write", firstLine: 6 }) },
    ]);
    const merge = await db.readFieldAccessesBySymbols(["Order#merge"]);
    expect(merge).toEqual([
      {
        relPath: "app/order.rb",
        sourceSymbolId: "Order#merge",
        ownerKind: "unknown",
        fieldName: "@cache",
        accessKind: "unknown",
        accessCount: 1,
        firstLine: 1,
      },
      {
        relPath: "app/order.rb",
        ...access("Order#merge", "@items", { ownerKind: "param", receiver: "other", firstLine: 12 }),
      },
    ]);
    expect(await db.readFieldAccessesBySymbols(["Order#total", "Invoice#total"])).toHaveLength(3);
    expect(await db.readFieldAccessesBySymbols([])).toEqual([]);
  });

  it("reads per file, and a namesake in another file carries its own path", async () => {
    await db.replaceFieldAccessesBulk([
      { relPath: "a.ts", rows: [access("main", "#x")] },
      { relPath: "b.ts", rows: [access("main", "#y")] },
    ]);
    expect((await db.readFieldAccessesByFiles(["b.ts"])).map((r) => [r.relPath, r.fieldName])).toEqual([
      ["b.ts", "#y"],
    ]);
    expect((await db.readFieldAccessesBySymbols(["main"])).map((r) => r.relPath)).toEqual(["a.ts", "b.ts"]);
    expect(await db.readFieldAccessesByFiles([])).toEqual([]);
  });

  it("replaces a file's rows, clears a file given none, and leaves an unnamed file alone", async () => {
    await db.replaceFieldAccessesBulk([
      { relPath: "a.ts", rows: [access("A#m", "#x"), access("A#m", "#y")] },
      { relPath: "b.ts", rows: [access("B#m", "#z")] },
      { relPath: "c.ts", rows: [access("C#m", "#w")] },
    ]);
    await db.replaceFieldAccessesBulk([
      { relPath: "a.ts", rows: [access("A#m", "#x", { accessCount: 2 })] },
      { relPath: "b.ts", rows: [] },
    ]);
    const rows = await db.readFieldAccessesByFiles(["a.ts", "b.ts", "c.ts"]);
    expect(rows.map((r) => [r.relPath, r.fieldName, r.accessCount])).toEqual([
      ["a.ts", "#x", 2],
      ["c.ts", "#w", 1],
    ]);
  });

  it("keeps the last entry when one batch names a file twice", async () => {
    await db.replaceFieldAccessesBulk([
      { relPath: "a.ts", rows: [access("A#m", "#old")] },
      { relPath: "a.ts", rows: [access("A#m", "#new")] },
    ]);
    expect((await db.readFieldAccessesByFiles(["a.ts"])).map((r) => r.fieldName)).toEqual(["#new"]);
  });

  it("rewrites nothing for a file whose rows did not move, and scopes every DELETE to the files it names", async () => {
    await db.replaceFieldAccessesBulk([
      { relPath: "a.ts", rows: [access("A#m", "#x"), access("A#n", "#y", { receiver: undefined })] },
      { relPath: "b.ts", rows: [access("B#m", "#z")] },
    ]);
    const statements: string[] = [];
    const { run } = DuckDbGraphSession.prototype;
    vi.spyOn(DuckDbGraphSession.prototype, "run").mockImplementation(async function (
      this: DuckDbGraphSession,
      sql: string,
      params: unknown[] = [],
    ) {
      if (sql.includes("cg_symbols_edges_field")) statements.push(sql);
      return run.call(this, sql, params);
    });

    await db.replaceFieldAccessesBulk([
      // Same multiset, other order: unchanged.
      { relPath: "a.ts", rows: [access("A#n", "#y"), access("A#m", "#x")] },
      { relPath: "b.ts", rows: [access("B#m", "#z", { accessKind: "write" })] },
    ]);

    const deletes = statements.filter((sql) => sql.startsWith("DELETE"));
    expect(deletes).toHaveLength(1);
    expect(deletes.every((sql) => /\bWHERE source_rel_path IN \(/.test(sql))).toBe(true);
    expect(statements.filter((sql) => sql.startsWith("INSERT"))).toHaveLength(1);
    expect((await db.readFieldAccessesByFiles(["b.ts"]))[0]?.accessKind).toBe("write");
  });

  it("drops a removed file's rows, singly and in a batch", async () => {
    await db.replaceFieldAccessesBulk([
      { relPath: "a.ts", rows: [access("A#m", "#x")] },
      { relPath: "b.ts", rows: [access("B#m", "#y")] },
      { relPath: "c.ts", rows: [access("C#m", "#z")] },
    ]);
    await db.removeFile("a.ts");
    await db.removeFiles(["b.ts"]);
    expect((await db.readFieldAccessesByFiles(["a.ts", "b.ts", "c.ts"])).map((r) => r.relPath)).toEqual(["c.ts"]);
  });

  it("is a no-op for empty entries", async () => {
    await expect(db.replaceFieldAccessesBulk([])).resolves.toBeUndefined();
  });
});
