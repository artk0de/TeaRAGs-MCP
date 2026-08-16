import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { fileScopedSymbolKey } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

/**
 * bd tea-rags-mcp-oxnvl — file-scoped adjacency.
 *
 * `cg_symbols_edges_method` carries `source_rel_path` / `target_rel_path` on
 * every row, but the bare `getCalleeEdges` projects them away and joins on the
 * BARE symbolId. Top-level symbols (React function components, `BaseTable` in
 * three directories) share a bare symbolId across files, so the bare adjacency
 * merges namesakes into one graph node and a traced path silently crosses
 * between them. `getCalleeEdgesScoped` keys on `(relPath, symbolId)` instead.
 */
describe("DuckDbGraphClient — getCalleeEdgesScoped (oxnvl)", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-callee-scoped-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Two files declaring the SAME bare symbolId `BaseTable`, each calling its own row renderer. */
  async function seedNamesakes(): Promise<void> {
    await db.upsertFile(
      { relPath: "ui/BaseTable.tsx", language: "typescript" },
      {
        fileEdges: [],
        methodEdges: [
          {
            sourceSymbolId: "BaseTable",
            targetSymbolId: "renderUiRow",
            targetRelPath: "ui/row.tsx",
            callExpression: "renderUiRow",
            edgeKind: "exact",
            confidence: 1,
          },
        ],
      },
    );
    await db.upsertFile(
      { relPath: "admin/BaseTable.tsx", language: "typescript" },
      {
        fileEdges: [],
        methodEdges: [
          {
            sourceSymbolId: "BaseTable",
            targetSymbolId: "renderAdminRow",
            targetRelPath: "admin/row.tsx",
            callExpression: "renderAdminRow",
            edgeKind: "exact",
            confidence: 1,
          },
        ],
      },
    );
  }

  it("returns only the requested file's edges for a namesake source", async () => {
    await seedNamesakes();

    const uiKey = fileScopedSymbolKey({ relPath: "ui/BaseTable.tsx", symbolId: "BaseTable" });
    const scoped = await db.getCalleeEdgesScoped([{ relPath: "ui/BaseTable.tsx", symbolId: "BaseTable" }]);

    expect([...scoped.keys()]).toEqual([uiKey]);
    expect(scoped.get(uiKey)).toEqual([{ relPath: "ui/row.tsx", symbolId: "renderUiRow" }]);

    // Non-vacuity: the BARE reader is what merges the two namesakes into one node.
    const bare = await db.getCalleeEdges(["BaseTable"]);
    expect((bare.get("BaseTable") ?? []).slice().sort()).toEqual(["renderAdminRow", "renderUiRow"]);
  });

  it("keeps each namesake's edges under its own key when both are requested", async () => {
    await seedNamesakes();

    const uiKey = fileScopedSymbolKey({ relPath: "ui/BaseTable.tsx", symbolId: "BaseTable" });
    const adminKey = fileScopedSymbolKey({ relPath: "admin/BaseTable.tsx", symbolId: "BaseTable" });
    const scoped = await db.getCalleeEdgesScoped([
      { relPath: "ui/BaseTable.tsx", symbolId: "BaseTable" },
      { relPath: "admin/BaseTable.tsx", symbolId: "BaseTable" },
    ]);

    expect(scoped.get(uiKey)).toEqual([{ relPath: "ui/row.tsx", symbolId: "renderUiRow" }]);
    expect(scoped.get(adminKey)).toEqual([{ relPath: "admin/row.tsx", symbolId: "renderAdminRow" }]);
  });

  it("collapses two call sites of the same edge into one adjacency target (DISTINCT)", async () => {
    await db.upsertFile(
      { relPath: "ui/BaseTable.tsx", language: "typescript" },
      {
        fileEdges: [],
        methodEdges: [
          // Same (source, target) pair reached from TWO distinct call expressions —
          // two rows in the table, one adjacency edge for traversal.
          {
            sourceSymbolId: "BaseTable",
            targetSymbolId: "renderUiRow",
            targetRelPath: "ui/row.tsx",
            callExpression: "renderUiRow",
            edgeKind: "exact",
            confidence: 1,
          },
          {
            sourceSymbolId: "BaseTable",
            targetSymbolId: "renderUiRow",
            targetRelPath: "ui/row.tsx",
            callExpression: "this.renderUiRow",
            edgeKind: "exact",
            confidence: 1,
          },
        ],
      },
    );

    // Non-vacuity: both call sites ARE persisted as separate rows.
    const rawRows = await db.queryAll<{ n: number | bigint }>(
      "SELECT COUNT(*) AS n FROM cg_symbols_edges_method WHERE source_symbol_id = 'BaseTable'",
    );
    expect(Number(rawRows[0].n)).toBe(2);

    const uiKey = fileScopedSymbolKey({ relPath: "ui/BaseTable.tsx", symbolId: "BaseTable" });
    const scoped = await db.getCalleeEdgesScoped([{ relPath: "ui/BaseTable.tsx", symbolId: "BaseTable" }]);
    expect(scoped.get(uiKey)).toEqual([{ relPath: "ui/row.tsx", symbolId: "renderUiRow" }]);
  });

  it("hides dynamic residual edges (confidence<1) exactly like the bare reader", async () => {
    await db.upsertFile(
      { relPath: "app/src.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: [
          {
            sourceSymbolId: "Source#call",
            targetSymbolId: "TargetDynamic#low",
            targetRelPath: "app/low.rb",
            callExpression: "low.action",
            edgeKind: "dynamic",
            confidence: 0.5,
          },
          {
            sourceSymbolId: "Source#call",
            targetSymbolId: "TargetExact#method",
            targetRelPath: "app/exact.rb",
            callExpression: "exact.method",
            edgeKind: "exact",
            confidence: 1,
          },
        ],
      },
    );

    const key = fileScopedSymbolKey({ relPath: "app/src.rb", symbolId: "Source#call" });
    const scoped = await db.getCalleeEdgesScoped([{ relPath: "app/src.rb", symbolId: "Source#call" }]);

    expect((scoped.get(key) ?? []).map((t) => t.symbolId)).toEqual(["TargetExact#method"]);
  });

  it("returns an empty map for an empty ref list and for a ref whose file has no edges", async () => {
    await seedNamesakes();

    expect(await db.getCalleeEdgesScoped([])).toEqual(new Map());
    expect(await db.getCalleeEdgesScoped([{ relPath: "nowhere/BaseTable.tsx", symbolId: "BaseTable" }])).toEqual(
      new Map(),
    );
  });
});

