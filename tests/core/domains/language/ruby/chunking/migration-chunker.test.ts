import { describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import { chunkRailsMigration } from "../../../../../../src/core/domains/language/ruby/chunking/migration-chunker.js";

describe("Rails migration chunking", () => {
  it("separates operations and records their static schema facts", async () => {
    const code = `class CreateOrders < ActiveRecord::Migration[7.0]
  def change
    create_table :orders do |t|
      t.string :reference
      t.uuid :vendor_id
    end
    add_column :vendors, :active, :boolean
    rename_column :vendors, :name, :title
  end
end`;
    const path = "db/migrate/20261028000000_create_orders.rb";
    const parser = new TreeSitterChunker(
      { chunkSize: 4500, chunkOverlap: 450, maxChunkSize: 4500 },
      new DefaultSymbolIdComposer(),
      new LanguageFactory(),
    );
    const { tree } = await parser.chunkWithTree(code, path, "ruby");
    expect(tree).not.toBeNull();
    const chunks = chunkRailsMigration(tree!.rootNode, code, path);
    expect(chunks).toEqual([
      expect.objectContaining({
        chunkType: "migration",
        operation: "create_table",
        table: "orders",
        columns: ["reference", "vendor_id"],
        version: "20261028000000",
        direction: "change",
        startLine: 3,
        endLine: 6,
      }),
      expect.objectContaining({
        operation: "add_column",
        table: "vendors",
        columns: ["active"],
        direction: "change",
        startLine: 7,
        endLine: 7,
      }),
      expect.objectContaining({
        operation: "rename_column",
        table: "vendors",
        columns: ["name", "title"],
        direction: "change",
        startLine: 8,
        endLine: 8,
      }),
    ]);
  });

  it("keeps dynamic operations and SQL as evidence with distinct ids and directions", async () => {
    const code = `class UpdateVendors < ActiveRecord::Migration[7.0]
  def up
    add_column table_name, :token, :uuid
    add_column :vendors, :token, :uuid
    execute "ALTER TABLE vendors ADD note text"
    custom_schema_operation :vendors
  end
  def down
    remove_column :vendors, :token
  end
end`;
    const path = "db/migrate/20261028000001_update_vendors.rb";
    const parser = new TreeSitterChunker(
      { chunkSize: 4500, chunkOverlap: 450, maxChunkSize: 4500 },
      new DefaultSymbolIdComposer(),
      new LanguageFactory(),
    );
    const { tree } = await parser.chunkWithTree(code, path, "ruby");
    const chunks = chunkRailsMigration(tree!.rootNode, code, path);
    expect(chunks.map((chunk) => chunk.operation)).toEqual([
      "add_column",
      "add_column",
      "execute",
      "custom_schema_operation",
      "remove_column",
    ]);
    expect(chunks[0]).toMatchObject({ direction: "up", columns: ["token"] });
    expect(chunks[0]).not.toHaveProperty("table");
    expect(chunks[2].content).toContain("ALTER TABLE vendors");
    expect(chunks[4]).toMatchObject({ direction: "down", table: "vendors" });
    expect(new Set(chunks.map((chunk) => chunk.symbolId)).size).toBe(chunks.length);
  });

  it("extracts index arrays and only columns on the table builder", async () => {
    const code = `class UpdateOrders < ActiveRecord::Migration[7.0]
  def change
    create_table :orders do |t|
      t.string :reference
      helper.string :not_a_column
    end
    add_index :orders, [:vendor_id, :reference]
  end
end`;
    const path = "db/migrate/20261028000002_update_orders.rb";
    const parser = new TreeSitterChunker(
      { chunkSize: 4500, chunkOverlap: 450, maxChunkSize: 4500 },
      new DefaultSymbolIdComposer(),
      new LanguageFactory(),
    );
    const { tree } = await parser.chunkWithTree(code, path, "ruby");
    const chunks = chunkRailsMigration(tree!.rootNode, code, path);
    expect(chunks[0].columns).toEqual(["reference"]);
    expect(chunks[1].columns).toEqual(["vendor_id", "reference"]);
  });
});
