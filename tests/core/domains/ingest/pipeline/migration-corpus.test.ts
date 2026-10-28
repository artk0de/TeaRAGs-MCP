import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MockQdrantManager } from "../__helpers__/test-helpers.js";
import { parseMigrationOperations } from "../../../../../src/core/api/internal/migration-parser.js";
import { rebuildMigrationCorpus } from "../../../../../src/core/domains/ingest/pipeline/migration-corpus.js";

describe("migration corpus", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("builds a separate corpus and publishes it only after the migration points are stored", async () => {
    root = await mkdtemp(join(process.cwd(), ".migration-corpus-test-"));
    await mkdir(join(root, "db/migrate"), { recursive: true });
    await writeFile(
      join(root, "db/migrate/20261028000000_orders.rb"),
      "class Orders < ActiveRecord::Migration[7.0]\n def change\n add_column :orders, :vendor_id, :uuid\n end\nend\n",
    );
    const calls: string[] = [];
    const qdrant = {
      createCollection: vi.fn(async () => {
        calls.push("create");
      }),
      addPointsWithSparse: vi.fn(async () => {
        calls.push("points");
      }),
      deleteCollection: vi.fn(async () => {
        calls.push("delete");
      }),
      collectionExists: vi.fn(async () => false),
      aliases: {
        createAlias: vi.fn(async () => {
          calls.push("publish");
        }),
        switchAlias: vi.fn(),
      },
    };
    const embeddings = {
      getDimensions: () => 3,
      getModel: () => "test-model",
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => ({ embedding: [1, 0, 0] }))),
    };
    await rebuildMigrationCorpus({
      root,
      codeCollection: "code_test",
      qdrant,
      embeddings,
      parse: parseMigrationOperations,
    });
    expect(qdrant.createCollection).toHaveBeenCalledWith(
      expect.stringMatching(/^code_test_migrations_/),
      3,
      "Cosine",
      true,
    );
    expect(qdrant.addPointsWithSparse).toHaveBeenCalledWith(expect.any(String), [
      expect.objectContaining({
        payload: expect.objectContaining({
          chunkType: "migration",
          operation: "add_column",
          table: "orders",
          columns: ["vendor_id"],
        }),
      }),
    ]);
    expect(qdrant.addPointsWithSparse).toHaveBeenCalledWith(expect.any(String), [
      expect.objectContaining({
        payload: expect.objectContaining({
          _type: "indexing_metadata",
          indexingComplete: true,
          embeddingModel: "test-model",
        }),
      }),
    ]);
    expect(calls.indexOf("publish")).toBeGreaterThan(calls.indexOf("points"));
    expect(qdrant.aliases.createAlias).toHaveBeenCalledWith("code_test_migrations", expect.any(String));
  });

  it("keeps the old corpus if embedding fails", async () => {
    root = await mkdtemp(join(process.cwd(), ".migration-corpus-test-"));
    await mkdir(join(root, "db/migrate"), { recursive: true });
    await writeFile(
      join(root, "db/migrate/20261028000000_orders.rb"),
      "class Orders < ActiveRecord::Migration[7.0]\n def change\n add_column :orders, :vendor_id, :uuid\n end\nend\n",
    );
    const qdrant = {
      createCollection: vi.fn(async () => {}),
      addPointsWithSparse: vi.fn(async () => {}),
      deleteCollection: vi.fn(async () => {}),
      collectionExists: vi.fn(async () => true),
      aliases: { resolveActive: vi.fn(async () => "old_corpus"), createAlias: vi.fn(), switchAlias: vi.fn() },
    };
    const embeddings = {
      getDimensions: () => 3,
      embedBatch: vi.fn(async () => {
        throw new Error("embedding failed");
      }),
    };
    await expect(
      rebuildMigrationCorpus({
        root,
        codeCollection: "code_test",
        qdrant,
        embeddings,
        parse: parseMigrationOperations,
      }),
    ).rejects.toThrow("embedding failed");
    expect(qdrant.aliases.switchAlias).not.toHaveBeenCalled();
    expect(qdrant.deleteCollection).toHaveBeenCalledWith(expect.stringMatching(/^code_test_migrations_/));
    expect(qdrant.deleteCollection).not.toHaveBeenCalledWith("old_corpus");
  });

  it("bounds the text sent to the embedding provider for oversized table blocks", async () => {
    root = await mkdtemp(join(process.cwd(), ".migration-corpus-test-"));
    await mkdir(join(root, "db/migrate"), { recursive: true });
    const columns = Array.from({ length: 300 }, (_, i) => `      t.string :column_${i}`).join("\n");
    await writeFile(
      join(root, "db/migrate/20261028000000_orders.rb"),
      `class Orders < ActiveRecord::Migration[7.0]\n  def change\n    create_table :orders do |t|\n${columns}\n    end\n  end\nend\n`,
    );
    const qdrant = {
      createCollection: vi.fn(async () => {}),
      addPointsWithSparse: vi.fn(async () => {}),
      deleteCollection: vi.fn(async () => {}),
      collectionExists: vi.fn(async () => false),
      aliases: { createAlias: vi.fn(async () => {}), switchAlias: vi.fn() },
    };
    const embeddings = {
      getDimensions: () => 3,
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => ({ embedding: [1, 0, 0] }))),
    };
    await rebuildMigrationCorpus({
      root,
      codeCollection: "code_test",
      qdrant,
      embeddings,
      parse: parseMigrationOperations,
    });
    const texts = embeddings.embedBatch.mock.calls.flatMap(([batch]) => batch);
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.every((text) => text.length <= 4500)).toBe(true);
  });

  it("does not re-embed unchanged migration files on a later run", async () => {
    root = await mkdtemp(join(process.cwd(), ".migration-corpus-test-"));
    await mkdir(join(root, "db/migrate"), { recursive: true });
    await writeFile(
      join(root, "db/migrate/20261028000000_orders.rb"),
      "class Orders < ActiveRecord::Migration[7.0]\n def change\n add_column :orders, :vendor_id, :uuid\n end\nend\n",
    );
    const qdrant = new MockQdrantManager();
    const embeddings = {
      getDimensions: () => 3,
      getModel: () => "test-model",
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => ({ embedding: [1, 0, 0] }))),
    };
    await rebuildMigrationCorpus({
      root,
      codeCollection: "code_test",
      qdrant,
      embeddings,
      parse: parseMigrationOperations,
    });
    const count = embeddings.embedBatch.mock.calls.length;
    await rebuildMigrationCorpus({
      root,
      codeCollection: "code_test",
      qdrant,
      embeddings,
      parse: parseMigrationOperations,
    });
    expect(embeddings.embedBatch).toHaveBeenCalledTimes(count);
  });

  it("retains migration source when no operation can be identified", async () => {
    root = await mkdtemp(join(process.cwd(), ".migration-corpus-test-"));
    await mkdir(join(root, "db/migrate"), { recursive: true });
    await writeFile(join(root, "db/migrate/20261028000000_orders.rb"), "# schema changed by an external helper\n");
    const qdrant = new MockQdrantManager();
    const embeddings = {
      getDimensions: () => 3,
      getModel: () => "test-model",
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => ({ embedding: [1, 0, 0] }))),
    };
    await rebuildMigrationCorpus({
      root,
      codeCollection: "code_test",
      qdrant,
      embeddings,
      parse: parseMigrationOperations,
    });
    const points = await qdrant.scrollFiltered("code_test_migrations", {}, 100);
    expect(points.some((point) => point.payload.content === "# schema changed by an external helper\n")).toBe(true);
  });

  it("uses the provider's actual vector width when its configured dimensions differ", async () => {
    root = await mkdtemp(join(process.cwd(), ".migration-corpus-test-"));
    await mkdir(join(root, "db/migrate"), { recursive: true });
    await writeFile(join(root, "db/migrate/20261028000000_orders.rb"), "# schema changed by an external helper\n");
    const qdrant = {
      createCollection: vi.fn(async () => {}),
      addPointsWithSparse: vi.fn(async () => {}),
      deleteCollection: vi.fn(async () => {}),
      collectionExists: vi.fn(async () => false),
      aliases: { createAlias: vi.fn(async () => {}), switchAlias: vi.fn() },
    };
    const embeddings = {
      getDimensions: () => 3,
      embed: vi.fn(async () => ({ embedding: [1, 0, 0, 0, 0] })),
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => ({ embedding: [1, 0, 0, 0, 0] }))),
    };
    await rebuildMigrationCorpus({
      root,
      codeCollection: "code_test",
      qdrant,
      embeddings,
      parse: parseMigrationOperations,
    });
    expect(qdrant.createCollection).toHaveBeenCalledWith(expect.any(String), 5, "Cosine", true);
  });
});
