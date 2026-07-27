/**
 * End-to-end schema-column pre-pass (bd tea-rags-mcp-8l5fo) — a real project tree
 * with a `db/schema.rb` snapshot, run through the provider's two-pass
 * `buildFileSignals`. Pins the whole seam: language facet → barrier pre-pass →
 * symbol table → pass-2 method edge.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
const MIG_DIR = resolve(__dirname, "../../../../../../src/core/infra/migration/database/migrations");

const SCHEMA = [
  "ActiveRecord::Schema[7.0].define(version: 2026_07_27_000000) do",
  '  create_table "firms", force: :cascade do |t|',
  '    t.string "name"',
  '    t.integer "owner_id"',
  '    t.index ["owner_id"], name: "index_firms_on_owner_id"',
  "  end",
  "",
  '  create_table "companies", force: :cascade do |t|',
  '    t.string "legal_title"',
  "  end",
  "end",
  "",
].join("\n");

describe("CodegraphEnrichmentProvider — db/schema.rb column declares (bd tea-rags-mcp-8l5fo)", () => {
  let tmp: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;
  let symbolTable: InMemoryGlobalSymbolTable;
  let root: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-schema-col-db-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
    symbolTable = new InMemoryGlobalSymbolTable();
    provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable,
      ...buildTestCodegraphDeps(),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });
    root = mkdtempSync(join(tmpdir(), "cg-schema-col-"));
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  /** Write the standard fixture project: schema + two models + one caller. */
  function writeProject(): void {
    mkdirSync(join(root, "db"), { recursive: true });
    mkdirSync(join(root, "app", "models"), { recursive: true });
    mkdirSync(join(root, "app", "services"), { recursive: true });
    writeFileSync(join(root, "db", "schema.rb"), SCHEMA);
    writeFileSync(
      join(root, "app", "models", "firm.rb"),
      ["class Firm < ApplicationRecord", "  def label", "    name", "  end", "end", ""].join("\n"),
    );
    // Custom table override — `Agency` owns `companies`, so `legal_title`
    // belongs to it and NOT to a `Company` model (which does not exist).
    writeFileSync(
      join(root, "app", "models", "agency.rb"),
      ["class Agency < ApplicationRecord", '  self.table_name = "companies"', "end", ""].join("\n"),
    );
    writeFileSync(
      join(root, "app", "services", "report.rb"),
      ["class Report", "  def run", "    firm = Firm.new", "    firm.name", "  end", "end", ""].join("\n"),
    );
  }

  it("synthesises the schema columns onto the inflected model", async () => {
    writeProject();
    await provider.buildFileSignals(root);
    const columns = symbolTable
      .lookupByShortName("name", { includeSchemaColumns: true })
      .filter((d) => d.isSchemaColumn === true);
    expect(columns.map((d) => d.symbolId)).toEqual(["Firm#name"]);
    expect(columns[0]?.relPath).toBe("app/models/firm.rb");
  });

  it("routes a custom self.table_name to its declaring model", async () => {
    writeProject();
    await provider.buildFileSignals(root);
    expect(
      symbolTable.lookupByShortName("legal_title", { includeSchemaColumns: true }).map((d) => d.symbolId),
    ).toEqual(["Agency#legal_title"]);
  });

  it("keeps synthesised columns out of the default global short-name lookup", async () => {
    writeProject();
    await provider.buildFileSignals(root);
    expect(symbolTable.lookupByShortName("name")).toEqual([]);
    expect(symbolTable.shortNameDefCounts().get("name")).toBeUndefined();
  });

  it("resolves a typed receiver's column call to the model's synthesised accessor", async () => {
    writeProject();
    await provider.buildFileSignals(root);
    const edges = await client.getCallees("Report#run");
    expect(edges.map((e) => e.targetSymbolId)).toContain("Firm#name");
  });

  it("resolves a bare column call inside the model's own method", async () => {
    writeProject();
    await provider.buildFileSignals(root);
    const edges = await client.getCallees("Firm#label");
    expect(edges.map((e) => e.targetSymbolId)).toContain("Firm#name");
  });

  /**
   * bd tea-rags-mcp-2a5oo — the column's VALUE type. `firm.name` reads a
   * `t.string` column, so the chain hop is a core `String` and a same-named
   * in-project def past it is wrong-type noise; a DECLARED return fact on the
   * same coordinate still outranks the column.
   */
  describe("column value types (bd tea-rags-mcp-2a5oo)", () => {
    const TYPED_SCHEMA = [
      "ActiveRecord::Schema[7.0].define(version: 2026_07_27_000000) do",
      '  create_table "firms", force: :cascade do |t|',
      '    t.string "name"',
      '    t.jsonb "settings"',
      "  end",
      "end",
      "",
    ].join("\n");

    /**
     * Model + an unrelated class defining `compute_total`. `Firm#settings` is a
     * REAL def carrying a YARD `@return [Widget]`, shadowing the jsonb column;
     * `Firm#name` has no def at all and only the schema declares it.
     */
    function writeChainProject(): void {
      mkdirSync(join(root, "db"), { recursive: true });
      mkdirSync(join(root, "app", "models"), { recursive: true });
      mkdirSync(join(root, "app", "services"), { recursive: true });
      writeFileSync(join(root, "db", "schema.rb"), TYPED_SCHEMA);
      writeFileSync(
        join(root, "app", "models", "firm.rb"),
        [
          "class Firm < ApplicationRecord",
          "  # @return [Widget]",
          "  def settings",
          "    Widget.new",
          "  end",
          "end",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(root, "app", "models", "widget.rb"),
        ["class Widget", "  def compute_total", "    1", "  end", "end", ""].join("\n"),
      );
      writeFileSync(
        join(root, "app", "services", "report.rb"),
        [
          "class Report",
          "  def declared_hop",
          "    firm = Firm.new",
          "    firm.settings.compute_total",
          "  end",
          "",
          "  def column_hop",
          "    firm = Firm.new",
          "    firm.name.compute_total",
          "  end",
          "end",
          "",
        ].join("\n"),
      );
    }

    it("stops a chain at a core-typed column hop instead of guessing a same-named def", async () => {
      writeChainProject();
      await provider.buildFileSignals(root);
      const edges = await client.getCallees("Report#column_hop");
      expect(edges.map((e) => e.targetSymbolId)).not.toContain("Widget#compute_total");
    });

    it("keeps a DECLARED return fact ahead of the column type on the same coordinate", async () => {
      writeChainProject();
      await provider.buildFileSignals(root);
      const edges = await client.getCallees("Report#declared_hop");
      expect(edges.map((e) => e.targetSymbolId)).toContain("Widget#compute_total");
    });
  });

  it("is a clean no-op when the project has no db/schema.rb", async () => {
    mkdirSync(join(root, "app", "models"), { recursive: true });
    writeFileSync(
      join(root, "app", "models", "firm.rb"),
      ["class Firm < ApplicationRecord", "  def label", "    name", "  end", "end", ""].join("\n"),
    );
    await expect(provider.buildFileSignals(root)).resolves.toBeDefined();
    expect(symbolTable.lookupByShortName("name", { includeSchemaColumns: true })).toEqual([]);
  });
});
