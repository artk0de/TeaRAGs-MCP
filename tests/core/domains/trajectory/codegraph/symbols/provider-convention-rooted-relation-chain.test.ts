/**
 * End-to-end convention-rooted relation chain (bd tea-rags-mcp-2m83f.32.5) — the
 * TaxDome site `document.resolved_doc_dir.documents.ordered` run through the
 * provider's two-pass `buildFileSignals`. The provider asks the dispatch fan-out
 * BEFORE the exact chain, so a resolver-level fixture alone cannot see the fan-out
 * claiming the site; this pins the seam. Sources are the real files' lines.
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

const FILES: Record<string, string[]> = {
  "app/models/tax_preparation/document.rb": [
    "class TaxPreparation::Document < ApplicationRecord",
    "  belongs_to :doc_dir, optional: false, class_name: 'TaxPreparation::DocDir'",
    "  belongs_to :doc_dir_with_granular_access_attr, -> { with_sealed }, optional: true, class_name: 'TaxPreparation::DocDir', foreign_key: :doc_dir_id",
    "",
    "  scope :ordered, -> { order(name: :asc) }",
    "",
    "  def resolved_doc_dir",
    "    if association(:doc_dir_with_granular_access_attr).loaded?",
    "      doc_dir_with_granular_access_attr",
    "    else",
    "      doc_dir",
    "    end",
    "  end",
    "end",
  ],
  "app/models/tax_preparation/doc_dir.rb": [
    "class TaxPreparation::DocDir < ApplicationRecord",
    "  has_many :documents, -> { persistent }, class_name: 'TaxPreparation::Document', dependent: :destroy",
    "",
    "  scope :ordered, -> { order(name: :asc) }",
    "end",
  ],
  "app/models/communication/chat/document.rb": [
    "class Communication::Chat::Document < ApplicationRecord",
    "  scope :ordered, -> { order(:created_at) }",
    "end",
  ],
  "app/services/tax_preparation/documents/show.rb": [
    "class TaxPreparation::Documents::Show",
    "  include KindOfService",
    "",
    "  def meta_legacy(document)",
    "    previewable_documents = document.resolved_doc_dir.documents.ordered",
    "    previewable_documents = previewable_documents.removed_by_users([@user], @actor.firm).unlocked if @actor.client?",
    "    previewable_documents = previewable_documents.select(&:previewable?)",
    "    {prev_document_id: nil, next_document_id: nil}",
    "  end",
    "end",
  ],
};

interface EdgeRow {
  target_symbol_id: string;
  edge_kind: string;
}

describe("CodegraphEnrichmentProvider — convention-rooted relation chain (bd tea-rags-mcp-2m83f.32.5)", () => {
  let tmp: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;
  let root: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-relation-chain-db-"));
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
    root = mkdtempSync(join(tmpdir(), "cg-relation-chain-"));
    for (const [relPath, lines] of Object.entries(FILES)) {
      mkdirSync(join(root, dirname(relPath)), { recursive: true });
      writeFileSync(join(root, relPath), [...lines, ""].join("\n"));
    }
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("persists the one exact edge to the scope on Document, not a fan-out over every `ordered`", async () => {
    await provider.buildFileSignals(root);

    const edges = await client.queryAll<EdgeRow>(
      "SELECT target_symbol_id, edge_kind FROM cg_symbols_edges_method " +
        "WHERE source_symbol_id = 'TaxPreparation::Documents::Show#meta_legacy' " +
        "AND call_expression = 'document.resolved_doc_dir.documents.ordered'",
    );
    expect(edges).toEqual([{ target_symbol_id: "TaxPreparation::Document.ordered", edge_kind: "exact" }]);
  });
});
