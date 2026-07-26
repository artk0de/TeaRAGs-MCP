/**
 * bd tea-rags-mcp-f2jsb / j0pki — over-cap dynamic dispatch fan-outs are
 * persisted as an AGGREGATE (`cg_ambiguous_fanout` + `ambiguous_fanout`
 * run-stats bucket) instead of m noise edges.
 *
 * Fixture: `firm` is defined in CLASS_COUNT (18) model classes — above the
 * DISPATCH_FANOUT_CAP_FLOOR (16) — while >100 distinct single-def shortNames
 * (filler methods) pin the corpus p99 at 1, so the corpus-adaptive cap stays at
 * the floor. The untyped-receiver call `x.firm` then fans out to 18 survivors >
 * cap 16 → `{kind: "ambiguous"}` (Task 2, commit 9aa83900). Task 3 must:
 *   - tally it in the run-stats `ambiguousFanout` bucket (its OWN bucket — NOT
 *     a genuine miss, NOT external, NOT unresolvable, NOT no-in-project-def)
 *   - persist the aggregate record via GraphEdges.ambiguousFanouts → upsertFile
 *   - keep the edge suppression (no m dynamic edges for the call)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DISPATCH_FANOUT_CAP_FLOOR } from "../../../../../../src/core/domains/language/kernel/fanout-policy.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolvePath(__dirname, "../../../../../../src/core/domains/maintenance/migration/database/migrations");

const CLASS_COUNT = DISPATCH_FANOUT_CAP_FLOOR + 2; // 18 defs of `firm` > floor cap 16

describe("CodegraphEnrichmentProvider — ambiguous fan-out aggregate (j0pki)", () => {
  let tmp: string;
  let root: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  const writeFixture = (): string[] => {
    mkdirSync(join(root, "src"), { recursive: true });
    const paths: string[] = [];
    for (let i = 0; i < CLASS_COUNT; i++) {
      // 6 unique filler methods per class keep >100 distinct shortNames in the
      // corpus so p99(defs-per-shortName) = 1 and the cap stays at the floor.
      const fillers = Array.from({ length: 6 }, (_, j) => `  def filler_${i}_${j}\n  end\n`).join("");
      writeFileSync(join(root, "src", `model_${i}.rb`), `class Model${i}\n  def firm\n  end\n${fillers}end\n`);
      paths.push(`src/model_${i}.rb`);
    }
    // `x` is an untyped param → dynamic receiver → short-name fan-out over the
    // 18 in-project `firm` defs → over-cap → ambiguous outcome.
    writeFileSync(join(root, "src", "caller.rb"), "class Caller\n  def go(x)\n    x.firm\n  end\nend\n");
    paths.push("src/caller.rb");
    return paths;
  };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-ambig-prov-"));
    root = mkdtempSync(join(tmpdir(), "cg-ambig-fixture-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
    provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      ...buildTestCodegraphDeps(),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("tallies the over-cap call in its own run-stats bucket and persists the aggregate record", async () => {
    const paths = writeFixture();
    await provider.streamFileBatch(root, paths);
    await provider.finalizeSignals(root);

    // Run-stats bucket: the ambiguous call is attempted, NOT resolved, and
    // lands ONLY in ambiguousFanout — the miss classifiers must not count it
    // (externalSkipped / unresolvable / noInProjectDef all stay 0; `firm` HAS
    // in-project defs, so a fall-through would leak into the recall hole).
    const rows = await client.getRunStats();
    const dynamic = rows.find((r) => r.language === "ruby" && r.receiverKind === "dynamic");
    expect(dynamic).toMatchObject({
      attempted: 1,
      resolved: 0,
      externalSkipped: 0,
      unresolvable: 0,
      noInProjectDef: 0,
      ambiguousFanout: 1,
    });

    // Aggregate record: one row keyed (source_symbol_id, call_expression),
    // carrying the member + survivor count for later covered-recall reporting.
    const aggRows = await client.queryAll<{
      source_symbol_id: string;
      source_rel_path: string;
      call_expression: string;
      member: string;
      candidate_count: number | bigint;
    }>("SELECT source_symbol_id, source_rel_path, call_expression, member, candidate_count FROM cg_ambiguous_fanout");
    expect(aggRows).toHaveLength(1);
    expect(aggRows[0]).toMatchObject({
      source_symbol_id: "Caller#go",
      source_rel_path: "src/caller.rb",
      call_expression: "x.firm",
      member: "firm",
    });
    expect(Number(aggRows[0].candidate_count)).toBe(CLASS_COUNT);

    // Edge suppression intact (Task 2): the over-cap fan-out emits NO method
    // edges — the aggregate REPLACES the m noise edges.
    const edges = await client.queryAll<{ n: number | bigint }>(
      "SELECT COUNT(*) AS n FROM cg_symbols_edges_method WHERE call_expression = 'x.firm'",
    );
    expect(Number(edges[0].n)).toBe(0);
  });
});
