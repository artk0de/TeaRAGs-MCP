import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QdrantManager } from "../../../../../src/core/adapters/qdrant/client.js";
import {
  PathDoesNotExistError,
  ProjectNameInvalidError,
  ProjectNameNotUniqueError,
} from "../../../../../src/core/api/errors.js";
import { ProjectRegistryOps } from "../../../../../src/core/api/internal/ops/project-registry-ops.js";
import { CollectionRegistry } from "../../../../../src/core/infra/registry/collection-registry.js";

describe("ProjectRegistryOps", () => {
  let dir: string;
  let realPath: string;
  let ops: ProjectRegistryOps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pro-"));
    realPath = join(dir, "repo");
    mkdirSync(realPath, { recursive: true });
    writeFileSync(join(realPath, ".keep"), "");
    ops = new ProjectRegistryOps({ registry: new CollectionRegistry(dir) });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("register() upserts a name and returns collectionName", async () => {
    const out = await ops.register({ path: realPath, name: "alpha" });
    expect(out.collectionName).toMatch(/^code_[a-f0-9]{8}$/);
    expect(out.alreadyIndexed).toBe(false);
  });

  it("register() throws PathDoesNotExistError on missing path", async () => {
    await expect(ops.register({ path: "/no/such/path", name: "x" })).rejects.toThrow(PathDoesNotExistError);
  });

  it("register() throws ProjectNameInvalidError on bad regex", async () => {
    await expect(ops.register({ path: realPath, name: "BAD NAME" })).rejects.toThrow(ProjectNameInvalidError);
  });

  it("register() throws ProjectNameNotUniqueError on duplicate name", async () => {
    const repo2 = join(dir, "repo2");
    mkdirSync(repo2);
    await ops.register({ path: realPath, name: "shared" });
    await expect(ops.register({ path: repo2, name: "shared" })).rejects.toThrow(ProjectNameNotUniqueError);
  });

  it("list() returns all entries", async () => {
    await ops.register({ path: realPath, name: "alpha" });
    const out = await ops.list();
    expect(out.projects).toHaveLength(1);
    expect(out.projects[0].name).toBe("alpha");
  });

  it("unregister() is idempotent (removed=false when missing)", async () => {
    const out1 = await ops.unregister({ name: "nope" });
    expect(out1.removed).toBe(false);
    await ops.register({ path: realPath, name: "alpha" });
    const out2 = await ops.unregister({ name: "alpha" });
    expect(out2.removed).toBe(true);
  });

  describe("recoverFromQdrant", () => {
    it("populates registry from Qdrant collections + sample payload", async () => {
      const recDir = mkdtempSync(join(tmpdir(), "rec-"));
      try {
        const registry = new CollectionRegistry(recDir);
        const qdrant = {
          url: "http://localhost:6333",
          listCollections: async () => ["code_abc", "code_def"],
          getCollectionInfo: async (n: string) => ({
            name: n,
            vectorSize: n === "code_abc" ? 384 : 768,
            pointsCount: 0,
            distance: "Cosine" as const,
            hybridEnabled: false,
            status: "green" as const,
            optimizerStatus: "ok",
          }),
          scrollFiltered: async () => [{ id: "x", payload: { embeddingModel: "m-fake" } }],
        };
        const embeddings = {
          getModel: () => "m-fake",
          getDimensions: () => 384,
        };
        const recOps = new ProjectRegistryOps({
          registry,
          qdrant: qdrant as never,
          embeddings: embeddings as never,
          snapshotDir: "/no/snapshots",
        });
        await recOps.recoverFromQdrant();
        const list = registry.list();
        expect(list).toHaveLength(2);
        expect(list.find((e) => e.collectionName === "code_abc")?.embeddingDimensions).toBe(384);
        expect(list.find((e) => e.collectionName === "code_def")?.embeddingDimensions).toBe(768);
        expect(list.find((e) => e.collectionName === "code_abc")?.embeddingModel).toBe("m-fake");
        expect(list.find((e) => e.collectionName === "code_abc")?.qdrantUrl).toBe("http://localhost:6333");
      } finally {
        rmSync(recDir, { recursive: true, force: true });
      }
    });

    it("skips collections already present in registry", async () => {
      const recDir = mkdtempSync(join(tmpdir(), "rec-skip-"));
      try {
        const registry = new CollectionRegistry(recDir);
        registry.record({
          collectionName: "code_abc",
          path: "/existing/path",
          embeddingModel: "existing-model",
          embeddingDimensions: 512,
          qdrantUrl: "http://existing",
          indexedAt: "2026-01-01T00:00:00Z",
          teaRagsVersion: "1.0.0",
          chunksCount: 99,
        });
        const qdrant = {
          url: "http://localhost:6333",
          listCollections: async () => ["code_abc"],
          getCollectionInfo: async () => ({
            name: "code_abc",
            vectorSize: 384,
            pointsCount: 0,
            distance: "Cosine" as const,
            hybridEnabled: false,
            status: "green" as const,
            optimizerStatus: "ok",
          }),
          scrollFiltered: async () => [{ id: "x", payload: { embeddingModel: "m-fake" } }],
        };
        const recOps = new ProjectRegistryOps({ registry, qdrant: qdrant as never });
        await recOps.recoverFromQdrant();
        const entry = registry.get("code_abc");
        expect(entry?.embeddingModel).toBe("existing-model");
        expect(entry?.embeddingDimensions).toBe(512);
        expect(entry?.chunksCount).toBe(99);
      } finally {
        rmSync(recDir, { recursive: true, force: true });
      }
    });

    it("throws if recoverFromQdrant called without qdrant injected", async () => {
      const recDir = mkdtempSync(join(tmpdir(), "rec2-"));
      try {
        const recOps = new ProjectRegistryOps({ registry: new CollectionRegistry(recDir) });
        await expect(recOps.recoverFromQdrant()).rejects.toThrow();
      } finally {
        rmSync(recDir, { recursive: true, force: true });
      }
    });
  });

  describe("tryEnrichFromQdrant honesty (audit #14)", () => {
    it("leaves indexedAt empty when marker payload is absent (no fake Date.now stamp)", async () => {
      const qdrant = {
        url: "http://localhost:6333",
        collectionExists: vi.fn().mockResolvedValue(true),
        countPoints: vi.fn().mockResolvedValue(42), // non-zero chunks
        getCollectionInfo: vi.fn().mockResolvedValue({ vectorSize: 384 }),
        scrollFiltered: vi.fn().mockResolvedValue([]), // no marker
      } as unknown as QdrantManager;

      const registry = new CollectionRegistry(dir);
      const opsWithQdrant = new ProjectRegistryOps({ registry, qdrant });
      await opsWithQdrant.register({ path: realPath, name: "alpha" });

      const stored = registry.list()[0];
      // Old code: stamped new Date() here. New code: leaves "" honestly.
      expect(stored.indexedAt).toBe("");
      // Sanity: not a freshly-minted 2026-XX timestamp.
      expect(stored.indexedAt).not.toMatch(/^2026-/);
    });

    it("preserves marker-derived indexedAt when payload has it", async () => {
      const qdrant = {
        url: "http://localhost:6333",
        collectionExists: vi.fn().mockResolvedValue(true),
        countPoints: vi.fn().mockResolvedValue(42),
        getCollectionInfo: vi.fn().mockResolvedValue({ vectorSize: 384 }),
        scrollFiltered: vi.fn().mockResolvedValue([
          {
            payload: {
              embeddingModel: "jina-v2",
              teaRagsVersion: "1.25.0",
              indexedAt: "2026-05-01T00:00:00.000Z",
              _type: "indexing_metadata",
            },
          },
        ]),
      } as unknown as QdrantManager;

      const registry = new CollectionRegistry(dir);
      const opsWithQdrant = new ProjectRegistryOps({ registry, qdrant });
      await opsWithQdrant.register({ path: realPath, name: "beta" });

      const stored = registry.list()[0];
      expect(stored.indexedAt).toBe("2026-05-01T00:00:00.000Z");
      expect(stored.embeddingModel).toBe("jina-v2");
      expect(stored.teaRagsVersion).toBe("1.25.0");
    });

    it("falls back to completedAt when only completedAt is set", async () => {
      const qdrant = {
        url: "http://localhost:6333",
        collectionExists: vi.fn().mockResolvedValue(true),
        countPoints: vi.fn().mockResolvedValue(42),
        getCollectionInfo: vi.fn().mockResolvedValue({ vectorSize: 384 }),
        scrollFiltered: vi.fn().mockResolvedValue([
          {
            payload: {
              embeddingModel: "jina-v2",
              completedAt: "2026-05-02T00:00:00.000Z",
              _type: "indexing_metadata",
            },
          },
        ]),
      } as unknown as QdrantManager;

      const registry = new CollectionRegistry(dir);
      const opsWithQdrant = new ProjectRegistryOps({ registry, qdrant });
      await opsWithQdrant.register({ path: realPath, name: "gamma" });

      const stored = registry.list()[0];
      expect(stored.indexedAt).toBe("2026-05-02T00:00:00.000Z");
    });
  });
});
