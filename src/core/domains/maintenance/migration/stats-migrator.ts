import { StatsV6ScoreBackground } from "./stats_migrations/index.js";
import type { Migration, MigrationRunner, StatsStore } from "./types.js";

const LATEST = 6;

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
    this.migrations = [new StatsV6ScoreBackground(collection, store)];
    this.latestVersion = Math.max(...this.migrations.map((m) => m.version));
  }

  async getVersion(): Promise<number> {
    const state = await this.store.getBackgroundState(this.collection);
    return state === "missing-background" ? LATEST - 1 : LATEST;
  }

  async setVersion(_version: number): Promise<void> {
    // Version is implicit in the stats file the migration writes.
    // No separate version record to update.
  }

  getMigrations(): Migration[] {
    return this.migrations;
  }
}
