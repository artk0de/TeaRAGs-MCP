import { StatsV6ScoreBackground, StatsV7SamplingContract } from "./stats_migrations/index.js";
import type { Migration, MigrationRunner, StatsStore } from "./types.js";

const LATEST = 7;

/**
 * MigrationRunner for stats-cache backfills.
 *
 * Version is derived from the DATA, not from the file's own version field —
 * the same approach SnapshotMigrator takes with the snapshot format. A stats
 * file can be at version 6 and still lack `scoreBackground`, because the
 * writer stores that field only when the measurement succeeded. Reading the
 * declared version would report 6, the runner would skip the migration, and
 * the field would stay missing forever.
 *
 * With no stats file at all there is nothing to backfill into, so the runner
 * reports the latest version and every migration is skipped. The stats file
 * arrives with the run that computes stats in the first place.
 */
export class StatsMigrator implements MigrationRunner {
  private readonly migrations: Migration[];

  /** Latest stats version — computed from registered migrations. */
  readonly latestVersion: number;

  constructor(
    private readonly collection: string,
    private readonly store: StatsStore,
  ) {
    this.migrations = [new StatsV6ScoreBackground(collection, store), new StatsV7SamplingContract(collection, store)];
    this.latestVersion = Math.max(...this.migrations.map((m) => m.version));
  }

  /**
   * Both states are read from the DATA, and the OLDEST unmet one wins: the
   * runner applies every migration above the reported version, so reporting the
   * newer gap would skip the older one. Order matters beyond bookkeeping — v7
   * rebuilds the stats file from payload and carries the background across, so
   * a background that is still missing has to be measured by v6 first.
   *
   * v7 has no terminal version: the contract can move again, and each time it
   * does the same rebuild repairs it. That is why the state is read from the
   * data here too rather than from a number the file declares.
   */
  async getVersion(): Promise<number> {
    const background = await this.store.getBackgroundState(this.collection);
    if (background === "missing-background") return 5;

    const contract = await this.store.getStatsContractState(this.collection);
    return contract === "stale" ? LATEST - 1 : LATEST;
  }

  async setVersion(_version: number): Promise<void> {
    // Version is implicit in the stats file the migration writes.
    // No separate version record to update.
  }

  getMigrations(): Migration[] {
    return this.migrations;
  }
}
