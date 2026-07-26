/**
 * G3a reproduction (bd tea-rags-mcp — ruby-graph-precision-wave2 / DEFECT-1
 * residual). LIVE shape: `spec/support/dnd_helpers.rb` STILL records
 * `cg_ambiguous_fanout` rows for `Capybara.current_session.driver.browser
 * .action…release.perform` DESPITE the DEFECT-1 external-root gate
 * (`chainRootConstantIsExternal`, commit 45df6d86) being present in the build.
 *
 * This test PINS the actual root cause and FALSIFIES the epic's ranked
 * hypothesis 1 (gem-group gating):
 *
 *   - `chainRootConstantIsExternal(receiver, ctx)` returns external iff
 *     `resolveConstant(root, ctx) === null`. It NEVER consults the Gemfile /
 *     gem catalogue, so which Gemfile GROUP declares `capybara` is irrelevant.
 *   - The taxdome repo ships `spec/support/gem_extensions/capybara.rb`, which
 *     REOPENS `module Capybara` to monkey-patch the gem. When that spec-support
 *     file is extracted into the codegraph symbol table, `Capybara` becomes an
 *     IN-PROJECT constant → `resolveConstant("Capybara")` is non-null → the
 *     external-root gate does NOT fire → the over-cap `.perform` fan-out
 *     records a `cg_ambiguous_fanout` aggregate.
 *
 * The two scenarios below are byte-identical EXCEPT for whether the
 * `module Capybara` reopening file is extracted. The Gemfile is identical in
 * both (`capybara` declared ONLY in `group :test`). The aggregate appears iff
 * the reopening is in the table — proving the cause is spec-support extraction,
 * NOT the Gemfile group. (Why the spec file gets extracted under
 * CODEGRAPH_EXCLUDE_TESTS at all is the cross-pass `acceptExtraction` bypass —
 * see the report; the `spec/` test glob already classifies these paths as test,
 * see tests/core/infra/file-classification/classify.test.ts.)
 *
 * Fixture mirrors the DEFECT-1 test (j0pki): `perform` defined in CLASS_COUNT
 * (18) model classes > the DISPATCH_FANOUT_CAP_FLOOR (16), >100 filler
 * shortNames pin corpus p99 = 1 so the cap stays at the floor.
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
import { runMigrations } from "../../../../../../src/core/infra/migration/database/runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolvePath(__dirname, "../../../../../../src/core/infra/migration/database/migrations");

const CLASS_COUNT = DISPATCH_FANOUT_CAP_FLOOR + 2; // 18 defs of `perform` > floor cap 16

// Gemfile declaring `capybara` ONLY in `group :test` (the shape the epic's
// hypothesis 1 blames). Identical across both scenarios — the gemfileGemNames
// parser recurses into group blocks, so `capybara` is captured regardless, and
// none of this feeds the constant-external gate anyway.
const GEMFILE = ["source 'https://rubygems.org'", "gem 'rails'", "group :test do", "  gem 'capybara'", "end", ""].join(
  "\n",
);

describe("CodegraphEnrichmentProvider — spec/support Capybara reopening defeats the external-root gate (G3a)", () => {
  let tmp: string;
  let root: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  /**
   * Write the shared fixture. `reopenCapybara` toggles ONLY the
   * `spec/support/gem_extensions/capybara.rb` monkey-patch that reopens
   * `module Capybara` — the single independent variable.
   */
  const writeFixture = (reopenCapybara: boolean): string[] => {
    mkdirSync(join(root, "app", "models"), { recursive: true });
    mkdirSync(join(root, "spec", "support", "gem_extensions"), { recursive: true });
    writeFileSync(join(root, "Gemfile"), GEMFILE);

    const paths: string[] = [];
    // 18 in-project `#perform` defs (> cap) + 6 unique fillers each (>100 total
    // distinct shortNames) to pin corpus p99 = 1 so the fan-out cap = floor.
    for (let i = 0; i < CLASS_COUNT; i++) {
      const fillers = Array.from({ length: 6 }, (_, j) => `  def filler_${i}_${j}\n  end\n`).join("");
      writeFileSync(join(root, "app", "models", `job_${i}.rb`), `class Job${i}\n  def perform\n  end\n${fillers}end\n`);
      paths.push(`app/models/job_${i}.rb`);
    }

    // The caller mirrors the live dnd_helpers shape: a chain ROOTED in the
    // `Capybara` constant reaching `.perform`. Lives in spec/support like the
    // real file (extraction is not gated here — direct mode, excludeTests off —
    // exactly as the cross-pass path forwards every chunked file).
    writeFileSync(
      join(root, "spec", "support", "dnd_helpers.rb"),
      [
        "module DndHelpers",
        "  def drag_and_drop",
        "    Capybara.current_session.driver.perform",
        "  end",
        "end",
        "",
      ].join("\n"),
    );
    paths.push("spec/support/dnd_helpers.rb");

    if (reopenCapybara) {
      // The taxdome gem monkey-patch: reopening `module Capybara` makes the
      // constant look IN-PROJECT to resolveConstant.
      writeFileSync(
        join(root, "spec", "support", "gem_extensions", "capybara.rb"),
        [
          "module Capybara",
          "  class Session",
          "    def visit_page",
          "    end",
          "  end",
          "end",
          "",
        ].join("\n"),
      );
      paths.push("spec/support/gem_extensions/capybara.rb");
    }
    return paths;
  };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-ambig-spec-reopen-prov-"));
    root = mkdtempSync(join(tmpdir(), "cg-ambig-spec-reopen-fixture-"));
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

  const aggregateExpressions = async (): Promise<string[]> => {
    const rows = await client.queryAll<{ call_expression: string; member: string }>(
      "SELECT call_expression, member FROM cg_ambiguous_fanout",
    );
    return rows.map((r) => r.call_expression);
  };

  it("gate FIRES when Capybara is external (no in-project reopening) — externalSkipped, NO aggregate", async () => {
    const paths = writeFixture(/* reopenCapybara */ false);
    await provider.streamFileBatch(root, paths);
    await provider.finalizeSignals(root);

    // resolveConstant("Capybara") === null → chainRootConstantIsExternal fires →
    // the over-cap fan-out is suppressed and the call is externalSkipped.
    expect(await aggregateExpressions()).not.toContain("Capybara.current_session.driver.perform");
    expect(await aggregateExpressions()).toHaveLength(0);

    const rubyRows = (await client.getRunStats()).filter((r) => r.language === "ruby");
    const externalSkipped = rubyRows.reduce((s, r) => s + (r.externalSkipped ?? 0), 0);
    const ambiguous = rubyRows.reduce((s, r) => s + (r.ambiguousFanout ?? 0), 0);
    expect(externalSkipped).toBeGreaterThanOrEqual(1);
    expect(ambiguous).toBe(0);
  });

  it("gate is DEFEATED when a spec/support file reopens module Capybara — records the aggregate (live dnd_helpers reproduction)", async () => {
    const paths = writeFixture(/* reopenCapybara */ true);
    await provider.streamFileBatch(root, paths);
    await provider.finalizeSignals(root);

    // The ONLY change vs the scenario above is the extracted `module Capybara`
    // reopening. The identical Gemfile (capybara in `group :test`) is present in
    // both, so this flip isolates the cause to the in-project reopening — NOT
    // the Gemfile group. resolveConstant("Capybara") now resolves to the spec
    // file → the external-root gate no longer fires → over-cap `.perform`
    // fan-out records the aggregate.
    expect(await aggregateExpressions()).toContain("Capybara.current_session.driver.perform");

    const rows = await client.queryAll<{ source_symbol_id: string; call_expression: string; member: string }>(
      "SELECT source_symbol_id, call_expression, member FROM cg_ambiguous_fanout",
    );
    const performRow = rows.find((r) => r.call_expression === "Capybara.current_session.driver.perform");
    expect(performRow).toMatchObject({ member: "perform" });

    const rubyRows = (await client.getRunStats()).filter((r) => r.language === "ruby");
    const ambiguous = rubyRows.reduce((s, r) => s + (r.ambiguousFanout ?? 0), 0);
    expect(ambiguous).toBeGreaterThanOrEqual(1);
  });
});
