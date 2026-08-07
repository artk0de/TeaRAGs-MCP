import { describe, expect, it, vi } from "vitest";

import { StatsMigrator } from "../../../../../src/core/domains/maintenance/migration/stats-migrator.js";
import type { StatsStore } from "../../../../../src/core/domains/maintenance/migration/types.js";

type BackgroundState = "none" | "missing-background" | "complete";

function createMockStore(state: BackgroundState = "missing-background", backfilled = true): StatsStore {
  return {
    getBackgroundState: vi.fn().mockResolvedValue(state),
    backfillScoreBackground: vi.fn().mockResolvedValue(backfilled),
  };
}

describe("StatsMigrator", () => {
  it("reports the latest version when no stats file exists", async () => {
    const migrator = new StatsMigrator("col", createMockStore("none"));
    expect(await migrator.getVersion()).toBe(migrator.latestVersion);
  });

  it("reports a version below latest when the file lacks scoreBackground", async () => {
    const migrator = new StatsMigrator("col", createMockStore("missing-background"));
    expect(await migrator.getVersion()).toBeLessThan(migrator.latestVersion);
  });

  it("reports the latest version once scoreBackground is present", async () => {
    const migrator = new StatsMigrator("col", createMockStore("complete"));
    expect(await migrator.getVersion()).toBe(migrator.latestVersion);
  });

  it("computes latestVersion from registered migrations", () => {
    const migrator = new StatsMigrator("col", createMockStore());
    expect(migrator.latestVersion).toBe(6);
  });

  it("has 1 migration registered", () => {
    const migrator = new StatsMigrator("col", createMockStore());
    expect(migrator.getMigrations()).toHaveLength(1);
  });

  it("does not persist a version — it is implicit in the stats file", async () => {
    const store = createMockStore();
    const migrator = new StatsMigrator("col", store);
    await expect(migrator.setVersion(6)).resolves.toBeUndefined();
  });
});

describe("StatsV6ScoreBackground", () => {
  it("reports the backfilled field when the background was stored", async () => {
    const store = createMockStore("missing-background", true);
    const [migration] = new StatsMigrator("col", store).getMigrations();

    const result = await migration.apply();

    expect(store.backfillScoreBackground).toHaveBeenCalledWith("col");
    expect(result.applied).toEqual(["scoreBackground"]);
  });

  it("reports nothing applied when the background could not be computed", async () => {
    const store = createMockStore("missing-background", false);
    const [migration] = new StatsMigrator("col", store).getMigrations();

    const result = await migration.apply();

    expect(result.applied).toEqual([]);
  });

  it("is registered at version 6 under a stable name", () => {
    const [migration] = new StatsMigrator("col", createMockStore()).getMigrations();
    expect(migration.version).toBe(6);
    expect(migration.name).toBe("stats-v6-score-background");
  });
});
