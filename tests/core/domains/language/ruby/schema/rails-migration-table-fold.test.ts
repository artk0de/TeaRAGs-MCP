import { describe, expect, it } from "vitest";

import type { RailsMigrationOperation } from "../../../../../../src/core/contracts/types/rails-table-state.js";
import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import { chunkRailsMigration } from "../../../../../../src/core/domains/language/ruby/chunking/migration-chunker.js";
import { foldRailsTableMigrations } from "../../../../../../src/core/domains/language/ruby/schema/index.js";
import { OAUTH_MIGRATIONS } from "../fixtures/oauth-migrations.js";

const parser = new TreeSitterChunker(
  { chunkSize: 4500, chunkOverlap: 0, maxChunkSize: 4500 },
  new DefaultSymbolIdComposer(),
  new LanguageFactory(),
);

/** The corpus points for `table`, in file order — what the read path hands the fold. */
async function operationsFor(
  table: string,
  files: Record<string, string> = OAUTH_MIGRATIONS,
): Promise<RailsMigrationOperation[]> {
  const operations: RailsMigrationOperation[] = [];
  for (const [path, code] of Object.entries(files)) {
    const { tree } = await parser.chunkWithTree(code, path, "ruby");
    operations.push(
      ...chunkRailsMigration(tree!.rootNode, code, path).filter(
        (chunk) => chunk.table === table || (chunk.operation === "execute" && chunk.content.includes(table)),
      ),
    );
  }
  // Reverse so the fold, not the caller, owns version order.
  return operations.reverse();
}

const column = (name: string) => (state: { columns: { name: string }[] }) =>
  state.columns.find((entry) => entry.name === name);

describe("foldRailsTableMigrations — production fixture", () => {
  it("rebuilds oauth_connections: renamed polymorphic creator, unique firm index, refresh index, late columns", async () => {
    const state = foldRailsTableMigrations("oauth_connections", await operationsFor("oauth_connections"));

    expect(state.table).toBe("oauth_connections");
    expect(state.dropped).toBeUndefined();
    expect(state.unfolded).toEqual([]);
    expect(state.columns.map((entry) => entry.name)).toEqual([
      "id",
      "firm_id",
      "creator_type",
      "creator_id",
      "encrypted_access_token",
      "access_expires_at",
      "encrypted_refresh_token",
      "refresh_expires_at",
      "status",
      "connected_at",
      "refreshed_at",
      "created_at",
      "updated_at",
      "external_uuid",
      "encrypted_code_verifier",
      "code_verifier_expires_at",
    ]);
    const create = "migration:db/migrate/20260728173319_create_oauth_connections.rb:create_table:1";
    expect(column("creator_type")(state)).toEqual({
      name: "creator_type",
      type: "string",
      origin: create,
      renamedFrom: "actor_type",
    });
    expect(column("creator_id")(state)).toEqual({
      name: "creator_id",
      type: "bigint",
      origin: create,
      renamedFrom: "actor_id",
    });
    expect(column("firm_id")(state)).toMatchObject({ type: "bigint", origin: create });
    expect(column("external_uuid")(state)).toEqual({
      name: "external_uuid",
      type: "uuid",
      origin: "migration:db/migrate/20260731110427_add_external_uuids_to_tax_automations.rb:add_column:2",
    });
    expect(column("encrypted_code_verifier")(state)).toMatchObject({ type: "string" });
    expect(column("created_at")(state)).toMatchObject({ type: "datetime", origin: create });

    expect(state.indexes).toEqual([
      {
        name: "idx_oauth_connections_on_firm",
        columns: ["firm_id"],
        unique: true,
        origin: "migration:db/migrate/20260806132558_make_oauth_connections_unique_per_firm.rb:add_index:1",
      },
      {
        name: "idx_oauth_connections_on_refresh_expires_at",
        columns: ["refresh_expires_at"],
        unique: false,
        origin: "migration:db/migrate/20260922130328_add_refresh_expires_at_index_to_oauth_connections.rb:add_index:1",
      },
    ]);
    // `foreign_key: false` and a polymorphic reference declare no constraint.
    expect(state.foreignKeys).toEqual([]);
    // The `down` remove_index is not part of the current state.
    expect(state.provenance).not.toContain(
      "migration:db/migrate/20260922130328_add_refresh_expires_at_index_to_oauth_connections.rb:remove_index:2",
    );
    expect(state.provenance[0]).toBe(create);
    expect(state.provenance).toHaveLength(10);
  });

  it("rebuilds oauth_documents: references with hash-valued foreign_key / index options and the up-only index", async () => {
    const state = foldRailsTableMigrations("oauth_documents", await operationsFor("oauth_documents"));
    const create = "migration:db/migrate/20260731110423_create_oauth_documents.rb:create_table:1";

    expect(state.columns.map((entry) => [entry.name, entry.type])).toEqual([
      ["id", "primary_key"],
      ["firm_id", "bigint"],
      ["tax_automation_document_id", "bigint"],
      ["instead_entity_id", "bigint"],
      ["external_uuid", "uuid"],
      ["path", "string"],
      ["created_at", "datetime"],
      ["updated_at", "datetime"],
    ]);
    expect(state.foreignKeys).toEqual([
      { toTable: "tax_automations_documents", column: "tax_automation_document_id", origin: create },
      { toTable: "oauth_entities", column: "instead_entity_id", origin: create },
    ]);
    expect(state.indexes).toEqual([
      { name: "idx_oauth_documents_on_entity", columns: ["instead_entity_id"], unique: false, origin: create },
      {
        name: "idx_oauth_documents_on_ta_document",
        columns: ["tax_automation_document_id"],
        unique: true,
        origin: create,
      },
      {
        name: "idx_oauth_documents_on_firm_external",
        columns: ["firm_id", "external_uuid"],
        unique: true,
        origin: create,
      },
      {
        name: "idx_oauth_documents_on_external_uuid",
        columns: ["external_uuid"],
        unique: true,
        origin: "migration:db/migrate/20260915170006_add_external_uuid_index_to_oauth_documents.rb:add_index:1",
      },
    ]);
    expect(state.unfolded).toEqual([]);
  });
});

