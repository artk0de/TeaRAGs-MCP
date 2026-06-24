import { describe, expect, it, vi } from "vitest";
import { CollectionFootprintFactory } from "../../../../src/core/domains/maintenance/footprint/factory.js";
import { QdrantArtifact } from "../../../../src/core/domains/maintenance/footprint/qdrant-artifact.js";
import { CodegraphArtifact } from "../../../../src/core/domains/maintenance/footprint/codegraph-artifact.js";
import { StatsArtifact } from "../../../../src/core/domains/maintenance/footprint/stats-artifact.js";

function resolved(over: Record<string, unknown> = {}) {
  return {
    logicalName: "code_src",
    physicalName: "code_src_v1",
    path: "/p",
    embeddingModel: "j",
    embeddingDimensions: 768,
    qdrantUrl: "http://h",
    codegraphEnabled: true,
    ...over,
  };
}

describe("CollectionFootprintFactory", () => {
  const deps = {
    qdrant: {} as never,
    pool: {} as never,
    statsCache: { clone: vi.fn(), invalidate: vi.fn() } as never,
    snapshotBaseDir: "/snap",
  };

  it("builds artifacts in clone order and exposes a context", () => {
    const f = new CollectionFootprintFactory(deps);
    const { artifacts, context } = f.build(
      resolved(),
      resolved({ logicalName: "code_dst", physicalName: "code_dst_v1" }),
    );
    expect(artifacts.map((a) => a.id)).toEqual(["qdrant", "codegraph", "snapshot", "stats", "quarantine"]);
    expect(context.target.logicalName).toBe("code_dst");
  });
});

describe("QdrantArtifact", () => {
  function makeQdrant() {
    return {
      createSnapshot: vi.fn().mockResolvedValue("snap-001"),
      snapshotDownloadUrl: vi.fn().mockReturnValue("http://host/snap-001"),
      recoverFromSnapshot: vi.fn().mockResolvedValue(undefined),
      deleteSnapshot: vi.fn().mockResolvedValue(undefined),
      aliases: {
        createAlias: vi.fn().mockResolvedValue(undefined),
        deleteAlias: vi.fn().mockResolvedValue(undefined),
      },
      deleteCollection: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("clone: calls createSnapshot → recoverFromSnapshot → createAlias in order, then deleteSnapshot in finally", async () => {
    const qdrant = makeQdrant();
    const artifact = new QdrantArtifact(qdrant as never);
    const callOrder: string[] = [];
    qdrant.createSnapshot.mockImplementation(async () => {
      callOrder.push("createSnapshot");
      return "snap-001";
    });
    qdrant.recoverFromSnapshot.mockImplementation(async () => {
      callOrder.push("recoverFromSnapshot");
    });
    qdrant.aliases.createAlias.mockImplementation(async () => {
      callOrder.push("createAlias");
    });
    qdrant.deleteSnapshot.mockImplementation(async () => {
      callOrder.push("deleteSnapshot");
    });

    const ctx = {
      source: resolved(),
      target: resolved({ logicalName: "code_dst", physicalName: "code_dst_v1" }),
    };
    await artifact.clone(ctx);

    expect(callOrder).toEqual(["createSnapshot", "recoverFromSnapshot", "createAlias", "deleteSnapshot"]);
  });

  it("clone: calls deleteSnapshot in finally even when recoverFromSnapshot throws", async () => {
    const qdrant = makeQdrant();
    qdrant.recoverFromSnapshot.mockRejectedValue(new Error("recover failed"));
    const artifact = new QdrantArtifact(qdrant as never);
    const ctx = {
      source: resolved(),
      target: resolved({ logicalName: "d", physicalName: "dv1" }),
    };
    await expect(artifact.clone(ctx)).rejects.toThrow("recover failed");
    expect(qdrant.deleteSnapshot).toHaveBeenCalledOnce();
  });

  it("remove: calls deleteAlias and deleteCollection, swallowing errors", async () => {
    const qdrant = makeQdrant();
    qdrant.aliases.deleteAlias.mockRejectedValue(new Error("alias gone"));
    const artifact = new QdrantArtifact(qdrant as never);
    const ctx = {
      source: resolved(),
      target: resolved({ logicalName: "code_dst", physicalName: "code_dst_v1" }),
    };
    await expect(artifact.remove(ctx)).resolves.not.toThrow();
    expect(qdrant.aliases.deleteAlias).toHaveBeenCalledWith("code_dst");
  });
});

describe("CodegraphArtifact", () => {
  it("clone: skips cloneDatabase when codegraphEnabled is false", async () => {
    const pool = { cloneDatabase: vi.fn(), removeCollection: vi.fn() };
    const artifact = new CodegraphArtifact(pool as never);
    const ctx = {
      source: resolved({ codegraphEnabled: false }),
      target: resolved({ logicalName: "d", physicalName: "dv1" }),
    };
    await artifact.clone(ctx);
    expect(pool.cloneDatabase).not.toHaveBeenCalled();
  });

  it("clone: calls cloneDatabase with source and target logical names when enabled", async () => {
    const pool = { cloneDatabase: vi.fn().mockResolvedValue(undefined), removeCollection: vi.fn() };
    const artifact = new CodegraphArtifact(pool as never);
    const ctx = {
      source: resolved(),
      target: resolved({ logicalName: "code_dst", physicalName: "code_dst_v1" }),
    };
    await artifact.clone(ctx);
    expect(pool.cloneDatabase).toHaveBeenCalledWith("code_src", "code_dst");
  });
});

describe("StatsArtifact", () => {
  it("clone: delegates to statsCache.clone", async () => {
    const statsCache = { clone: vi.fn(), invalidate: vi.fn() };
    const artifact = new StatsArtifact(statsCache as never);
    const ctx = {
      source: resolved(),
      target: resolved({ logicalName: "code_dst", physicalName: "code_dst_v1" }),
    };
    await artifact.clone(ctx);
    expect(statsCache.clone).toHaveBeenCalledWith("code_src", "code_dst");
  });

  it("remove: delegates to statsCache.invalidate", async () => {
    const statsCache = { clone: vi.fn(), invalidate: vi.fn() };
    const artifact = new StatsArtifact(statsCache as never);
    const ctx = {
      source: resolved(),
      target: resolved({ logicalName: "code_dst", physicalName: "code_dst_v1" }),
    };
    await artifact.remove(ctx);
    expect(statsCache.invalidate).toHaveBeenCalledWith("code_dst");
  });
});
