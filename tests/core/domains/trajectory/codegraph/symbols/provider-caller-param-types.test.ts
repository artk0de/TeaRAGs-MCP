/**
 * bd tea-rags-mcp-2m83f.44 — parameter receivers typed from statically resolved
 * callers, e2e through the real provider two-pass.
 *
 *   class Worker
 *     def perform(record)   # untyped parameter, no YARD anywhere
 *       record.firm.name    # unresolvable until `record` has a type
 *     end
 *   end
 *
 *   Worker.new.perform(Invoice.new)   # an EXACT edge to Worker#perform, typed argument
 *
 * `record.firm` has two candidates that return different types (`Invoice#firm`
 * → Firm, `Client#firm` → Office), so neither a single namesake nor the
 * consensus return type (2m83f.42) can type it — only the callers can.
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

interface MethodEdge {
  source_symbol_id: string;
  target_symbol_id: string;
  call_expression: string;
}

describe("CodegraphEnrichmentProvider — parameter receivers typed from callers (2m83f.44)", () => {
  let tmp: string;
  let root: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;
  let paths: string[];

  const write = (name: string, lines: string[]): void => {
    writeFileSync(join(root, "src", name), `${lines.join("\n")}\n`);
    paths.push(`src/${name}`);
  };

  /** Two classes answering `firm` with DIFFERENT return types, so nothing but the caller types `record`. */
  const writeModels = (): void => {
    write("firm.rb", ["class Firm", "  def name", "    :firm", "  end", "end"]);
    write("office.rb", ["class Office", "  def name", "    :office", "  end", "end"]);
    write("invoice.rb", ["class Invoice", "  def firm", "    Firm.new", "  end", "end"]);
    write("client.rb", ["class Client", "  def firm", "    Office.new", "  end", "end"]);
  };

  const worker = (name: string, signature: string): void => {
    write(`${name.toLowerCase()}.rb`, [
      `class ${name}`,
      `  def perform(${signature})`,
      "    record.firm.name",
      "  end",
      "end",
    ]);
  };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-caller-param-prov-"));
    root = mkdtempSync(join(tmpdir(), "cg-caller-param-fixture-"));
    mkdirSync(join(root, "src"), { recursive: true });
    paths = [];
    writeModels();
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

  const run = async (): Promise<MethodEdge[]> => {
    await provider.streamFileBatch(root, paths);
    await provider.finalizeSignals(root);
    return client.queryAll<MethodEdge>(
      "SELECT source_symbol_id, target_symbol_id, call_expression FROM cg_symbols_edges_method",
    );
  };

  const targetsOf = (edges: MethodEdge[], source: string, call: string): string[] =>
    edges
      .filter((e) => e.source_symbol_id === source && e.call_expression === call)
      .map((e) => e.target_symbol_id)
      .sort();

  it("two typed callers that agree type the parameter: `record.firm.name` resolves exactly", async () => {
    worker("Worker", "record");
    write("alpha_job.rb", [
      "class AlphaJob",
      "  def run",
      "    invoice = Invoice.new",
      "    Worker.new.perform(invoice)",
      "  end",
      "end",
    ]);
    write("beta_job.rb", ["class BetaJob", "  def run", "    Worker.new.perform(Invoice.new)", "  end", "end"]);
    const edges = await run();
    expect(targetsOf(edges, "Worker#perform", "record.firm")).toEqual(["Invoice#firm"]);
    expect(targetsOf(edges, "Worker#perform", "record.firm.name")).toEqual(["Firm#name"]);
    expect(targetsOf(edges, "Worker#perform", "record.firm.name")).not.toContain("Office#name");
  });

  it("persists paramTyped: the sites resolved on a caller-typed parameter (2m83f.49)", async () => {
    worker("Worker", "record");
    write("alpha_job.rb", ["class AlphaJob", "  def run", "    Worker.new.perform(Invoice.new)", "  end", "end"]);
    await run();
    const rows = await client.getRunStats();
    const paramTyped = rows.filter((r) => r.language === "ruby").reduce((sum, r) => sum + (r.paramTyped ?? 0), 0);
    expect(paramTyped).toBe(2);
  });

  it("types a parameter from a constant argument, in class form (2m83f.49)", async () => {
    write("builder.rb", ["class Builder", "  def build(klass)", "    klass.make", "  end", "end"]);
    write("maker_a.rb", ["class MakerA", "  def self.make", "    :a", "  end", "end"]);
    write("maker_b.rb", ["class MakerB", "  def self.make", "    :b", "  end", "end"]);
    write("build_job.rb", ["class BuildJob", "  def run", "    Builder.new.build(MakerA)", "  end", "end"]);
    const edges = await run();
    expect(targetsOf(edges, "Builder#build", "klass.make")).toEqual(["MakerA.make"]);
  });

  it("a literal argument is typed evidence: it disagrees with a project type (2m83f.49)", async () => {
    worker("Literal", "record");
    write("delta_job.rb", ["class DeltaJob", "  def run", "    Literal.new.perform(Invoice.new)", "  end", "end"]);
    write("eps_job.rb", ["class EpsJob", "  def run", "    Literal.new.perform(42)", "  end", "end"]);
    const edges = await run();
    expect(targetsOf(edges, "Literal#perform", "record.firm")).not.toEqual(["Invoice#firm"]);
  });

  it("callers that disagree type nothing: the call keeps its untyped reading", async () => {
    worker("Mixed", "record");
    write("gamma_job.rb", [
      "class GammaJob",
      "  def a",
      "    Mixed.new.perform(Invoice.new)",
      "  end",
      "  def b",
      "    Mixed.new.perform(Client.new)",
      "  end",
      "end",
    ]);
    const edges = await run();
    expect(targetsOf(edges, "Mixed#perform", "record.firm")).not.toEqual(["Invoice#firm"]);
    expect(targetsOf(edges, "Mixed#perform", "record.firm")).not.toEqual(["Client#firm"]);
    expect(targetsOf(edges, "Mixed#perform", "record.firm.name")).not.toEqual(["Firm#name"]);
  });

  it("binds a keyword argument to the keyword parameter of the same name", async () => {
    worker("KwWorker", "record:");
    write("kw_job.rb", ["class KwJob", "  def run", "    KwWorker.new.perform(record: Invoice.new)", "  end", "end"]);
    const edges = await run();
    expect(targetsOf(edges, "KwWorker#perform", "record.firm")).toEqual(["Invoice#firm"]);
    expect(targetsOf(edges, "KwWorker#perform", "record.firm.name")).toEqual(["Firm#name"]);
  });

  it("refuses a splat call site: its arguments bind to no fixed parameter", async () => {
    worker("SplatWorker", "record");
    write("splat_job.rb", [
      "class SplatJob",
      "  def run",
      "    args = [Invoice.new]",
      "    SplatWorker.new.perform(*args)",
      "  end",
      "end",
    ]);
    const edges = await run();
    expect(targetsOf(edges, "SplatWorker#perform", "record.firm")).not.toEqual(["Invoice#firm"]);
  });

  it("propagates through an intermediate method in a second round", async () => {
    worker("Inner", "record");
    write("outer.rb", ["class Outer", "  def relay(record)", "    Inner.new.perform(record)", "  end", "end"]);
    write("outer_job.rb", ["class OuterJob", "  def run", "    Outer.new.relay(Invoice.new)", "  end", "end"]);
    const edges = await run();
    expect(targetsOf(edges, "Inner#perform", "record.firm")).toEqual(["Invoice#firm"]);
    expect(targetsOf(edges, "Inner#perform", "record.firm.name")).toEqual(["Firm#name"]);
  });

  it("a single typed caller does not type a parameter whose untyped callers outnumber it", async () => {
    worker("Thin", "record");
    write("thin_job.rb", [
      "class ThinJob",
      "  def a",
      "    Thin.new.perform(Invoice.new)",
      "  end",
      "  def b(x)",
      "    Thin.new.perform(x)",
      "  end",
      "  def c(y)",
      "    Thin.new.perform(y)",
      "  end",
      "end",
    ]);
    const edges = await run();
    expect(targetsOf(edges, "Thin#perform", "record.firm")).not.toEqual(["Invoice#firm"]);
  });
});
