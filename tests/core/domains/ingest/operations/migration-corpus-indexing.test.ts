import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defaultTestConfig,
  defaultTrajectoryConfig,
  MockEmbeddingProvider,
  MockQdrantManager,
} from "../__helpers__/test-helpers.js";
import { warmChunkerPoolFactory } from "../__helpers__/warm-chunker-pool.js";
import { IngestFacade } from "../../../../../src/core/api/index.js";
import { INDEXING_METADATA_ID } from "../../../../../src/core/contracts/constants.js";

describe("migration corpus indexing", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("removes an added file that disappears after an interrupted write", async () => {
    root = await mkdtemp(join(process.cwd(), ".migration-index-test-"));
    const project = join(root, "project");
    const dir = join(project, "db/migrate");
    await mkdir(dir, { recursive: true });
    await writeFile(join(project, "app.ts"), "export const value = 1;\n");
    await writeFile(join(dir, "20261028000000_orders.rb"), "add_column :orders, :status, :string\n");
    const qdrant = new MockQdrantManager();
    const ingest = new IngestFacade({
      qdrant: qdrant as any,
      embeddings: new MockEmbeddingProvider(),
      config: { ...defaultTestConfig(), supportedExtensions: [".ts", ".rb"] },
      blobReaderFactory: async () => {
        throw new Error("blob reads are not expected with enrichment off");
      },
      trajectoryConfig: defaultTrajectoryConfig(),
      snapshotDir: join(root, "snapshots"),
      createChunkerPool: warmChunkerPoolFactory,
    });
    await ingest.indexCodebase(project);
    const corpus = `${(await ingest.getIndexStatus(project)).collectionName!}_migrations`;
    const vendors = join(dir, "20261028000001_vendors.rb");
    await writeFile(vendors, "add_column :vendors, :name, :string\n");
    const original = qdrant.addPointsWithSparse.bind(qdrant);
    const write = vi.spyOn(qdrant, "addPointsWithSparse").mockImplementationOnce(async (collection, points) => {
      await original(collection, points);
      throw new Error("write timed out");
    });
    await expect(ingest.indexCodebase(project)).rejects.toThrow("write timed out");
    write.mockRestore();
    await rm(vendors);
    await ingest.indexCodebase(project);
    expect((await qdrant.getPoint(corpus, INDEXING_METADATA_ID))?.payload?.indexingComplete).toBe(true);
    expect(
      (await qdrant.scrollFiltered(corpus, {}, 100)).some((p) => String(p.payload.relativePath).endsWith("vendors.rb")),
    ).toBe(false);
  });

  it("marks an interrupted incremental update incomplete until retry succeeds", async () => {
    root = await mkdtemp(join(process.cwd(), ".migration-index-test-"));
    const project = join(root, "project");
    const dir = join(project, "db/migrate");
    await mkdir(dir, { recursive: true });
    await writeFile(join(project, "app.ts"), "export const value = 1;\n");
    const orders = join(dir, "20261028000000_orders.rb");
    await writeFile(orders, "add_column :orders, :status, :string\n");
    const qdrant = new MockQdrantManager();
    const ingest = new IngestFacade({
      qdrant: qdrant as any,
      embeddings: new MockEmbeddingProvider(),
      config: { ...defaultTestConfig(), supportedExtensions: [".ts", ".rb"] },
      blobReaderFactory: async () => {
        throw new Error("blob reads are not expected with enrichment off");
      },
      trajectoryConfig: defaultTrajectoryConfig(),
      snapshotDir: join(root, "snapshots"),
      createChunkerPool: warmChunkerPoolFactory,
    });
    await ingest.indexCodebase(project);
    const code = (await ingest.getIndexStatus(project)).collectionName!;
    const corpus = `${code}_migrations`;
    await writeFile(orders, "add_column :orders, :reference, :uuid\n");
    const write = vi.spyOn(qdrant, "addPointsWithSparse").mockRejectedValueOnce(new Error("write failed"));
    await expect(ingest.indexCodebase(project)).rejects.toThrow("write failed");
    expect((await qdrant.getPoint(corpus, INDEXING_METADATA_ID))?.payload?.indexingComplete).toBe(false);
    write.mockRestore();
    await ingest.indexCodebase(project);
    expect((await qdrant.getPoint(corpus, INDEXING_METADATA_ID))?.payload?.indexingComplete).toBe(true);
    expect(
      (await qdrant.scrollFiltered(corpus, {}, 100)).some((p) => String(p.payload.content).includes("reference")),
    ).toBe(true);
  });

  it("embeds only added or modified migration files and removes deleted files", async () => {
    root = await mkdtemp(join(process.cwd(), ".migration-index-test-"));
    const project = join(root, "project");
    const dir = join(project, "db/migrate");
    await mkdir(dir, { recursive: true });
    await writeFile(join(project, "app.ts"), "export const value = 1;\n");
    const orders = join(dir, "20261028000000_orders.rb");
    const vendors = join(dir, "20261028000001_vendors.rb");
    await writeFile(orders, "add_column :orders, :status, :string\n");
    await writeFile(vendors, "add_column :vendors, :name, :string\n");
    const embeddings = new MockEmbeddingProvider();
    const embedBatch = vi.spyOn(embeddings, "embedBatch");
    const qdrant = new MockQdrantManager();
    const ingest = new IngestFacade({
      qdrant: qdrant as any,
      embeddings,
      config: { ...defaultTestConfig(), supportedExtensions: [".ts", ".rb"] },
      blobReaderFactory: async () => {
        throw new Error("blob reads are not expected with enrichment off");
      },
      trajectoryConfig: defaultTrajectoryConfig(),
      snapshotDir: join(root, "snapshots"),
      createChunkerPool: warmChunkerPoolFactory,
    });
    await ingest.indexCodebase(project);
    embedBatch.mockClear();
    await writeFile(orders, "add_column :orders, :reference, :uuid\n");
    await ingest.indexCodebase(project);
    expect(embedBatch.mock.calls.flatMap(([texts]) => texts).join("\n")).toContain("reference");
    expect(embedBatch.mock.calls.flatMap(([texts]) => texts).join("\n")).not.toContain("vendors");
    embedBatch.mockClear();
    await rm(orders);
    await ingest.indexCodebase(project);
    expect(embedBatch).not.toHaveBeenCalled();
    const code = (await ingest.getIndexStatus(project)).collectionName!;
    const points = await qdrant.scrollFiltered(`${code}_migrations`, {}, 100);
    expect(points.some((point) => String(point.payload.relativePath).endsWith("orders.rb"))).toBe(false);
    expect(points.some((point) => String(point.payload.relativePath).endsWith("vendors.rb"))).toBe(true);
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
      blobReaderFactory: async () => {
        throw new Error("blob reads are not expected with enrichment off");
      },
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
