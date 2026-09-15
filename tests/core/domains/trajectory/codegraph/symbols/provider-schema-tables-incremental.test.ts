/**
 * bd tea-rags-mcp-39xca.9 — the `self.table_name` half of the batch-scoped
 * run-global defect class, e2e through the real provider two-pass.
 *
 * The schema-column pre-pass runs at the barrier over the run's `schemaTables`.
 * That map used to hold only the overrides the CURRENT batch walked, so an
 * incremental run that did not walk a model's file lost the model's override.
 * The damage is not limited to that model. On taxdome,
 * `TaxPreparation::Juno::Client` declares `juno_clients`. Without the override
 * it joins the inflection bucket for `Client`, the `clients` table becomes
 * ambiguous, and the plain `Client` model loses EVERY column: 562 column edges
 * out of the 1182 an incremental run lost
 * (`scripts/spikes/incremental-runglobal-delta.ts --batch-mode
 * exclude-schema-overrides`).
 *
 * Asserted as whole sorted target lists rather than containment, because a
 * column attached to the wrong model is an edge that a containment check would
 * accept.
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

const SCHEMA = [
  "ActiveRecord::Schema[7.0].define(version: 2026_09_15_000000) do",
  '  create_table "clients", force: :cascade do |t|',
  '    t.string "code"',
  "  end",
  "",
  '  create_table "juno_clients", force: :cascade do |t|',
  '    t.string "juno_key"',
  "  end",
  "end",
  "",
].join("\n");

interface MethodEdge {
  source_symbol_id: string;
  target_symbol_id: string;
  call_expression: string;
}

describe("CodegraphEnrichmentProvider — self.table_name overrides on an incremental run (39xca.9)", () => {
  let tmp: string;
  let root: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  const reportSource = (extraMethod: boolean): string =>
    [
      "class Report",
      "  def run",
      "    client = Client.new",
      "    client.code",
      "    client.juno_key",
      "    juno = TaxPreparation::Juno::Client.new",
      "    juno.juno_key",
      "    juno.code",
      "  end",
      ...(extraMethod ? ["  def added_later", "    :noop", "  end"] : []),
      "end",
      "",
    ].join("\n");

  /** The two namesake models, the schema they share a table-name stem in, and one caller. */
  const writeFixture = (): string[] => {
    mkdirSync(join(root, "db"), { recursive: true });
    mkdirSync(join(root, "app", "models", "tax_preparation", "juno"), { recursive: true });
    mkdirSync(join(root, "app", "services"), { recursive: true });
    writeFileSync(join(root, "db", "schema.rb"), SCHEMA);
    writeFileSync(join(root, "app", "models", "client.rb"), ["class Client < ApplicationRecord", "end", ""].join("\n"));
    writeFileSync(
      join(root, "app", "models", "tax_preparation", "juno", "client.rb"),
      ["class TaxPreparation::Juno::Client < ApplicationRecord", '  self.table_name = "juno_clients"', "end", ""].join(
        "\n",
      ),
    );
    writeFileSync(join(root, "app", "services", "report.rb"), reportSource(false));
    return ["app/models/client.rb", "app/models/tax_preparation/juno/client.rb", "app/services/report.rb"];
  };

  const targetsOf = async (callExpression: string): Promise<string[]> =>
    (
      await client.queryAll<MethodEdge>(
        "SELECT source_symbol_id, target_symbol_id, call_expression FROM cg_symbols_edges_method",
      )
    )
      .filter((e) => e.source_symbol_id === "Report#run" && e.call_expression === callExpression)
      .map((e) => e.target_symbol_id)
      .sort();

  const expectColumnsOnTheirOwnModels = async (): Promise<void> => {
    expect(await targetsOf("client.code")).toEqual(["Client#code"]);
    expect(await targetsOf("juno.juno_key")).toEqual(["TaxPreparation::Juno::Client#juno_key"]);
    // Neither model receives the other's table.
    expect(await targetsOf("client.juno_key")).toEqual([]);
    expect(await targetsOf("juno.code")).toEqual([]);
  };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-schema-tables-prov-"));
    root = mkdtempSync(join(tmpdir(), "cg-schema-tables-fixture-"));
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

  it("keeps Client's columns on Client when the namesake model declaring its own table is not re-walked", async () => {
    const paths = writeFixture();

    // Run 1: the full corpus. Every override is walked, so this only shows the
    // fixture resolves at all. If it did not, the incremental assertion below
    // could pass for the wrong reason.
    await provider.streamFileBatch(root, paths);
    await provider.finalizeSignals(root);
    await expectColumnsOnTheirOwnModels();

    // Run 2: only the caller changed. The Juno model's file, which holds the
    // override, is not in the batch.
    writeFileSync(join(root, "app", "services", "report.rb"), reportSource(true));
    await provider.streamFileBatch(root, ["app/services/report.rb"]);
    await provider.finalizeSignals(root);

    await expectColumnsOnTheirOwnModels();
  });
});
