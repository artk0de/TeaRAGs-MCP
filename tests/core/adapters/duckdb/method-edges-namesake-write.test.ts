import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import {
  fileScopedSymbolKey,
  type InheritanceEdgeRow,
  type SymbolDefinition,
} from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

/**
 * bd tea-rags-mcp-ex28m — the WRITE path, end to end through the real client.
 *
 * The migration widens the primary key; these tests prove the rows actually
 * reach it. Two files declare the same bare `BaseTable` symbolId and call the
 * same target through the same expression — the exact tuple the old key
 * collapsed under `INSERT OR IGNORE`.
 */
describe("method-edge write path keeps namesake sources apart (ex28m)", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-namesake-write-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Same symbolId, same call expression, same resolved target — two files. */
  async function writeNamesakes(): Promise<void> {
    for (const relPath of ["ui/BaseTable.tsx", "admin/BaseTable.tsx"]) {
      await db.upsertFile(
        { relPath, language: "typescript" },
        {
          fileEdges: [],
          methodEdges: [
            {
              sourceSymbolId: "BaseTable",
              targetSymbolId: "renderRow",
              targetRelPath: "shared/row.tsx",
              callExpression: "renderRow",
              edgeKind: "exact",
              confidence: 1,
            },
          ],
        },
      );
    }
  }

  it("persists one edge row per namesake file through upsertFile", async () => {
    await writeNamesakes();

    const rows = await db.queryAll<{ source_rel_path: string }>(
      "SELECT source_rel_path FROM cg_symbols_edges_method WHERE source_symbol_id = 'BaseTable' ORDER BY source_rel_path",
    );
    expect(rows.map((r) => r.source_rel_path)).toEqual(["admin/BaseTable.tsx", "ui/BaseTable.tsx"]);
  });

  it("persists both namesakes through the bulk path too", async () => {
    await db.upsertFilesBulk(
      ["ui/BaseTable.tsx", "admin/BaseTable.tsx"].map((relPath) => ({
        node: { relPath, language: "typescript" },
        edges: {
          fileEdges: [],
          methodEdges: [
            {
              sourceSymbolId: "BaseTable",
              targetSymbolId: "renderRow",
              targetRelPath: "shared/row.tsx",
              callExpression: "renderRow",
              edgeKind: "exact" as const,
              confidence: 1,
            },
          ],
        },
      })),
    );

    const rows = await db.queryAll<{ n: number | bigint }>(
      "SELECT COUNT(*) AS n FROM cg_symbols_edges_method WHERE source_symbol_id = 'BaseTable'",
    );
    expect(Number(rows[0].n)).toBe(2);
  });

  it("serves each namesake its own adjacency through getCalleeEdgesScoped", async () => {
    await writeNamesakes();

    const scoped = await db.getCalleeEdgesScoped([
      { relPath: "ui/BaseTable.tsx", symbolId: "BaseTable" },
      { relPath: "admin/BaseTable.tsx", symbolId: "BaseTable" },
    ]);

    expect(scoped.get(fileScopedSymbolKey({ relPath: "ui/BaseTable.tsx", symbolId: "BaseTable" }))).toEqual([
      { relPath: "shared/row.tsx", symbolId: "renderRow" },
    ]);
    expect(scoped.get(fileScopedSymbolKey({ relPath: "admin/BaseTable.tsx", symbolId: "BaseTable" }))).toEqual([
      { relPath: "shared/row.tsx", symbolId: "renderRow" },
    ]);
  });

  it("re-walking one namesake file replaces only its own edges", async () => {
    await writeNamesakes();

    // The per-file lifecycle is scoped by source_rel_path; ui's re-walk now
    // resolves elsewhere, admin's edge must be untouched.
    await db.upsertFile(
      { relPath: "ui/BaseTable.tsx", language: "typescript" },
      {
        fileEdges: [],
        methodEdges: [
          {
            sourceSymbolId: "BaseTable",
            targetSymbolId: "renderCell",
            targetRelPath: "shared/cell.tsx",
            callExpression: "renderCell",
            edgeKind: "exact",
            confidence: 1,
          },
        ],
      },
    );

    const rows = await db.queryAll<{ source_rel_path: string; target_symbol_id: string }>(
      "SELECT source_rel_path, target_symbol_id FROM cg_symbols_edges_method ORDER BY source_rel_path",
    );
    expect(rows).toEqual([
      { source_rel_path: "admin/BaseTable.tsx", target_symbol_id: "renderRow" },
      { source_rel_path: "ui/BaseTable.tsx", target_symbol_id: "renderCell" },
    ]);
  });
});

