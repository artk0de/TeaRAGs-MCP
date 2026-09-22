import { describe, expect, it, vi } from "vitest";

import { StatsMigrator } from "../../../../../src/core/domains/maintenance/migration/stats-migrator.js";
import type { StatsStore } from "../../../../../src/core/domains/maintenance/migration/types.js";

type BackgroundState = "none" | "missing-background" | "complete";
type ContractState = "none" | "stale" | "current";

function createMockStore(
  state: BackgroundState = "missing-background",
  backfilled = true,
  contract: ContractState = "current",
  rebuilt = true,
): StatsStore {
  return {
    getBackgroundState: vi.fn().mockResolvedValue(state),
    backfillScoreBackground: vi.fn().mockResolvedValue(backfilled),
    getStatsContractState: vi.fn().mockResolvedValue(contract),
    rebuildStatsFromPayload: vi.fn().mockResolvedValue(rebuilt),
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
    expect(migrator.latestVersion).toBe(7);
  });

  it("has 2 migrations registered", () => {
    const migrator = new StatsMigrator("col", createMockStore());
    expect(migrator.getMigrations()).toHaveLength(2);
  });

  /**
   * A stats file is only interpretable against the procedure that produced it.
   * Percentiles sampled under a procedure the build has since changed — a file
   * counted once per chunk, a measured zero dropped, a chunk type excluded —
   * describe a population nobody is asking about, and keep feeding labels,
   * filter-preset thresholds and adaptive bounds until something recomputes them.
   */
  describe("sampling contract (v7)", () => {
    it("reports a version below latest while the sample answers a stale contract", async () => {
      const migrator = new StatsMigrator("col", createMockStore("complete", true, "stale"));
      expect(await migrator.getVersion()).toBe(6);
    });

    it("reports the latest version once the sample matches the declared contract", async () => {
      const migrator = new StatsMigrator("col", createMockStore("complete", true, "current"));
      expect(await migrator.getVersion()).toBe(migrator.latestVersion);
    });

    it("reports the OLDEST unmet version when both backfills are outstanding", async () => {
      // v6 must run before v7: rebuilding stats from payload preserves the
      // background it finds, so a missing one has to be measured first.
      const migrator = new StatsMigrator("col", createMockStore("missing-background", true, "stale"));
      expect(await migrator.getVersion()).toBe(5);
    });

    it("rebuilds the stats file from stored payload, without a reindex", async () => {
      const store = createMockStore("complete", true, "stale");
      const migrator = new StatsMigrator("col", store);
      const v7 = migrator.getMigrations().find((m) => m.version === 7);

      const result = await v7?.apply();

      expect(store.rebuildStatsFromPayload).toHaveBeenCalledWith("col");
      expect(result?.applied.join(" ")).toMatch(/sampling contract/i);
    });

    it("reports the skip instead of failing when there is nothing to rebuild", async () => {
      const store = createMockStore("none", true, "none", false);
      const migrator = new StatsMigrator("col", store);
      const v7 = migrator.getMigrations().find((m) => m.version === 7);

      const result = await v7?.apply();

      expect(result?.applied.join(" ")).toMatch(/skipped/i);
    });
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
