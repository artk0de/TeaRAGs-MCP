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
        where: "status = 1",
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
      {
        toTable: "tax_automations_documents",
        column: "tax_automation_document_id",
        origin: create,
        onDelete: "cascade",
      },
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
        where: "external_uuid IS NOT NULL",
        origin: create,
      },
      {
        name: "idx_oauth_documents_on_external_uuid",
        columns: ["external_uuid"],
        unique: true,
        where: "external_uuid IS NOT NULL",
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

describe("foldRailsTableMigrations — operation stream semantics", () => {
  const FILE = "db/migrate/20260201000000_step.rb";
  /** Corpus points as the read path persists them: one per operation, in source order. */
  const stream = (...statements: [operation: string, content: string, direction?: string][]) =>
    statements.map(
      ([operation, content, direction], index): RailsMigrationOperation => ({
        symbolId: `migration:${FILE}:${operation}:${index + 1}`,
        version: "20260201000000",
        operation,
        ...(direction ? { direction } : {}),
        table: "items",
        columns: [],
        content,
      }),
    );
  const reasons = (state: { unfolded: { reason: string }[] }) => state.unfolded.map((entry) => entry.reason);
  const names = (state: { columns: { name: string }[] }) => state.columns.map((entry) => entry.name);

  it("tracks an index through add, duplicate add, rename and remove by name or by column", () => {
    const state = foldRailsTableMigrations(
      "items",
      stream(
        ["create_table", "create_table :items do |t|\n  t.string :sku\n  t.string :title\nend"],
        ["add_index", "add_index :items, :sku, name: :by_sku, unique: true"],
        ["add_index", "add_index :items, :sku, name: :by_sku"],
        ["add_index", "add_index :items, [:title, :sku]"],
        ["rename_index", "rename_index :items, :by_sku, :items_by_sku"],
        ["remove_index", "remove_index :items, column: [:title, :sku]"],
      ),
    );
    expect(state.unfolded).toEqual([]);
    expect(state.indexes).toEqual([
      {
        name: "items_by_sku",
        renamedFrom: "by_sku",
        columns: ["sku"],
        unique: true,
        origin: `migration:${FILE}:add_index:2`,
      },
    ]);

    const removed = foldRailsTableMigrations(
      "items",
      stream(
        ["add_column", "add_column :items, :sku, :string"],
        ["add_index", "add_index :items, :sku, name: 'by_sku'"],
        ["remove_index", "remove_index :items, name: :by_sku"],
      ),
    );
    expect(removed.indexes).toEqual([]);
    expect(removed.unfolded).toEqual([]);
  });

  it("reports index renames and removals the fold cannot match", () => {
    const state = foldRailsTableMigrations(
      "items",
      stream(
        ["rename_index", "rename_index :items, :ghost, :other"],
        ["remove_index", "remove_index :items, name: :ghost"],
        ["remove_index", "remove_index :items, :missing"],
      ),
    );
    expect(reasons(state)).toEqual([
      "renames ghost, an index the fold has not seen",
      "removes ghost, an index the fold has not seen",
      "removes missing, an index the fold has not seen",
    ]);
  });

  it("folds polymorphic and constrained references, then removes them again", () => {
    const state = foldRailsTableMigrations(
      "items",
      stream(
        ["add_reference", "add_reference :items, :owner, polymorphic: true, index: { name: :by_owner }"],
        ["add_belongs_to", "add_belongs_to :items, :box, foreign_key: { to_table: :crates }, index: false"],
        ["add_reference", "add_reference :items, :batch, type: :uuid, foreign_key: true"],
      ),
    );
    expect(names(state)).toEqual(["owner_type", "owner_id", "box_id", "batch_id"]);
    expect(state.columns.find((entry) => entry.name === "batch_id")?.type).toBe("uuid");
    expect(state.indexes.map((index) => [index.name, index.columns])).toEqual([
      ["by_owner", ["owner_type", "owner_id"]],
      [undefined, ["batch_id"]],
    ]);
    expect(state.foreignKeys.map((key) => [key.column, key.toTable])).toEqual([
      ["box_id", "crates"],
      ["batch_id", "batches"],
    ]);

    const removed = foldRailsTableMigrations(
      "items",
      stream(
        ["add_reference", "add_reference :items, :owner, polymorphic: true"],
        ["add_reference", "add_reference :items, :box"],
        ["remove_reference", "remove_reference :items, :owner, polymorphic: true"],
        ["remove_belongs_to", "remove_belongs_to :items, :box"],
      ),
    );
    expect(removed.columns).toEqual([]);
    expect(removed.indexes).toEqual([]);
  });

  it("keeps a partial index's where predicate and a foreign key's on_delete / on_update actions (7dcty.3)", () => {
    const state = foldRailsTableMigrations(
      "items",
      stream(
        [
          "create_table",
          `create_table :items do |t|
  t.references :box, foreign_key: { to_table: :crates, on_delete: :cascade, on_update: :restrict }
  t.references :shelf, foreign_key: true
  t.integer :status
  t.index :status, where: 'status IS NOT NULL', name: 'by_status'
end`,
        ],
        ["add_index", `add_index :items, :box_id, where: "status = 1", name: 'by_box'`],
        ["add_foreign_key", "add_foreign_key :items, :users, on_delete: :nullify"],
        ["add_reference", "add_reference :items, :batch, foreign_key: { on_delete: :restrict }"],
      ),
    );
    expect(state.unfolded).toEqual([]);
    expect(state.indexes.map((index) => [index.name ?? index.columns.join(","), index.where])).toEqual([
      ["box_id", undefined],
      ["shelf_id", undefined],
      ["by_status", "status IS NOT NULL"],
      ["by_box", "status = 1"],
      ["batch_id", undefined],
    ]);
    expect(state.indexes.filter((index) => !index.where).every((index) => !("where" in index))).toBe(true);
    expect(state.foreignKeys.map((key) => [key.column, key.onDelete, key.onUpdate])).toEqual([
      ["box_id", "cascade", "restrict"],
      ["shelf_id", undefined, undefined],
      ["user_id", "nullify", undefined],
      ["batch_id", "restrict", undefined],
    ]);
    expect(state.foreignKeys.filter((key) => !key.onDelete).every((key) => !("onDelete" in key))).toBe(true);
  });

  it("adds foreign keys with inferred columns and removes them by table or by column", () => {
    const state = foldRailsTableMigrations(
      "items",
      stream(
        ["add_foreign_key", "add_foreign_key :items, :categories"],
        ["add_foreign_key", "add_foreign_key :items, :boxes"],
        ["add_foreign_key", "add_foreign_key :items, :users"],
        ["add_foreign_key", "add_foreign_key :items, :users, column: :editor_id"],
        ["remove_foreign_key", "remove_foreign_key :items, :boxes"],
        ["remove_foreign_key", "remove_foreign_key :items, column: :editor_id"],
      ),
    );
    expect(state.unfolded).toEqual([]);
    expect(state.foreignKeys.map((key) => [key.column, key.toTable])).toEqual([
      ["category_id", "categories"],
      ["user_id", "users"],
    ]);

    const unmatched = foldRailsTableMigrations(
      "items",
      stream(
        ["remove_foreign_key", "remove_foreign_key :items, :ghosts"],
        ["remove_foreign_key", "remove_foreign_key :items"],
        ["add_foreign_key", "add_foreign_key :items, table_name"],
      ),
    );
    expect(reasons(unmatched)).toEqual([
      "removes a foreign key the fold has not seen",
      "removes a foreign key the fold has not seen",
      "referenced table is not a literal",
    ]);
  });

  it("adds and removes timestamps, follows a rename_table, and skips down-only operations", () => {
    const state = foldRailsTableMigrations(
      "items",
      stream(
        ["add_column", "add_column :items, :sku, :string"],
        ["add_timestamps", "add_timestamps :items, null: false"],
        ["remove_column", "remove_column :items, :sku", "down"],
      ),
    );
    expect(names(state)).toEqual(["sku", "created_at", "updated_at"]);

    const stripped = foldRailsTableMigrations(
      "items",
      stream(["add_timestamps", "add_timestamps :items"], ["remove_timestamps", "remove_timestamps :items"]),
    );
    expect(stripped.columns).toEqual([]);

    const renamed = foldRailsTableMigrations(
      "items",
      stream(["add_column", "add_column :items, :sku, :string"], ["rename_table", "rename_table :items, :products"]),
    );
    expect(renamed.columns).toEqual([]);
    expect(renamed.dropped).toEqual({ origin: `migration:${FILE}:rename_table:2`, renamedTo: "products" });
  });

  it("lists join tables, unknown operations, unreadable text and non-literal names as unfolded, once each", () => {
    const state = foldRailsTableMigrations(
      "items",
      stream(
        ["create_join_table", "create_join_table :items, :tags"],
        ["add_check_constraint", "add_check_constraint :items, 'price > 0'"],
        ["add_enum_value", "add_enum_value :status, 'archived'"],
        ["change_table", "change_table :items do |t|\n  say 'a'\n  say 'b'\nend"],
        ["add_column", "Item.connection.add_column :items, :sku, :string"],
        ["add_column", "add_column :items, column_name, :string"],
        ["rename_column", "rename_column :items, :sku, new_name"],
        ["rename_column", "rename_column :items, :ghost, :spirit"],
        ["change_column", "change_column :items, :ghost, :text"],
        ["add_reference", "add_reference :items, reference_name"],
        ["remove_reference", "remove_reference :items, reference_name"],
      ),
    );
    expect(reasons(state)).toEqual([
      "a join table's name is derived from both tables",
      "add_enum_value is not a schema operation the fold knows",
      "say is not a table-builder call the fold knows",
      "add_column text could not be read",
      "column name is not a literal",
      "column names are not literals",
      "renames ghost, a column the fold has not seen",
      "changes ghost the fold has not seen",
      "reference name is not a literal",
      "reference name is not a literal",
    ]);
  });

  it("applies every table-builder call inside change_table, reading comments, strings and continuation lines", () => {
    const state = foldRailsTableMigrations(
      "items",
      stream(
        [
          "create_table",
          [
            "create_table :items, primary_key: :uid, id: :uuid do |t| # keyed by uuid",
            "  t.string :title, :note # two columns",
            '  t.text :body, default: "it\\"s # not a comment"',
            "  t.integer :rank,",
            "    null: false",
            "  t.references :owner, polymorphic: true",
            "  t.belongs_to :shelf",
            "  t.timestamps",
            "  t.index %i[title rank], name: :by_title",
            "end",
          ].join("\n"),
        ],
        [
          "change_table",
          [
            "change_table :items do |t|",
            "  t.change :rank, :bigint",
            "  t.change_default :rank, from: nil, to: 0",
            "  t.remove_index name: :by_title",
            "  t.remove_index :owner_type",
            "  t.remove_references :owner, polymorphic: true",
            "  t.remove_belongs_to :shelf",
            "  t.remove_timestamps",
            "  t.remove :note",
            "  say 'not a builder call'",
            "end",
          ].join("\n"),
        ],
      ),
    );
    expect(state.columns.map((entry) => [entry.name, entry.type])).toEqual([
      ["uid", "uuid"],
      ["title", "string"],
      ["body", "text"],
      ["rank", "bigint"],
    ]);
    expect(state.indexes).toEqual([]);
    expect(reasons(state)).toEqual([
      "removes owner_type, an index the fold has not seen",
      "say is not a table-builder call the fold knows",
    ]);
  });

  it("applies operations in migration version order regardless of input order", () => {
    const [create] = stream(["create_table", "create_table :items do |t|\n  t.string :sku\nend"]);
    const later: RailsMigrationOperation = {
      ...create,
      symbolId: "migration:db/migrate/20260301000000_more.rb:add_column:1",
      version: "20260301000000",
      operation: "add_column",
      content: "add_column :items, :sku, :text",
    };
    const state = foldRailsTableMigrations("items", [later, create]);
    expect(state.columns.map((entry) => [entry.name, entry.type, entry.origin])).toEqual([
      ["id", "primary_key", create.symbolId],
      ["sku", "text", create.symbolId],
    ]);
    expect(state.provenance).toEqual([create.symbolId, later.symbolId]);
  });

  it("carries indexes and foreign keys through a column rename and rejects shapes it cannot read", () => {
    const state = foldRailsTableMigrations(
      "items",
      stream(
        ["add_reference", "add_reference :items, :owner, foreign_key: { to_table: :users }"],
        ["rename_column", "rename_column :items, :owner_id, :creator_id"],
        ["add_index", "add_index :items, { creator_id: :asc }"],
        ["change_table", "change_table :items"],
        ["add_column", "(add_column :items, :sku, :string)"],
      ),
    );
    expect(state.columns).toEqual([
      {
        name: "creator_id",
        type: "bigint",
        origin: `migration:${FILE}:add_reference:1`,
        renamedFrom: "owner_id",
      },
    ]);
    expect(state.indexes.map((index) => index.columns)).toEqual([["creator_id"]]);
    expect(state.foreignKeys.map((key) => [key.column, key.toTable])).toEqual([["creator_id", "users"]]);
    expect(reasons(state)).toEqual(["index columns are not literals", "add_column text could not be read"]);
  });
});
