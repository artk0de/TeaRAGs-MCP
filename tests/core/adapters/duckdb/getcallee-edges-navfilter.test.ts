import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

/**
 * Regression test for the navigation-visibility WHERE clause in
 * `DuckDbGraphClient.getCalleeEdges` (xlnub final MUST-FIX).
 *
 * The SQL filter is:
 *   AND NOT (edge_kind = 'dynamic' AND COALESCE(confidence, 1) < 1)
 *
 * It must be SEMANTICALLY IDENTICAL to `isNavigationVisibleEdge` in
 * graph-facade.ts. This test locks in the four edge cases the rule covers:
 *
 *   dynamic + confidence < 1.0  → EXCLUDED  (untyped residual, hidden from BFS)
 *   dynamic + confidence == 1.0 → INCLUDED  (uniquely narrowed)
 *   exact   + any confidence    → INCLUDED  (always traversable)
 *   NULL edge_kind / NULL conf  → INCLUDED  (legacy backward-compat;
 *                                            COALESCE(NULL,1)=1 ≥ 1 → pass)
 */
describe("DuckDbGraphClient — getCalleeEdges navigation-visibility filter (xlnub)", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-getcallee-nav-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("hides dynamic residual (confidence<1), includes dynamic@1.0, exact, and legacy-NULL edges", async () => {
    // ── Insert three typed edges via the normal write path ──────────────────
    await db.upsertFile(
      { relPath: "app/src.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: [
          // 1. dynamic, confidence 0.5 → MUST be EXCLUDED (untyped residual).
          {
            sourceSymbolId: "Source#call",
            targetSymbolId: "TargetDynamic#low",
            targetRelPath: "app/low.rb",
            callExpression: "low.action",
            edgeKind: "dynamic",
            confidence: 0.5,
          },
          // 2. dynamic, confidence 1.0 → MUST be INCLUDED (narrowed-unique).
          {
            sourceSymbolId: "Source#call",
            targetSymbolId: "TargetDynamic#full",
            targetRelPath: "app/full.rb",
            callExpression: "full.action",
            edgeKind: "dynamic",
            confidence: 1.0,
          },
          // 3. exact edge → MUST be INCLUDED (non-dynamic kinds always pass).
          {
            sourceSymbolId: "Source#call",
            targetSymbolId: "TargetExact#method",
            targetRelPath: "app/exact.rb",
            callExpression: "exact.method",
            edgeKind: "exact",
            confidence: 1.0,
          },
        ],
      },
    );

    // ── Insert legacy row with NULL edge_kind/confidence directly ───────────
    // `upsertFile` always defaults edge_kind→'exact', confidence→1.0, so
    // a genuine pre-migration NULL row can only be created by raw INSERT.
    // The WHERE clause handles it via COALESCE(NULL, 1) = 1 ≥ 1 → INCLUDED.
    await db.run(
      `INSERT INTO cg_symbols_edges_method
         (source_symbol_id, source_rel_path, target_symbol_id, target_rel_path,
          call_expression, edge_kind, confidence)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
      ["Source#call", "app/src.rb", "TargetLegacy#method", "app/legacy.rb", "legacy.call"],
    );

    // ── Non-vacuity proof ────────────────────────────────────────────────────
    // Confirm the excluded edge IS present in the raw table.  Without the WHERE
    // clause, getCalleeEdges would return it — proving the test would FAIL if
    // the AND NOT (...) predicate were removed.
    const rawRows = await db.queryAll<{ target_symbol_id: string }>(
      "SELECT target_symbol_id FROM cg_symbols_edges_method WHERE source_symbol_id = 'Source#call' ORDER BY target_symbol_id",
    );
    const rawTargets = rawRows.map((r) => r.target_symbol_id);
    expect(rawTargets).toContain("TargetDynamic#low"); // in table → WHERE must be what excludes it

    // ── Visibility assertions ────────────────────────────────────────────────
    const adj = await db.getCalleeEdges(["Source#call"]);
    const targets = (adj.get("Source#call") ?? []).slice().sort();

    expect(targets).not.toContain("TargetDynamic#low"); // dynamic@0.5 — hidden residual
    expect(targets).toContain("TargetDynamic#full"); // dynamic@1.0 — narrowed-unique
    expect(targets).toContain("TargetExact#method"); // exact — always traversable
    expect(targets).toContain("TargetLegacy#method"); // NULL edge_kind — backward-compat
    expect(targets).toHaveLength(3);
  });
});
