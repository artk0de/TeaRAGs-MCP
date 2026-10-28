import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  defaultTestConfig,
  defaultTrajectoryConfig,
  MockEmbeddingProvider,
  MockQdrantManager,
} from "../__helpers__/test-helpers.js";
import { warmChunkerPoolFactory } from "../__helpers__/warm-chunker-pool.js";
import { IngestFacade } from "../../../../../src/core/api/index.js";

describe("migration corpus indexing", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("isolates migrations from code and refreshes the corpus on subsequent runs", async () => {
    root = await mkdtemp(join(process.cwd(), ".migration-index-test-"));
    const project = join(root, "project");
    await mkdir(join(project, "db/migrate"), { recursive: true });
    await writeFile(join(project, "app.ts"), "export const value = 1;\n");
    const migration = join(project, "db/migrate/20261028000000_orders.rb");
    await writeFile(
      migration,
      "class Orders < ActiveRecord::Migration[7.0]\n def change\n add_column :orders, :vendor_id, :uuid\n end\nend\n",
    );
    const qdrant = new MockQdrantManager();
    const config = { ...defaultTestConfig(), supportedExtensions: [".ts", ".rb"] };
    const ingest = new IngestFacade({
      qdrant: qdrant as any,
      embeddings: new MockEmbeddingProvider(),
      config,
      trajectoryConfig: defaultTrajectoryConfig(),
      snapshotDir: join(root, "snapshots"),
      createChunkerPool: warmChunkerPoolFactory,
    });
    await ingest.indexCodebase(project);
    const code = (await ingest.getIndexStatus(project)).collectionName!;
    const corpus = `${code}_migrations`;
    const codePoints = await qdrant.scrollFiltered(code, {}, 100);
    const migrationPoints = await qdrant.scrollFiltered(corpus, {}, 100);
    expect(codePoints.some((point) => point.payload.relativePath === "db/migrate/20261028000000_orders.rb")).toBe(
      false,
    );
    expect(migrationPoints.some((point) => point.payload.operation === "add_column")).toBe(true);
    await rm(migration);
    await ingest.indexCodebase(project);
    expect(
      (await qdrant.scrollFiltered(corpus, {}, 100)).some((point) => point.payload.operation === "add_column"),
    ).toBe(false);
    await ingest.clearIndex(project);
    expect(await qdrant.collectionExists(corpus)).toBe(false);
  });
});