describe("DuckDbGraphClient — getSymbolRelPaths (oxnvl seed resolution)", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-symbol-relpaths-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists every file a symbol appears in, as source or as target", async () => {
    await db.upsertFile(
      { relPath: "ui/BaseTable.tsx", language: "typescript" },
      {
        fileEdges: [],
        methodEdges: [
          {
            sourceSymbolId: "BaseTable",
            targetSymbolId: "renderRow",
            targetRelPath: "ui/row.tsx",
            callExpression: "renderRow",
            edgeKind: "exact",
            confidence: 1,
          },
        ],
      },
    );
    await db.upsertFile(
      { relPath: "admin/BaseTable.tsx", language: "typescript" },
      {
        fileEdges: [],
        methodEdges: [
          {
            sourceSymbolId: "BaseTable",
            targetSymbolId: "renderAdminRow",
            targetRelPath: "admin/row.tsx",
            callExpression: "renderAdminRow",
            edgeKind: "exact",
            confidence: 1,
          },
        ],
      },
    );

    const paths = await db.getSymbolRelPaths(["BaseTable", "renderRow"]);

    expect((paths.get("BaseTable") ?? []).slice().sort()).toEqual(["admin/BaseTable.tsx", "ui/BaseTable.tsx"]);
    // Target-only symbol resolves through target_rel_path.
    expect(paths.get("renderRow")).toEqual(["ui/row.tsx"]);
    expect(paths.get("nope")).toBeUndefined();
  });

  it("returns an empty map for no ids", async () => {
    expect(await db.getSymbolRelPaths([])).toEqual(new Map());
  });
});
