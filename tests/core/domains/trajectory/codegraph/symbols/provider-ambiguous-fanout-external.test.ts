/**
 * bd tea-rags-mcp-z9pky (DEFECT 1) — an over-cap dynamic dispatch fan-out whose
 * RECEIVER is provably external (a method chain rooted in an external constant,
 * e.g. taxdome's `Capybara.current_session.driver.browser.action…release.perform`)
 * must NOT record a `cg_ambiguous_fanout` aggregate. In `resolveExtraction` the
 * `{kind:"ambiguous"}` verdict is recorded BEFORE the `targetsExternalImport`
 * external check runs, so an external receiver that member-collides with an
 * over-cap in-project short-name wrongly persists a meaningless aggregate (which
 * later surfaces as `get_callers(includeAmbiguous:true)` noise). The external
 * check must run inside the ambiguous branch, re-classifying the call as
 * `externalSkipped` with no aggregate — while a genuine in-project untyped
 * over-cap fan-out still records its aggregate (regression guard).
 *
 * Fixture mirrors j0pki: `process` defined in CLASS_COUNT (18) model classes >
 * the DISPATCH_FANOUT_CAP_FLOOR (16), >100 filler shortNames pin corpus p99 = 1
 * so the cap stays at the floor. Two callers over the same over-cap member:
 *   - `ExternalGem.build.process` — receiver rooted in an undefined (external)
 *     constant → externalSkipped, NO aggregate.
 *   - `x.process` (untyped param) — in-project ambiguity → aggregate recorded.
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

const CLASS_COUNT = DISPATCH_FANOUT_CAP_FLOOR + 2; // 18 defs of `process` > floor cap 16

describe("CodegraphEnrichmentProvider — external-receiver ambiguous-fanout suppression (z9pky / DEFECT 1)", () => {
  let tmp: string;
  let root: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  const writeFixture = (): string[] => {
    mkdirSync(join(root, "src"), { recursive: true });
    const paths: string[] = [];
    for (let i = 0; i < CLASS_COUNT; i++) {
      const fillers = Array.from({ length: 6 }, (_, j) => `  def filler_${i}_${j}\n  end\n`).join("");
      writeFileSync(join(root, "src", `model_${i}.rb`), `class Model${i}\n  def process\n  end\n${fillers}end\n`);
      paths.push(`src/model_${i}.rb`);
    }
    // Two over-cap `process` fan-outs from ONE file:
    //   external_call  → `ExternalGem.wrangle.process` — receiver chain rooted in
    //                    an undefined constant (external), tail `wrangle` is NOT an
    //                    instance-returning verb so no type is inferred (mirrors
    //                    taxdome `Capybara…action…release.perform`) → must be
    //                    externalSkipped, NO aggregate.
    //   inproject_call → `x.process` (untyped param)  → in-project ambiguity kept.
    writeFileSync(
      join(root, "src", "caller.rb"),
      [
        "class Caller",
        "  def external_call",
        "    ExternalGem.wrangle.process",
        "  end",
        "  def inproject_call(x)",
        "    x.process",
        "  end",
        "end",
        "",
      ].join("\n"),
    );
    paths.push("src/caller.rb");
    return paths;
  };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-ambig-ext-prov-"));
    root = mkdtempSync(join(tmpdir(), "cg-ambig-ext-fixture-"));
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

  it("records NO aggregate for the external-rooted receiver, but keeps the in-project one", async () => {
    const paths = writeFixture();
    await provider.streamFileBatch(root, paths);
    await provider.finalizeSignals(root);

    // ── Core DEFECT-1 assertion: exactly ONE aggregate row, the in-project
    // `x.process` — the external `ExternalGem.build.process` must be absent.
    const aggRows = await client.queryAll<{
      source_symbol_id: string;
      call_expression: string;
      member: string;
    }>("SELECT source_symbol_id, call_expression, member FROM cg_ambiguous_fanout");
    const expressions = aggRows.map((r) => r.call_expression);
    expect(expressions).toContain("x.process");
    expect(expressions).not.toContain("ExternalGem.wrangle.process");
    expect(aggRows).toHaveLength(1);
    expect(aggRows[0]).toMatchObject({
      source_symbol_id: "Caller#inproject_call",
      call_expression: "x.process",
      member: "process",
    });

    // ── Run-stats: the external over-cap call is externalSkipped, NOT counted
    // in the ambiguousFanout bucket. The in-project one keeps ambiguousFanout=1.
    const rows = await client.getRunStats();
    const rubyRows = rows.filter((r) => r.language === "ruby");
    const totalExternalSkipped = rubyRows.reduce((s, r) => s + (r.externalSkipped ?? 0), 0);
    const totalAmbiguous = rubyRows.reduce((s, r) => s + (r.ambiguousFanout ?? 0), 0);
    expect(totalExternalSkipped).toBeGreaterThanOrEqual(1);
    expect(totalAmbiguous).toBe(1);
  });
});
