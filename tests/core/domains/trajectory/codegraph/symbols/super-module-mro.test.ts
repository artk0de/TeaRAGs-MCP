/**
 * bd tea-rags-mcp-2oky5 — Ruby `super` module-method MRO resolution (cai0/Task 4).
 *
 * When `super` is written inside a MODULE method (not a class method), the
 * enclosing scope is the module name. The module has NO own ancestors that
 * define the member, so the class-keyed MRO walk misses. The
 * `resolveViaIncludingClasses` consensus path (Task 3) resolves via each
 * CLASS that includes/prepends the module: if every including class agrees on
 * the same parent definer, that target is emitted (precision 1.0).
 *
 * Fixture design note — MRO ordering in classAncestors:
 * The walker stores classAncestors as [superclass?, ...includes_in_decl_order].
 * `firstDefinerAfter(Tracer, m, A)` flattens this to a linear MRO and looks for
 * what comes AFTER Tracer. For Tracer to appear before Base in that list, the
 * fixture uses two modules (no explicit superclass) and includes Tracer FIRST,
 * Base SECOND: classAncestors["A"] = ["Tracer", "Base"]. This is the stored MRO
 * that makes `firstDefinerAfter` correctly find Base#m after Tracer.
 * (The alternative — class A < Base; include Tracer — stores ["Base","Tracer"],
 * Tracer last, nothing after → firstDefinerAfter returns null.)
 *
 * Fixture:
 *   base.rb   — module Base { def m }           defines the target
 *   tracer.rb — module Tracer { def m; super }  module-method super
 *   a.rb      — class A; include Tracer; include Base  including class 1
 *   b.rb      — class B; include Tracer; include Base  including class 2
 *
 * classAncestors (walker output):
 *   A → ["Tracer", "Base"]   (Tracer first → in MRO before Base)
 *   B → ["Tracer", "Base"]
 *
 * includedBy (buildIncludedBy inverts above):
 *   Tracer → ["A", "B"]      ← what the consensus path reads
 *   Base   → ["A", "B"]
 *
 * Expectation: Tracer#m's `super` resolves to Base#m via consensus:
 * firstDefinerAfter("Tracer", "m", "A") and "B" both return {Base#m} → agreed.
 * The ruby `super` receiverKind row in cg_run_stats has resolved >= 1.
 *
 * RED phase: fails BEFORE Task 4 wires `ctx.includedBy` because
 * `resolveViaIncludingClasses` sees includedBy = undefined → returns null.
 * GREEN phase: after wiring `buildIncludedBy(ancestorsForResolver,
 * prependedAncestorsForResolver)` → Tracer#m super resolves to Base#m.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolvePath(__dirname, "../../../../../../src/core/domains/maintenance/migration/database/migrations");

describe("CodegraphEnrichmentProvider — super module-method MRO (cai0/2oky5)", () => {
  let tmp: string;
  let root: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-super-mro-"));
    root = mkdtempSync(join(tmpdir(), "cg-super-mro-fixture-"));
    mkdirSync(root, { recursive: true });
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

  it("resolves a module-method super to the consensus base across including classes", async () => {
    // Fixture: Tracer is included into A and B alongside Base (a module that
    // defines the target method). Tracer is included LAST, which is what puts it
    // NEAREST in Ruby's MRO — `A.ancestors == [A, Tracer, Base]` — so `A.new.m`
    // runs Tracer#m and its `super` reaches Base#m. That is the ordering
    // firstDefinerAfter("Tracer", "m", A/B) has to reproduce.
    writeFileSync(join(root, "base.rb"), "module Base\n  def m; end\nend\n");
    writeFileSync(join(root, "tracer.rb"), "module Tracer\n  def m; super; end\nend\n");
    writeFileSync(join(root, "a.rb"), "class A\n  include Base\n  include Tracer\nend\n");
    writeFileSync(join(root, "b.rb"), "class B\n  include Base\n  include Tracer\nend\n");

    await provider.streamFileBatch(root, ["base.rb", "tracer.rb", "a.rb", "b.rb"]);
    await provider.finalizeSignals(root);

    const rows = await client.getRunStats();
    const rubyRows = rows.filter((r) => r.language === "ruby");

    // The `super` call in Tracer#m must be attempted and resolved to Base#m.
    const superRow = rubyRows.find((r) => r.receiverKind === "super");
    expect(superRow, "expected a 'super' receiverKind row for ruby").toBeDefined();
    expect(superRow!.attempted).toBeGreaterThanOrEqual(1);
    // Consensus across A and B both pointing to Base#m → resolved >= 1.
    expect(superRow!.resolved, "Tracer#m super must resolve to Base#m via module-MRO consensus").toBeGreaterThanOrEqual(
      1,
    );
  });

  it("resolves module-method super in the dominant class<Super;include M graphql pattern (cai0/2oky5 Task 5)", async () => {
    // Real graphql shape: class A < Base; include Tracer
    // Walker stores classAncestors["A"] = ["Base", "Tracer"] (superclass first).
    // classExtends["A"] = "Base" identifies the superclass.
    // Ruby MRO reorder puts Base last: [Tracer, Base].
    // firstDefinerAfter("Tracer", "m", "A") → Base#m.
    // Consensus across A and B both agree → resolved >= 1.
    writeFileSync(join(root, "base.rb"), "class Base\n  def m; end\nend\n");
    writeFileSync(join(root, "tracer.rb"), "module Tracer\n  def m; super; end\nend\n");
    writeFileSync(join(root, "a.rb"), "class A < Base\n  include Tracer\nend\n");
    writeFileSync(join(root, "b.rb"), "class B < Base\n  include Tracer\nend\n");

    await provider.streamFileBatch(root, ["base.rb", "tracer.rb", "a.rb", "b.rb"]);
    await provider.finalizeSignals(root);

    const rows = await client.getRunStats();
    const rubyRows = rows.filter((r) => r.language === "ruby");

    const superRow = rubyRows.find((r) => r.receiverKind === "super");
    expect(superRow, "expected a 'super' receiverKind row for ruby").toBeDefined();
    expect(superRow!.attempted).toBeGreaterThanOrEqual(1);
    expect(
      superRow!.resolved,
      "Tracer#m super must resolve to Base#m via MRO-reordered include-into-subclass consensus",
    ).toBeGreaterThanOrEqual(1);
  });
});