/**
 * bd tea-rags-mcp-ex28m — `getCallers` dedupes the direct and poly-base result
 * sets by `(sourceSymbolId, callExpression)`. That key has the SAME namesake
 * blindness the primary key had: once the widened key lets both namesake rows
 * exist, this Set is what would throw one of them back away, so `get_callers`
 * would still under-report. The key has to carry the file too.
 */
describe("getCallers keeps namesake callers apart across the poly-base merge (ex28m)", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  const sym = (relPath: string, symbolId: string, scope: string[]): SymbolDefinition => ({
    symbolId,
    fqName: symbolId,
    shortName: symbolId.split("#").pop() ?? symbolId,
    relPath,
    scope,
  });

  const inh = (s: string, a: string): InheritanceEdgeRow => ({
    sourceFqName: s,
    sourceSymbolId: s,
    ancestorFqName: a,
    ancestorSymbolId: a,
    kind: "super",
    ordinal: 0,
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-namesake-callers-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);

    // Agent#check with one overriding subtype — enough to make getCallers run
    // its symmetric poly-base expansion, which is what triggers the dedupe.
    await db.upsertSymbols("agent.rb", [sym("agent.rb", "Agent#check", ["Agent"])]);
    await db.upsertSymbols("sub1.rb", [sym("sub1.rb", "Sub1#check", ["Sub1"])]);
    await db.upsertFile({ relPath: "agent.rb", language: "ruby" }, { fileEdges: [], methodEdges: [] });
    await db.upsertFile(
      { relPath: "sub1.rb", language: "ruby" },
      { fileEdges: [], methodEdges: [], inheritance: [inh("Sub1", "Agent")] },
    );

    // TWO namesake `Runner#run` callers in different files, each dispatching
    // polymorphically through the identical call expression.
    for (const relPath of ["jobs/a/runner.rb", "jobs/b/runner.rb"]) {
      await db.upsertSymbols(relPath, [sym(relPath, "Runner#run", ["Runner"])]);
      await db.upsertFile(
        { relPath, language: "ruby" },
        {
          fileEdges: [],
          methodEdges: [
            {
              sourceSymbolId: "Runner#run",
              targetSymbolId: "Agent#check",
              targetRelPath: "agent.rb",
              callExpression: "agent.check",
              edgeKind: "poly-base",
              confidence: 1,
            },
          ],
        },
      );
    }
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports the namesake caller in EVERY file it appears in", async () => {
    const callers = await db.getCallers("Sub1#check");

    // Both files call it; collapsing them to one loses a real call site.
    expect(callers.map((c) => c.sourceRelPath).sort()).toEqual(["jobs/a/runner.rb", "jobs/b/runner.rb"]);
  });

  it("still collapses a caller that BOTH the direct and poly-base queries return", async () => {
    // The dedupe's actual job: `Agent#check` is reached directly by both files
    // AND re-derived through the inheritance index, so each file must appear
    // exactly once — not twice.
    const callers = await db.getCallers("Agent#check");

    expect(callers.map((c) => c.sourceRelPath).sort()).toEqual(["jobs/a/runner.rb", "jobs/b/runner.rb"]);
  });
});
