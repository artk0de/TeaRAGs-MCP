import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
});
