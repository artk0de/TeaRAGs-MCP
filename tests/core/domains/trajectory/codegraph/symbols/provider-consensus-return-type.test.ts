/**
 * End-to-end consensus return type (bd tea-rags-mcp-2m83f.42) — the TaxDome
 * overflow shape: many models each `belongs_to :firm`, and `record.firm.name`
 * on a receiver nothing types. The `firm` hop has no single target, but every
 * candidate returns `Firm`, so the chain continues from `Firm` and `name`
 * resolves `Firm#name` statically. One candidate returning anything else — or
 * nothing the index can read — leaves the chain untyped.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
const MIG_DIR = resolve(__dirname, "../../../../../../src/core/domains/maintenance/migration/database/migrations");

const BASE_FILES: Record<string, string[]> = {
  "app/models/firm.rb": ["class Firm < ApplicationRecord", "  def name", "    title", "  end", "end"],
  "app/models/office.rb": ["class Office < ApplicationRecord", "  def name", "    label", "  end", "end"],
  "app/models/client.rb": ["class Client < ApplicationRecord", "  belongs_to :firm", "end"],
  "app/models/invoice.rb": ["class Invoice < ApplicationRecord", "  belongs_to :firm", "end"],
  "app/models/task.rb": ["class Task < ApplicationRecord", "  belongs_to :firm", "end"],
  "app/models/document.rb": ["class Document < ApplicationRecord", "  has_one :firm", "end"],
  "app/services/reports/render.rb": [
    "class Reports::Render",
    "  def call(record)",
    "    record.firm.name",
    "  end",
    "end",
  ],
};

interface EdgeRow {
  target_symbol_id: string;
  edge_kind: string;
}

describe("CodegraphEnrichmentProvider — consensus return type over an overflow hop (bd tea-rags-mcp-2m83f.42)", () => {
  let tmp: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;
  let root: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-consensus-db-"));
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
    root = mkdtempSync(join(tmpdir(), "cg-consensus-"));
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  function writeProject(files: Record<string, string[]>): void {
    for (const [relPath, lines] of Object.entries(files)) {
      mkdirSync(join(root, dirname(relPath)), { recursive: true });
      writeFileSync(join(root, relPath), [...lines, ""].join("\n"));
    }
  }

  async function edgesOf(callExpression: string): Promise<EdgeRow[]> {
    return client.queryAll<EdgeRow>(
      "SELECT target_symbol_id, edge_kind FROM cg_symbols_edges_method " +
        `WHERE source_symbol_id = 'Reports::Render#call' AND call_expression = '${callExpression}'`,
    );
  }

  it("types the hop every candidate agrees on, so the next call is an exact edge to Firm#name", async () => {
    writeProject(BASE_FILES);
    await provider.buildFileSignals(root);

    expect(await edgesOf("record.firm.name")).toEqual([{ target_symbol_id: "Firm#name", edge_kind: "exact" }]);
  });

  it("leaves the overflow hop itself without an exact edge — its target is still ambiguous", async () => {
    writeProject(BASE_FILES);
    await provider.buildFileSignals(root);

    const firmEdges = await edgesOf("record.firm");
    expect(firmEdges.filter((edge) => edge.edge_kind === "exact")).toEqual([]);
  });

  it("refuses when one candidate returns a different type", async () => {
    writeProject({
      ...BASE_FILES,
      "app/models/branch.rb": ["class Branch < ApplicationRecord", "  belongs_to :firm, class_name: 'Office'", "end"],
    });
    await provider.buildFileSignals(root);

    expect(await edgesOf("record.firm.name")).not.toContainEqual({ target_symbol_id: "Firm#name", edge_kind: "exact" });
  });

  it("refuses when one candidate's return type is unknown", async () => {
    writeProject({
      ...BASE_FILES,
      "app/models/branch.rb": ["class Branch < ApplicationRecord", "  def firm", "    lookup_firm", "  end", "end"],
    });
    await provider.buildFileSignals(root);

    expect(await edgesOf("record.firm.name")).not.toContainEqual({ target_symbol_id: "Firm#name", edge_kind: "exact" });
  });
});