describe("foldRailsTableMigrations — operation semantics", () => {
  const fold = async (table: string, body: string) =>
    foldRailsTableMigrations(
      table,
      await operationsFor(table, {
        [`db/migrate/20260101000000_step.rb`]: `class Step < ActiveRecord::Migration[7.2]\n  def change\n${body}\n  end\nend\n`,
      }),
    );

  it("removes columns with the indexes and foreign keys built on them", async () => {
    const state = await fold(
      "orders",
      `    create_table :orders do |t|
      t.references :vendor, foreign_key: true
      t.string :code, :note
    end
    remove_column :orders, :note, :string
    remove_reference :orders, :vendor, foreign_key: true`,
    );
    expect(state.columns.map((entry) => entry.name)).toEqual(["id", "code"]);
    expect(state.indexes).toEqual([]);
    expect(state.foreignKeys).toEqual([]);
  });

  it("infers the referenced table of foreign_key: true and of add_foreign_key", async () => {
    const state = await fold(
      "orders",
      `    create_table :orders do |t|
      t.belongs_to :category, foreign_key: true
      t.bigint :owner_id
    end
    add_foreign_key :orders, :users, column: :owner_id`,
    );
    expect(state.foreignKeys.map((key) => [key.column, key.toTable])).toEqual([
      ["category_id", "categories"],
      ["owner_id", "users"],
    ]);
    expect(state.indexes.map((index) => index.columns)).toEqual([["category_id"]]);
  });

  it("drops the table and lists raw SQL as unfolded", async () => {
    const state = await fold(
      "orders",
      `    create_table :orders, id: false do |t|
      t.string :code
    end
    execute "ALTER TABLE orders ADD COLUMN legacy text"
    drop_table :orders`,
    );
    expect(state.columns).toEqual([]);
    expect(state.dropped).toEqual({ origin: "migration:db/migrate/20260101000000_step.rb:drop_table:3" });
    expect(state.unfolded).toEqual([
      {
        symbolId: "migration:db/migrate/20260101000000_step.rb:execute:2",
        operation: "execute",
        reason: "raw SQL is not folded",
      },
    ]);
  });

  it("marks operations it cannot apply as unfolded with their chunk id", async () => {
    const state = await fold(
      "orders",
      `    create_table :orders do |t|
      t.string :code
      t.send(:string, :dynamic)
    end
    change_table :orders do |t|
      t.rename :code, :reference
      t.remove :reference
      t.column :total, :decimal
    end`,
    );
    expect(state.columns.map((entry) => [entry.name, entry.type])).toEqual([
      ["id", "primary_key"],
      ["total", "decimal"],
    ]);
    expect(state.unfolded).toEqual([
      {
        symbolId: "migration:db/migrate/20260101000000_step.rb:create_table:1",
        operation: "create_table",
        reason: "t.send is not a table-builder call the fold knows",
      },
    ]);
  });

  it("applies change_column types and leaves default / null changes as no-ops", async () => {
    const state = await fold(
      "orders",
      `    add_column :orders, :total, :integer
    change_column :orders, :total, :decimal, precision: 10
    change_column_null :orders, :total, false`,
    );
    expect(state.columns).toEqual([
      { name: "total", type: "decimal", origin: "migration:db/migrate/20260101000000_step.rb:add_column:1" },
    ]);
  });
});
