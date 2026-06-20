import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChunkOversizedError, FileReadError } from "../../../../../src/core/domains/ingest/errors.js";
import { QuarantineStore } from "../../../../../src/core/domains/ingest/sync/quarantine-store.js";

describe("QuarantineStore", () => {
  let snapshotDir: string;
  let collectionName: string;
  let store: QuarantineStore;

  beforeEach(async () => {
    snapshotDir = join(tmpdir(), `quarantine-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    collectionName = "test-collection";
    // v3 layout: per-collection subdir holds meta.json, shards, quarantine.json
    await fs.mkdir(join(snapshotDir, collectionName), { recursive: true });
    store = new QuarantineStore(snapshotDir, collectionName);
  });

  afterEach(async () => {
    try {
      await fs.rm(snapshotDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("load", () => {
    it("should return an empty map when quarantine.json does not exist", async () => {
      const loaded = await store.load();

      expect(loaded.size).toBe(0);
    });

    it("should return an empty map when quarantine.json is corrupted", async () => {
      const quarantinePath = join(snapshotDir, `${collectionName}.quarantine.json`);
      await fs.writeFile(quarantinePath, "{ invalid json }", "utf-8");

      const loaded = await store.load();

      expect(loaded.size).toBe(0);
    });
  });

  describe("markFailed", () => {
    it("should persist a single file entry that load() reads back", async () => {
      await store.markFailed(
        "src/foo/oversized.ts",
        new ChunkOversizedError("src/foo/oversized.ts", "chunk 12480 > 8192"),
      );

      const loaded = await store.load();
      const entry = loaded.get("src/foo/oversized.ts");

      expect(loaded.size).toBe(1);
      expect(entry?.errorCode).toBe("INGEST_CHUNK_OVERSIZED");
      expect(entry?.phase).toBe("embed");
      expect(entry?.errorMessage).toContain("12480");
      expect(entry?.attempts).toBe(1);
      expect(entry?.firstFailedAt).toBeDefined();
      expect(entry?.lastFailedAt).toBeDefined();
    });

    it("should increment attempts and preserve firstFailedAt on repeated failure", async () => {
      const path = "src/foo/oversized.ts";
      await store.markFailed(path, new ChunkOversizedError(path, "first"));
      const firstFailedAt = (await store.load()).get(path)?.firstFailedAt;

      await store.markFailed(path, new ChunkOversizedError(path, "second"));
      const entry = (await store.load()).get(path);

      expect(entry?.attempts).toBe(2);
      expect(entry?.firstFailedAt).toBe(firstFailedAt);
    });

    it("should leave no leftover .tmp file after an atomic write", async () => {
      await store.markFailed("src/foo.ts", new FileReadError("src/foo.ts", "EACCES"));

      const dirEntries = await fs.readdir(snapshotDir);

      expect(dirEntries.some((name) => name.endsWith(".tmp"))).toBe(false);
      expect(dirEntries).toContain(`${collectionName}.quarantine.json`);
    });
  });

  describe("markFailedBatch", () => {
    it("should mark multiple files in a single write", async () => {
      await store.markFailedBatch(
        ["src/a.ts", "src/b.ts", "src/c.ts"],
        new ChunkOversizedError("batch", "oversized batch"),
      );

      const loaded = await store.load();

      expect(loaded.size).toBe(3);
      expect(loaded.get("src/a.ts")?.attempts).toBe(1);
      expect(loaded.get("src/b.ts")?.errorCode).toBe("INGEST_CHUNK_OVERSIZED");
    });
  });

  describe("clear", () => {
    it("should remove a single entry while leaving others intact", async () => {
      await store.markFailed("src/a.ts", new FileReadError("src/a.ts", "x"));
      await store.markFailed("src/b.ts", new FileReadError("src/b.ts", "y"));

      await store.clear("src/a.ts");

      const loaded = await store.load();
      expect(loaded.has("src/a.ts")).toBe(false);
      expect(loaded.has("src/b.ts")).toBe(true);
    });

    it("should be a no-op when clearing a path that is not quarantined", async () => {
      await store.markFailed("src/a.ts", new FileReadError("src/a.ts", "x"));

      await store.clear("src/never-failed.ts");

      const loaded = await store.load();
      expect(loaded.size).toBe(1);
      expect(loaded.has("src/a.ts")).toBe(true);
    });
  });

  describe("clearAll", () => {
    it("should drop every entry", async () => {
      await store.markFailedBatch(["src/a.ts", "src/b.ts"], new FileReadError("batch", "x"));

      await store.clearAll();

      const loaded = await store.load();
      expect(loaded.size).toBe(0);
    });

    it("should be a no-op when nothing is quarantined", async () => {
      await expect(store.clearAll()).resolves.not.toThrow();
      expect((await store.load()).size).toBe(0);
    });
  });

  describe("concurrency", () => {
    it("persists every entry when many files fail concurrently", async () => {
      const paths = Array.from({ length: 20 }, (_, i) => `src/file-${i}.ts`);

      await Promise.all(paths.map(async (p) => store.markFailed(p, new FileReadError(p, "concurrent"))));

      const loaded = await store.load();
      expect(loaded.size).toBe(20);
      for (const p of paths) {
        expect(loaded.has(p)).toBe(true);
      }
    });
  });

  describe("durability across snapshot save", () => {
    it("survives an atomic swap of the collection snapshot directory", async () => {
      await store.markFailed("poison.ts", new FileReadError("poison.ts", "EACCES"));

      // ShardedSnapshotManager.atomicSwap removes the whole <collection>/ dir and
      // renames a fresh temp dir in. The quarantine list must live OUTSIDE that
      // dir or it is wiped every time a snapshot is saved after a poison file.
      await fs.rm(join(snapshotDir, collectionName), { recursive: true, force: true });

      expect(await store.count()).toBe(1);
    });
  });

  describe("count", () => {
    it("should return the number of quarantined files", async () => {
      expect(await store.count()).toBe(0);

      await store.markFailedBatch(["src/a.ts", "src/b.ts"], new FileReadError("batch", "x"));

      expect(await store.count()).toBe(2);
    });
  });
});
