import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProjectNameNotUniqueError } from "../../src/core/api/errors.js";
import { ProjectRegistryOps } from "../../src/core/api/internal/ops/project-registry-ops.js";
import { CollectionRegistry } from "../../src/core/infra/registry/collection-registry.js";

function fakeQdrant(opts: {
  existing: boolean;
  count?: number;
  vectorSize?: number;
  model?: string;
  throwOn?: "exists" | "count" | "info" | "scroll";
}): never {
  return {
    url: "http://localhost:6333",
    collectionExists: async () => {
      if (opts.throwOn === "exists") throw new Error("qdrant down");
      return opts.existing;
    },
    countPoints: async () => {
      if (opts.throwOn === "count") throw new Error("count fail");
      return opts.count ?? 0;
    },
    getCollectionInfo: async () => {
      if (opts.throwOn === "info") throw new Error("info fail");
      return {
        name: "x",
        vectorSize: opts.vectorSize ?? 384,
        pointsCount: opts.count ?? 0,
        distance: "Cosine" as const,
        hybridEnabled: false,
        status: "green" as const,
        optimizerStatus: "ok",
      };
    },
    scrollFiltered: async () => {
      if (opts.throwOn === "scroll") throw new Error("scroll fail");
      return [{ id: "x", payload: { embeddingModel: opts.model ?? "" } }];
    },
  } as never;
}

describe("ProjectRegistryOps.register — enrichment & uniqueness", () => {
  let dir: string;
  let realPath: string;
  let realPath2: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "enrich-"));
    realPath = join(dir, "repo");
    realPath2 = join(dir, "repo2");
    mkdirSync(realPath, { recursive: true });
    mkdirSync(realPath2, { recursive: true });
    writeFileSync(join(realPath, ".keep"), "");
    writeFileSync(join(realPath2, ".keep"), "");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("enriches metadata from Qdrant when collection already indexed", async () => {
    const registry = new CollectionRegistry(dir);
    const qdrant = fakeQdrant({ existing: true, count: 1234, vectorSize: 768, model: "real-model" });
    const ops = new ProjectRegistryOps({ registry, qdrant });
    const out = await ops.register({ path: realPath, name: "alpha" });
    expect(out.alreadyIndexed).toBe(true);
    const entry = registry.findByName("alpha");
    expect(entry?.chunksCount).toBe(1234);
    expect(entry?.embeddingDimensions).toBe(768);
    expect(entry?.embeddingModel).toBe("real-model");
    expect(entry?.qdrantUrl).toBe("http://localhost:6333");
    expect(entry?.indexedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("falls back to stub when Qdrant collection does not exist", async () => {
    const registry = new CollectionRegistry(dir);
    const qdrant = fakeQdrant({ existing: false });
    const ops = new ProjectRegistryOps({ registry, qdrant });
    const out = await ops.register({ path: realPath, name: "stub" });
    expect(out.alreadyIndexed).toBe(false);
    const entry = registry.findByName("stub");
    expect(entry?.chunksCount).toBe(0);
    expect(entry?.embeddingModel).toBe("");
  });

  it("tolerates Qdrant collectionExists failure (keeps fallback)", async () => {
    const registry = new CollectionRegistry(dir);
    const qdrant = fakeQdrant({ existing: true, throwOn: "exists" });
    const ops = new ProjectRegistryOps({ registry, qdrant });
    const out = await ops.register({ path: realPath, name: "soft-fail" });
    expect(out.alreadyIndexed).toBe(false);
  });

  it("tolerates Qdrant countPoints / getCollectionInfo / scroll failures", async () => {
    const registry = new CollectionRegistry(dir);
    for (const stage of ["count", "info", "scroll"] as const) {
      const qdrant = fakeQdrant({ existing: true, count: 5, vectorSize: 384, model: "m", throwOn: stage });
      const ops = new ProjectRegistryOps({ registry, qdrant });
      const out = await ops.register({ path: realPath, name: `partial-${stage}` });
      // Some metadata may be missing but the register itself does not throw.
      const entry = registry.findByName(`partial-${stage}`);
      expect(entry).not.toBeNull();
      // alreadyIndexed flips on chunksCount which may have come through or not.
      expect(typeof out.alreadyIndexed).toBe("boolean");
    }
  });

  it("rejects duplicate name BEFORE recording stub (no orphan entry)", async () => {
    const registry = new CollectionRegistry(dir);
    const ops = new ProjectRegistryOps({ registry });
    await ops.register({ path: realPath, name: "shared" });
    await expect(ops.register({ path: realPath2, name: "shared" })).rejects.toThrow(ProjectNameNotUniqueError);
    // No orphan stub for realPath2 — its collectionName should not be in registry.
    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0].path).toBe(realpathSync(realPath));
  });

  it("re-register with the same path + name is a no-op upsert (sticky name preserved)", async () => {
    const registry = new CollectionRegistry(dir);
    const ops = new ProjectRegistryOps({ registry });
    await ops.register({ path: realPath, name: "alpha" });
    await ops.register({ path: realPath, name: "alpha" });
    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("alpha");
  });
});
