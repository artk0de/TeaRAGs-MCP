import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INDEXING_METADATA_ID } from "../../../../src/core/contracts/constants.js";
import { CollectionIndexingLock } from "../../../../src/core/domains/ingest/infra/collection-indexing-lock.js";
import { QuarantineStore } from "../../../../src/core/domains/ingest/sync/quarantine-store.js";
import { ShardedSnapshotManager } from "../../../../src/core/domains/ingest/sync/snapshot/sharded-snapshot.js";
import { IndexingLockHeldError } from "../../../../src/core/domains/maintenance/errors.js";
import { CodegraphArtifact } from "../../../../src/core/domains/maintenance/footprint/codegraph-artifact.js";
import { CollectionFootprintFactory } from "../../../../src/core/domains/maintenance/footprint/factory.js";
import { IndexingLockArtifact } from "../../../../src/core/domains/maintenance/footprint/indexing-lock-artifact.js";
import { QdrantArtifact } from "../../../../src/core/domains/maintenance/footprint/qdrant-artifact.js";
import { QuarantineArtifact } from "../../../../src/core/domains/maintenance/footprint/quarantine-artifact.js";
import { SnapshotArtifact } from "../../../../src/core/domains/maintenance/footprint/snapshot-artifact.js";
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
    snapshotStoreFactory: (b: string, l: string) => new ShardedSnapshotManager(b, l),
    quarantineStoreFactory: (b: string, l: string) => new QuarantineStore(b, l),
    indexingLockStoreFactory: (b: string, l: string) => ({
      removeIfStale: async () => new CollectionIndexingLock({ lockDir: b }).removeIfStale(l),
    }),
  };

  it("builds artifacts in clone order and exposes a context", () => {
    const f = new CollectionFootprintFactory(deps);
    const { artifacts, context } = f.build(
      resolved(),
      resolved({ logicalName: "code_dst", physicalName: "code_dst_v1" }),
    );
    expect(artifacts.map((a) => a.id)).toEqual([
      "qdrant",
      "codegraph",
      "snapshot",
      "stats",
      "quarantine",
      "indexing-lock",
    ]);
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

  // bd tea-rags-mcp-k8gac — what a seeded first index still owes must be on the
  // clone's marker from the first instant a run can address the clone by its
  // logical name, i.e. before the alias exists.
  it("clone: writes the target marker patch onto the recovered collection BEFORE the alias exposes it", async () => {
    const qdrant = { ...makeQdrant(), setPayload: vi.fn().mockResolvedValue(undefined) };
    const callOrder: string[] = [];
    qdrant.recoverFromSnapshot.mockImplementation(async () => {
      callOrder.push("recoverFromSnapshot");
    });
    qdrant.setPayload.mockImplementation(async () => {
      callOrder.push("setPayload");
    });
    qdrant.aliases.createAlias.mockImplementation(async () => {
      callOrder.push("createAlias");
    });
    const artifact = new QdrantArtifact(qdrant as never);
    const patch = { worktreeSeedPending: { seededAt: "2026-09-19T00:00:00Z", languageVersions: {} } };

    await artifact.clone({
      source: resolved(),
      target: resolved({ logicalName: "code_dst", physicalName: "code_dst_v1" }),
      targetIndexingMarkerPatch: patch,
    });

    expect(callOrder).toEqual(["recoverFromSnapshot", "setPayload", "createAlias"]);
    expect(qdrant.setPayload).toHaveBeenCalledWith("code_dst_v1", patch, {
      points: [INDEXING_METADATA_ID],
      wait: true,
    });
  });

  it("clone: a failed marker write never creates the alias and still deletes the snapshot", async () => {
    const qdrant = { ...makeQdrant(), setPayload: vi.fn().mockRejectedValue(new Error("marker write refused")) };
    const artifact = new QdrantArtifact(qdrant as never);

    await expect(
      artifact.clone({
        source: resolved(),
        target: resolved({ logicalName: "code_dst", physicalName: "code_dst_v1" }),
        targetIndexingMarkerPatch: { worktreeSeedPending: { seededAt: "t", languageVersions: {} } },
      }),
    ).rejects.toThrow("marker write refused");
    expect(qdrant.aliases.createAlias).not.toHaveBeenCalled();
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

  it("remove: still deletes the collection after the alias delete fails", async () => {
    // A logical name that was never an alias 404s here — normal, not a failure.
    const qdrant = makeQdrant();
    qdrant.aliases.deleteAlias.mockRejectedValue(new Error("alias not found"));
    const artifact = new QdrantArtifact(qdrant as never);
    const ctx = {
      source: resolved(),
      target: resolved({ logicalName: "code_dst", physicalName: "code_dst_v1" }),
    };
    await artifact.remove(ctx);
    expect(qdrant.deleteCollection).toHaveBeenCalledWith("code_dst_v1");
  });

  it("remove: surfaces a collection-delete failure so the caller can report the reason", async () => {
    // The alias delete is optional cleanup; deleting the collection IS the job.
    // Swallowing its reason left a purge unable to say WHY a generation survived.
    const qdrant = makeQdrant();
    qdrant.deleteCollection.mockRejectedValue(new Error("network down"));
    const artifact = new QdrantArtifact(qdrant as never);
    const ctx = {
      source: resolved(),
      target: resolved({ logicalName: "code_dst", physicalName: "code_dst_v1" }),
    };
    await expect(artifact.remove(ctx)).rejects.toThrow("network down");
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

  it("clone: calls cloneDatabase with source and target PHYSICAL names when enabled", async () => {
    const pool = { cloneDatabase: vi.fn().mockResolvedValue(undefined), removeCollection: vi.fn() };
    const artifact = new CodegraphArtifact(pool as never);
    // logical != physical to catch regressions that pass logicalName instead
    const ctx = {
      source: resolved({ logicalName: "code_src", physicalName: "code_src_v30" }),
      target: resolved({ logicalName: "code_dst", physicalName: "code_dst_v1" }),
    };
    await artifact.clone(ctx);
    expect(pool.cloneDatabase).toHaveBeenCalledWith("code_src_v30", "code_dst_v1");
  });

  it("remove: calls removeCollection with target PHYSICAL name", async () => {
    const pool = { cloneDatabase: vi.fn(), removeCollection: vi.fn().mockResolvedValue(undefined) };
    const artifact = new CodegraphArtifact(pool as never);
    const ctx = {
      source: resolved(),
      target: resolved({ logicalName: "code_dst", physicalName: "code_dst_v30" }),
    };
    await artifact.remove(ctx);
    expect(pool.removeCollection).toHaveBeenCalledWith("code_dst_v30");
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

describe("SnapshotArtifact", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "snap-art-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("clone: delegates to ShardedSnapshotManager.cloneTo and target snapshot exists", async () => {
    // seed source snapshot via the real manager so cloneTo has something to copy
    const src = new ShardedSnapshotManager(dir, "code_src");
    await src.save("/old/path", new Map([["a.ts", { hash: "h", mtime: 1, size: 2 }]]));

    const artifact = new SnapshotArtifact(dir, (b, l) => new ShardedSnapshotManager(b, l));
    const ctx = {
      source: { ...resolved(), logicalName: "code_src" },
      target: { ...resolved(), logicalName: "code_dst", path: "/new/path" },
    };
    await artifact.clone(ctx);

    const dst = new ShardedSnapshotManager(dir, "code_dst");
    expect(await dst.exists()).toBe(true);
  });

  it("clone: is a no-op when source snapshot is absent", async () => {
    const artifact = new SnapshotArtifact(dir, (b, l) => new ShardedSnapshotManager(b, l));
    const ctx = {
      source: { ...resolved(), logicalName: "code_missing" },
      target: { ...resolved(), logicalName: "code_dst", path: "/new/path" },
    };
    await expect(artifact.clone(ctx)).resolves.not.toThrow();
  });

  it("remove: deletes the target snapshot directory", async () => {
    const mgr = new ShardedSnapshotManager(dir, "code_dst");
    await mgr.save("/some/path", new Map([["a.ts", { hash: "h", mtime: 1, size: 2 }]]));
    expect(await mgr.exists()).toBe(true);

    const artifact = new SnapshotArtifact(dir, (b, l) => new ShardedSnapshotManager(b, l));
    const ctx = {
      source: resolved(),
      target: { ...resolved(), logicalName: "code_dst", path: "/some/path" },
    };
    await artifact.remove(ctx);
    expect(await mgr.exists()).toBe(false);
  });
});

describe("QuarantineArtifact", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "quar-art-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("clone: delegates to QuarantineStore.cloneTo and target quarantine file exists", async () => {
    // seed source quarantine file so cloneTo has something to copy
    writeFileSync(join(dir, "code_src.quarantine.json"), '{"version":1,"updatedAt":"2026-01-01","files":{}}');

    const artifact = new QuarantineArtifact(dir, (b, l) => new QuarantineStore(b, l));
    const ctx = {
      source: { ...resolved(), logicalName: "code_src" },
      target: { ...resolved(), logicalName: "code_dst" },
    };
    await artifact.clone(ctx);

    expect(existsSync(join(dir, "code_dst.quarantine.json"))).toBe(true);
  });

  it("clone: is a no-op when source quarantine is absent", async () => {
    const artifact = new QuarantineArtifact(dir, (b, l) => new QuarantineStore(b, l));
    const ctx = {
      source: { ...resolved(), logicalName: "code_missing" },
      target: { ...resolved(), logicalName: "code_dst" },
    };
    await expect(artifact.clone(ctx)).resolves.not.toThrow();
    expect(existsSync(join(dir, "code_dst.quarantine.json"))).toBe(false);
  });

  it("remove: clears the target quarantine file via clearAll", async () => {
    writeFileSync(join(dir, "code_dst.quarantine.json"), '{"version":1,"updatedAt":"2026-01-01","files":{}}');
    expect(existsSync(join(dir, "code_dst.quarantine.json"))).toBe(true);

    const artifact = new QuarantineArtifact(dir, (b, l) => new QuarantineStore(b, l));
    const ctx = {
      source: resolved(),
      target: { ...resolved(), logicalName: "code_dst" },
    };
    await artifact.remove(ctx);
    expect(existsSync(join(dir, "code_dst.quarantine.json"))).toBe(false);
  });
});

describe("IndexingLockArtifact", () => {
  const DEAD_PID = 4242;
  const LIVE_PID = 5151;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lock-art-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const lockPath = (logicalName: string): string => join(dir, `${logicalName}.indexing.lock`);

  function writeLock(logicalName: string, pid: number): void {
    const now = new Date().toISOString();
    writeFileSync(
      lockPath(logicalName),
      JSON.stringify({ pid, hostname: hostname(), startedAt: now, heartbeatAt: now, operation: "force-reindex" }),
    );
  }

  function artifact(): IndexingLockArtifact {
    return new IndexingLockArtifact(dir, (baseDir, logicalName) => ({
      removeIfStale: async () =>
        new CollectionIndexingLock({ lockDir: baseDir, isProcessAlive: (pid) => pid !== DEAD_PID }).removeIfStale(
          logicalName,
        ),
    }));
  }

  const ctx = () => ({
    source: resolved(),
    target: resolved({ logicalName: "code_dst", physicalName: "code_dst_v1" }),
  });

  it("keys on the logical name — one lock per collection, whichever generation is being built", () => {
    expect(artifact().addressing).toBe("logical");
  });

  it("clone: never copies a lock — the clone is not being indexed", async () => {
    writeLock("code_src", LIVE_PID);

    await artifact().clone(ctx());

    expect(existsSync(lockPath("code_dst"))).toBe(false);
  });

  it("remove: deletes the target's lock when the run that held it is dead", async () => {
    writeLock("code_dst", DEAD_PID);

    await artifact().remove(ctx());

    expect(existsSync(lockPath("code_dst"))).toBe(false);
  });

  it("remove: refuses a live run's lock, leaving it in place and naming the holder", async () => {
    writeLock("code_dst", LIVE_PID);

    const removal = artifact().remove(ctx());

    await expect(removal).rejects.toBeInstanceOf(IndexingLockHeldError);
    await expect(removal).rejects.toThrow(/pid 5151/);
    expect((JSON.parse(readFileSync(lockPath("code_dst"), "utf8")) as { pid: number }).pid).toBe(LIVE_PID);
  });

  it("remove: is a no-op when the target has no lock", async () => {
    await expect(artifact().remove(ctx())).resolves.toBeUndefined();
  });
});
