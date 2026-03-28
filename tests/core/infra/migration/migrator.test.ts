import { describe, expect, it, vi } from "vitest";

import { Migrator } from "../../../../src/core/infra/migration/migrator.js";
import type { Migration, MigrationRunner } from "../../../../src/core/infra/migration/types.js";

function createMockMigration(name: string, version: number): Migration {
  return {
    name,
    version,
    apply: vi.fn().mockResolvedValue({ applied: [`${name} done`] }),
  };
}

function createMockRunner(migrations: Migration[], currentVersion = 0): MigrationRunner {
  return {
    getVersion: vi.fn().mockResolvedValue(currentVersion),
    setVersion: vi.fn().mockResolvedValue(undefined),
    getMigrations: () => migrations,
  };
}

describe("Migrator", () => {
  it("routes run() to correct pipeline runner", async () => {
    const snapshotMigration = createMockMigration("snap-v2", 2);
    const schemaMigration = createMockMigration("schema-v4", 4);

    const migrator = new Migrator({
      snapshot: createMockRunner([snapshotMigration], 1),
      schema: createMockRunner([schemaMigration], 3),
    });

    const result = await migrator.run("snapshot");
    expect(result.pipeline).toBe("snapshot");
    expect(snapshotMigration.apply).toHaveBeenCalled();
    expect(schemaMigration.apply).not.toHaveBeenCalled();
  });

  it("skips migrations at or below current version", async () => {
    const m1 = createMockMigration("old", 2);
    const m2 = createMockMigration("new", 4);
    const runner = createMockRunner([m1, m2], 3);

    const migrator = new Migrator({ snapshot: runner, schema: createMockRunner([]) });
    const result = await migrator.run("snapshot");

    expect(m1.apply).not.toHaveBeenCalled();
    expect(m2.apply).toHaveBeenCalled();
    expect(result.fromVersion).toBe(3);
    expect(result.toVersion).toBe(4);
  });

  it("runs migrations in version order", async () => {
    const order: string[] = [];
    const m5: Migration = {
      name: "v5",
      version: 5,
      apply: vi.fn().mockImplementation(async () => {
        order.push("v5");
        return { applied: [] };
      }),
    };
    const m4: Migration = {
      name: "v4",
      version: 4,
      apply: vi.fn().mockImplementation(async () => {
        order.push("v4");
        return { applied: [] };
      }),
    };
    const runner = createMockRunner([m5, m4], 3);
    const migrator = new Migrator({ snapshot: runner, schema: createMockRunner([]) });
    await migrator.run("snapshot");

    expect(order).toEqual(["v4", "v5"]);
  });

  it("stores version after successful migrations", async () => {
    const migration = createMockMigration("v8", 8);
    const runner = createMockRunner([migration], 6);
    const migrator = new Migrator({ snapshot: runner, schema: createMockRunner([]) });

    await migrator.run("snapshot");
    expect(runner.setVersion).toHaveBeenCalledWith(8);
  });

  it("does not store version when no migrations applied", async () => {
    const runner = createMockRunner([], 8);
    const migrator = new Migrator({ snapshot: runner, schema: createMockRunner([]) });

    const result = await migrator.run("snapshot");
    expect(runner.setVersion).not.toHaveBeenCalled();
    expect(result.steps).toEqual([]);
  });

  it("stops on first failure and does not store version", async () => {
    const m1: Migration = {
      name: "ok",
      version: 4,
      apply: vi.fn().mockResolvedValue({ applied: ["done"] }),
    };
    const m2: Migration = {
      name: "fail",
      version: 5,
      apply: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const m3: Migration = {
      name: "never",
      version: 6,
      apply: vi.fn(),
    };
    const runner = createMockRunner([m1, m2, m3], 3);
    const migrator = new Migrator({ snapshot: runner, schema: createMockRunner([]) });

    await expect(migrator.run("snapshot")).rejects.toThrow("boom");
    expect(m3.apply).not.toHaveBeenCalled();
    expect(runner.setVersion).not.toHaveBeenCalled();
  });
});
