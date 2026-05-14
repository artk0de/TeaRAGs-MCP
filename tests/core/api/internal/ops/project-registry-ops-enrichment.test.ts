import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProjectNameNotUniqueError } from "../../../../../src/core/api/errors.js";
import { ProjectRegistryOps } from "../../../../../src/core/api/internal/ops/project-registry-ops.js";
import { CollectionRegistry } from "../../../../../src/core/infra/registry/collection-registry.js";

function fakeQdrant(opts: {
  existing: boolean;
  count?: number;
  vectorSize?: number;
  model?: string;
  teaRagsVersion?: string;
  indexedAt?: string;
  completedAt?: string;
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
      return [
        {
          id: "x",
          payload: {
            embeddingModel: opts.model ?? "",
            ...(opts.teaRagsVersion !== undefined && { teaRagsVersion: opts.teaRagsVersion }),
            ...(opts.indexedAt !== undefined && { indexedAt: opts.indexedAt }),
            ...(opts.completedAt !== undefined && { completedAt: opts.completedAt }),
          },
        },
      ];
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
    // Marker payload had no indexedAt/completedAt → honest empty string,
    // not a faked new Date() stamp. Audit #14.
    expect(entry?.indexedAt).toBe("");
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

  it("re-register on populated entry SKIPS Qdrant enrichment (rename-only fast path)", async () => {
    const registry = new CollectionRegistry(dir);
    // First register: enrich from live Qdrant — populates chunksCount > 0.
    const liveQdrant = fakeQdrant({ existing: true, count: 100, vectorSize: 768, model: "first-model" });
    await new ProjectRegistryOps({ registry, qdrant: liveQdrant }).register({ path: realPath, name: "alpha" });

    // Second register: Qdrant mock now reports DIFFERENT data, but fast path
    // must NOT call into it. We assert by recording call counts.
    let exists = 0;
    let count = 0;
    let info = 0;
    let scroll = 0;
    const trapQdrant = {
      url: "http://localhost:7777",
      collectionExists: async () => {
        exists++;
        return true;
      },
      countPoints: async () => {
        count++;
        return 9999;
      },
      getCollectionInfo: async () => {
        info++;
        return {
          name: "x",
          vectorSize: 4096,
          pointsCount: 9999,
          distance: "Cosine" as const,
          hybridEnabled: false,
          status: "green" as const,
          optimizerStatus: "ok",
        };
      },
      scrollFiltered: async () => {
        scroll++;
        return [{ id: "x", payload: { embeddingModel: "trap-model" } }];
      },
    } as never;
    const out = await new ProjectRegistryOps({ registry, qdrant: trapQdrant }).register({
      path: realPath,
      name: "alpha-renamed",
    });

    expect(out.alreadyIndexed).toBe(true);
    expect({ exists, count, info, scroll }).toEqual({ exists: 0, count: 0, info: 0, scroll: 0 });
    // Enrichment preserved — name updated.
    const entry = registry.findByName("alpha-renamed");
    expect(entry?.chunksCount).toBe(100);
    expect(entry?.embeddingModel).toBe("first-model");
    expect(entry?.embeddingDimensions).toBe(768);
    expect(entry?.qdrantUrl).toBe("http://localhost:6333");
    // Old name freed.
    expect(registry.findByName("alpha")).toBeNull();
  });

  it("re-register on stub entry (chunksCount=0) DOES re-enrich (preserves zkaz fix)", async () => {
    const registry = new CollectionRegistry(dir);
    // First register without qdrant → stub with chunksCount=0.
    await new ProjectRegistryOps({ registry }).register({ path: realPath, name: "stub" });
    expect(registry.findByName("stub")?.chunksCount).toBe(0);

    // Second register with live qdrant → populates fields.
    const qdrant = fakeQdrant({ existing: true, count: 42, vectorSize: 384, model: "post-index-model" });
    const out = await new ProjectRegistryOps({ registry, qdrant }).register({ path: realPath, name: "stub" });

    expect(out.alreadyIndexed).toBe(true);
    const entry = registry.findByName("stub");
    expect(entry?.chunksCount).toBe(42);
    expect(entry?.embeddingModel).toBe("post-index-model");
  });

  it("rename via re-register (populated, different name) does not require Qdrant", async () => {
    const registry = new CollectionRegistry(dir);
    const qdrant = fakeQdrant({ existing: true, count: 5, vectorSize: 384, model: "m" });
    await new ProjectRegistryOps({ registry, qdrant }).register({ path: realPath, name: "old-name" });

    // Rename works WITHOUT injecting qdrant at all.
    const out = await new ProjectRegistryOps({ registry }).register({ path: realPath, name: "new-name" });
    expect(out.alreadyIndexed).toBe(true);
    expect(registry.findByName("new-name")?.chunksCount).toBe(5);
    expect(registry.findByName("old-name")).toBeNull();
  });

  it("reads teaRagsVersion and indexedAt from indexing-marker payload", async () => {
    const registry = new CollectionRegistry(dir);
    const qdrant = fakeQdrant({
      existing: true,
      count: 42,
      vectorSize: 384,
      model: "real-model",
      teaRagsVersion: "1.24.0",
      indexedAt: "2026-05-13T12:00:00.000Z",
    });
    await new ProjectRegistryOps({ registry, qdrant }).register({ path: realPath, name: "with-version" });

    const entry = registry.findByName("with-version");
    expect(entry?.teaRagsVersion).toBe("1.24.0");
    expect(entry?.indexedAt).toBe("2026-05-13T12:00:00.000Z");
    expect(entry?.embeddingModel).toBe("real-model");
  });

  it("falls back to completedAt when indexedAt is missing (older markers)", async () => {
    const registry = new CollectionRegistry(dir);
    const qdrant = fakeQdrant({
      existing: true,
      count: 10,
      vectorSize: 384,
      model: "m",
      // Older markers wrote only completedAt, no indexedAt.
      completedAt: "2026-01-01T00:00:00.000Z",
    });
    await new ProjectRegistryOps({ registry, qdrant }).register({ path: realPath, name: "legacy" });

    expect(registry.findByName("legacy")?.indexedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("keeps empty teaRagsVersion when marker has none (pre-v5js indexes)", async () => {
    const registry = new CollectionRegistry(dir);
    // No teaRagsVersion in payload (legacy marker).
    const qdrant = fakeQdrant({ existing: true, count: 1, vectorSize: 384, model: "m" });
    await new ProjectRegistryOps({ registry, qdrant }).register({ path: realPath, name: "no-version" });

    expect(registry.findByName("no-version")?.teaRagsVersion).toBe("");
  });
});
