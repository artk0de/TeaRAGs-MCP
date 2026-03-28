import { describe, expect, it, vi } from "vitest";

import { SnapshotMigrator } from "../../../../src/core/infra/migration/snapshot-migrator.js";
import type { SnapshotStore } from "../../../../src/core/infra/migration/types.js";

function createMockStore(format: "v1" | "v2" | "sharded" | "none" = "v1"): SnapshotStore {
  return {
    getFormat: vi.fn().mockResolvedValue(format),
    readV1: vi.fn().mockResolvedValue({
      fileHashes: { "src/a.ts": "abc123" },
      codebasePath: "/project",
    }),
    readV2: vi.fn().mockResolvedValue({
      fileMetadata: { "src/a.ts": { mtime: 1000, size: 100, hash: "abc123" } },
      codebasePath: "/project",
    }),
    writeSharded: vi.fn().mockResolvedValue(undefined),
    backup: vi.fn().mockResolvedValue(undefined),
    deleteOld: vi.fn().mockResolvedValue(undefined),
    statFile: vi.fn().mockResolvedValue({ mtimeMs: 1000, size: 100 }),
  };
}

describe("SnapshotMigrator", () => {
  it("reports version 1 for v1 format", async () => {
    const store = createMockStore("v1");
    const migrator = new SnapshotMigrator(store);
    expect(await migrator.getVersion()).toBe(1);
  });

  it("reports version 2 for v2 format", async () => {
    const store = createMockStore("v2");
    const migrator = new SnapshotMigrator(store);
    expect(await migrator.getVersion()).toBe(2);
  });

  it("reports version 3 for sharded format", async () => {
    const store = createMockStore("sharded");
    const migrator = new SnapshotMigrator(store);
    expect(await migrator.getVersion()).toBe(3);
  });

  it("reports version 0 for no snapshot", async () => {
    const store = createMockStore("none");
    const migrator = new SnapshotMigrator(store);
    expect(await migrator.getVersion()).toBe(0);
  });

  it("computes latestVersion from registered migrations", () => {
    const store = createMockStore();
    const migrator = new SnapshotMigrator(store);
    expect(migrator.latestVersion).toBe(3);
  });

  it("has 2 migrations registered", () => {
    const store = createMockStore();
    const migrator = new SnapshotMigrator(store);
    const migrations = migrator.getMigrations();
    expect(migrations).toHaveLength(2);
    expect(migrations[0].version).toBe(2);
    expect(migrations[1].version).toBe(3);
  });

  it("setVersion is no-op (format is implicit)", async () => {
    const store = createMockStore();
    const migrator = new SnapshotMigrator(store);
    await expect(migrator.setVersion(3)).resolves.toBeUndefined();
  });
});

describe("SnapshotV1ToV2", () => {
  it("adds mtime/size to each file via stat()", async () => {
    const store = createMockStore("v1");
    const migrator = new SnapshotMigrator(store);
    const migration = migrator.getMigrations()[0]; // v1→v2

    const result = await migration.apply();
    expect(store.readV1).toHaveBeenCalled();
    expect(store.statFile).toHaveBeenCalledWith("/project/src/a.ts");
    expect(store.writeSharded).toHaveBeenCalled();
    expect(result.applied.length).toBeGreaterThan(0);
  });

  it("skips files that no longer exist", async () => {
    const store = createMockStore("v1");
    (store.statFile as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const migrator = new SnapshotMigrator(store);
    const migration = migrator.getMigrations()[0];

    const result = await migration.apply();
    expect(result.applied).toEqual(expect.arrayContaining([expect.stringContaining("skipped")]));
  });

  it("returns early when no v1 data", async () => {
    const store = createMockStore("v1");
    (store.readV1 as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const migrator = new SnapshotMigrator(store);
    const migration = migrator.getMigrations()[0];

    await migration.apply();
    expect(store.writeSharded).not.toHaveBeenCalled();
  });
});

describe("SnapshotV2ToSharded", () => {
  it("reads v2, backs up, writes sharded, deletes old", async () => {
    const store = createMockStore("v2");
    const migrator = new SnapshotMigrator(store);
    const migration = migrator.getMigrations()[1]; // v2→sharded

    await migration.apply();
    expect(store.readV2).toHaveBeenCalled();
    expect(store.backup).toHaveBeenCalled();
    expect(store.writeSharded).toHaveBeenCalled();
    expect(store.deleteOld).toHaveBeenCalled();
  });

  it("skips files that no longer exist during v2→sharded", async () => {
    const store = createMockStore("v2");
    (store.statFile as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const migrator = new SnapshotMigrator(store);
    const migration = migrator.getMigrations()[1];

    const result = await migration.apply();
    // writeSharded still called (with 0 files), but statFile returned null
    expect(result.applied).toEqual(expect.arrayContaining([expect.stringContaining("skipped")]));
  });

  it("returns early when no v2 data", async () => {
    const store = createMockStore("v2");
    (store.readV2 as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const migrator = new SnapshotMigrator(store);
    const migration = migrator.getMigrations()[1];

    await migration.apply();
    expect(store.backup).not.toHaveBeenCalled();
  });
});
