/**
 * bd tea-rags-mcp-bvalc — constructor-arg parameter typing, e2e.
 *
 * End-to-end through the REAL provider two-pass (walker → extraction → pass-1
 * accumulation → pass-1→pass-2 barrier fold → ctx thread → resolve chain), on
 * the shape the ivar census says accounts for two thirds of Ruby's ivar recall
 * hole:
 *
 *   class Service
 *     def initialize(firm)   # untyped parameter, no YARD anywhere
 *       @firm = firm
 *     end
 *     def go
 *       @firm.owner          # unresolvable until `firm` has a type
 *     end
 *   end
 *
 *   Service.new(Firm.new)    # ← the type, one hop away, at the CALL SITE
 *
 * The unit tests inject hand-built maps; only this test guards the FQ alignment
 * across the four seams (walker candidate chain ↔ chunk symbolId index ↔ ivar
 * link key ↔ `ctx.callerScope.join("::")`), where a drift would be silent.
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
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { runMigrations } from "../../../../../../src/core/infra/migration/database/runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolvePath(__dirname, "../../../../../../src/core/infra/migration/database/migrations");

interface MethodEdge {
  source_symbol_id: string;
  target_symbol_id: string;
  call_expression: string;
}

describe("CodegraphEnrichmentProvider — constructor-arg param typing (bvalc)", () => {
  let tmp: string;
  let root: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  const write = (paths: string[], name: string, lines: string[]): void => {
    writeFileSync(join(root, "src", name), `${lines.join("\n")}\n`);
    paths.push(`src/${name}`);
  };

  const writeFixture = (): string[] => {
    mkdirSync(join(root, "src"), { recursive: true });
    const paths: string[] = [];
    write(paths, "firm.rb", ["class Firm", "  def owner", "    :me", "  end", "end"]);
    write(paths, "person.rb", ["class Person", "  def owner", "    :nobody", "  end", "end"]);
    // The service under test. NOTHING here declares a type: `firm` is a bare
    // positional parameter and `@firm` a verbatim copy of it.
    write(paths, "service.rb", [
      "class Service",
      "  def initialize(firm)",
      "    @firm = firm",
      "  end",
      "  def go",
      "    @firm.owner",
      "  end",
      "end",
    ]);
    // TWO call sites that AGREE — the mechanism binds on agreement, and using
    // two proves the fold is not accidentally reading only the last record.
    write(paths, "alpha_controller.rb", [
      "class AlphaController",
      "  def create",
      "    Service.new(Firm.new)",
      "  end",
      "end",
    ]);
    write(paths, "beta_controller.rb", [
      "class BetaController",
      "  def create",
      "    firm = Firm.new",
      "    Service.new(firm)",
      "  end",
      "end",
    ]);
    return paths;
  };

  /** A second service whose two call sites DISAGREE about the same position. */
  const writeConflicting = (paths: string[]): void => {
    write(paths, "conflicted.rb", [
      "class Conflicted",
      "  def initialize(thing)",
      "    @thing = thing",
      "  end",
      "  def go",
      "    @thing.owner",
      "  end",
      "end",
    ]);
    write(paths, "gamma_controller.rb", [
      "class GammaController",
      "  def a",
      "    Conflicted.new(Firm.new)",
      "  end",
      "  def b",
      "    Conflicted.new(Person.new)",
      "  end",
      "end",
    ]);
  };

  /** A service whose parameter carries an explicit YARD type. */
  const writeDeclared = (paths: string[]): void => {
    write(paths, "declared.rb", [
      "class Declared",
      "  # @param [Person] thing",
      "  def initialize(thing)",
      "    @thing = thing",
      "  end",
      "  def go",
      "    @thing.owner",
      "  end",
      "end",
    ]);
    write(paths, "delta_controller.rb", [
      "class DeltaController",
      "  def a",
      "    Declared.new(Firm.new)",
      "  end",
      "end",
    ]);
  };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-ctor-param-prov-"));
    root = mkdtempSync(join(tmpdir(), "cg-ctor-param-fixture-"));
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

  const run = async (extra?: (paths: string[]) => void): Promise<MethodEdge[]> => {
    const paths = writeFixture();
    extra?.(paths);
    await provider.streamFileBatch(root, paths);
    await provider.finalizeSignals(root);
    return client.queryAll<MethodEdge>(
      "SELECT source_symbol_id, target_symbol_id, call_expression FROM cg_symbols_edges_method",
    );
  };

  it("types `@firm` from the constructor argument, so `@firm.owner` resolves", async () => {
    const edges = await run();
    expect(edges).toContainEqual({
      source_symbol_id: "Service#go",
      target_symbol_id: "Firm#owner",
      call_expression: "@firm.owner",
    });
  });

  it("resolves `@firm.owner` to exactly one target — narrowing, not fan-out", async () => {
    const edges = await run();
    expect(edges.filter((e) => e.call_expression === "@firm.owner")).toHaveLength(1);
  });

  it("commits to NOTHING when two call sites disagree about the argument's type", async () => {
    const edges = await run(writeConflicting);
    // `@thing` stays untyped, so the call keeps the untyped-receiver fan-out it
    // had before the mechanism existed. The invariant is the ABSENCE of
    // narrowing: picking either disagreeing caller's type would show up as a
    // single pinned target.
    const targets = edges
      .filter((e) => e.source_symbol_id === "Conflicted#go")
      .map((e) => e.target_symbol_id)
      .sort();
    expect(targets).toEqual(["Firm#owner", "Person#owner"]);
  });

  it("a disagreement on one callee does not poison another callee's parameter", async () => {
    const edges = await run(writeConflicting);
    expect(edges).toContainEqual({
      source_symbol_id: "Service#go",
      target_symbol_id: "Firm#owner",
      call_expression: "@firm.owner",
    });
  });

  it("a declared YARD @param WINS over the call-site inference", async () => {
    const edges = await run(writeDeclared);
    // The call site hands over a `Firm`; the annotation says `Person`. The
    // annotation is the contract — the caller is the one that is wrong.
    expect(edges).toContainEqual({
      source_symbol_id: "Declared#go",
      target_symbol_id: "Person#owner",
      call_expression: "@thing.owner",
    });
    expect(
      edges.filter((e) => e.source_symbol_id === "Declared#go" && e.target_symbol_id === "Firm#owner"),
    ).toHaveLength(0);
  });

  it("types the parameter INSIDE the constructor too, not only through the ivar", async () => {
    const paths = writeFixture();
    write(paths, "inline.rb", [
      "class Inline",
      "  def initialize(firm)",
      "    firm.owner",
      "  end",
      "end",
    ]);
    write(paths, "epsilon_controller.rb", [
      "class EpsilonController",
      "  def create",
      "    Inline.new(Firm.new)",
      "  end",
      "end",
    ]);
    await provider.streamFileBatch(root, paths);
    await provider.finalizeSignals(root);
    const edges = await client.queryAll<MethodEdge>(
      "SELECT source_symbol_id, target_symbol_id, call_expression FROM cg_symbols_edges_method",
    );
    expect(edges).toContainEqual({
      source_symbol_id: "Inline#initialize",
      target_symbol_id: "Firm#owner",
      call_expression: "firm.owner",
    });
  });
});
