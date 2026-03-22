import { promises as fs } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SnapshotCleaner } from "../../../../../src/core/domains/ingest/sync/snapshot-cleaner.js";

describe("SnapshotCleaner", () => {
  let tempDir: string;
  const collectionName = "code_test1234";

  beforeEach(async () => {
    tempDir = join(process.env.TEA_RAGS_DATA_DIR!, "snapshots-cleaner-test");
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("cleanupAfterIndexing()", () => {
    it("should delete all artifact types", async () => {
      await fs.writeFile(join(tempDir, `${collectionName}.checkpoint.json`), "{}");
      await fs.writeFile(join(tempDir, `${collectionName}.checkpoint.json.tmp`), "{}");
      await fs.writeFile(join(tempDir, `${collectionName}.json`), "{}");
      await fs.writeFile(join(tempDir, `${collectionName}.json.backup`), "{}");

      const v3Dir = join(tempDir, collectionName);
      await fs.mkdir(v3Dir, { recursive: true });
      await fs.writeFile(join(v3Dir, "meta.json"), "{}");

      const cleaner = new SnapshotCleaner(tempDir, collectionName);
      await cleaner.cleanupAfterIndexing();

      await expect(fs.access(join(tempDir, `${collectionName}.checkpoint.json`))).rejects.toThrow();
      await expect(fs.access(join(tempDir, `${collectionName}.checkpoint.json.tmp`))).rejects.toThrow();
      await expect(fs.access(join(tempDir, `${collectionName}.json`))).rejects.toThrow();
      await expect(fs.access(join(tempDir, `${collectionName}.json.backup`))).rejects.toThrow();

      await expect(fs.access(join(v3Dir, "meta.json"))).resolves.toBeUndefined();
    });

    it("should be idempotent — no-op on clean directory", async () => {
      const cleaner = new SnapshotCleaner(tempDir, collectionName);
      await cleaner.cleanupAfterIndexing();
    });

    it("should handle partial presence — only checkpoint exists", async () => {
      await fs.writeFile(join(tempDir, `${collectionName}.checkpoint.json`), "{}");

      const cleaner = new SnapshotCleaner(tempDir, collectionName);
      await cleaner.cleanupAfterIndexing();

      await expect(fs.access(join(tempDir, `${collectionName}.checkpoint.json`))).rejects.toThrow();
    });

    it("should not touch other collections' artifacts", async () => {
      const otherCollection = "code_other999";
      await fs.writeFile(join(tempDir, `${otherCollection}.checkpoint.json`), "{}");
      await fs.writeFile(join(tempDir, `${otherCollection}.json`), "{}");

      const cleaner = new SnapshotCleaner(tempDir, collectionName);
      await cleaner.cleanupAfterIndexing();

      await expect(fs.access(join(tempDir, `${otherCollection}.checkpoint.json`))).resolves.toBeUndefined();
      await expect(fs.access(join(tempDir, `${otherCollection}.json`))).resolves.toBeUndefined();
    });
  });
});
