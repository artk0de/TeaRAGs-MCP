/**
 * End-to-end residual exclusions (bd tea-rags-mcp-2m83f.34, .35) — a real project tree
 * whose Rails-generated callees no menu holds, run through the provider's two-pass
 * `buildFileSignals`. Pins the seam: Ruby `residualExclusion` → collector →
 * persisted residual rows.
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
  "db/schema.rb": [
    "ActiveRecord::Schema[7.0].define(version: 2026_10_15_000000) do",
    '  create_table "refunds", force: :cascade do |t|',
    '    t.decimal "amount"',
    '    t.datetime "updated_at", null: false',
    "  end",
    "end",
  ],
  "app/models/getting_paid/refund.rb": [
    "module GettingPaid",
    "  class Refund < ApplicationRecord",
    '    self.table_name = "refunds"',
    "  end",
    "end",
  ],
  "app/models/contact.rb": [
    "class Contact < ApplicationRecord",
    "  scope :without_deleted, -> { where(deleted_at: nil) }",
    "end",
  ],
  "app/models/concerns/soft_deletable.rb": [
    "module SoftDeletable",
    "  extend ActiveSupport::Concern",
    "  included do",
    "    scope :not_archived, -> { where(archived_at: nil) }",
    "  end",
    "end",
  ],
  // A serializer's `has_one :file` names `File`, a class the project does not declare.
  "app/serializers/document_serializer.rb": [
    "class DocumentSerializer < ActiveModel::Serializer",
    "  has_one :file",
    "end",
  ],
  "app/models/firm.rb": ["class Firm < ApplicationRecord", "  has_many :contacts", "end"],
  "app/models/document.rb": [
    "class Document < ApplicationRecord",
    "  has_one_attached :file",
    "  has_many_attached :scans",
    "end",
  ],
  "app/models/invitation.rb": ["class Invitation < ApplicationRecord", "  def pending?", "  end", "end"],
  // 800 one-def names hold the fan-out cap at its floor of 16 (a small corpus's p99 is its maximum).
  "app/lib/filler.rb": ["class Filler", ...Array.from({ length: 800 }, (_, i) => `  def filler_${i}; end`), "end"],
  // Seventeen project namesakes per member: past that cap, so each site stays residual.
  "app/lib/namesakes.rb": Array.from({ length: 17 }, (_, i) => [
    `class Namesake${i}`,
    "  def amount; end",
    "  def ids; end",
    "  def includes(x); end",
    "  def attach(x); end",
    "  def pending?; end",
    "  def updated_at; end",
    "end",
  ]).flat(),
  "app/services/sweep.rb": [
    "class Sweep",
    "  def run(refund, holder, upload, invite, q, io, items)",
    "    refund.amount",
    "    Product.ransack(q).result.ids",
    "    holder.contacts.without_deleted.includes(:firm)",
    "    holder.contacts.not_archived.includes(:firm)",
    "    items.each { |doc| doc.updated_at }",
    "    upload.file.attach(io)",
    "    @upload.scans.attach(io)",
    "    invite.pending?",
    "  end",
    "end",
  ],
};

describe("CodegraphEnrichmentProvider — residual exclusions (bd tea-rags-mcp-2m83f.34)", () => {
  let tmp: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;
  let root: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-residual-excl-db-"));
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
    root = mkdtempSync(join(tmpdir(), "cg-residual-excl-"));
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

  it("persists no residual row for a Rails-generated callee and keeps the project-method site", async () => {
    // .35: a concern-declared scope tail, an attachment tail beside a non-project `File` fact, a timestamp column.
    await provider.buildFileSignals(root);

    const rows = (await client.readResidualCallSites()).filter((r) => r.sourceRelPath === "app/services/sweep.rb");
    expect(rows.map((r) => `${r.receiverText}.${r.member}`)).toEqual(["invite.pending?"]);
  });
});
