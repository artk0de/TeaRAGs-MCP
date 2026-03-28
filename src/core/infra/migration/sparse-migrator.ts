import { SparseVectorRebuild } from "./sparse_migrations/sparse-v1-vector-rebuild.js";
import type { Migration, MigrationRunner, SparseStore } from "./types.js";

export class SparseMigrator implements MigrationRunner {
  private readonly migrations: Migration[];

  /** Latest sparse version — computed from registered migrations. */
  readonly latestVersion: number;

  constructor(
    private readonly collection: string,
    private readonly store: SparseStore,
    enableHybrid: boolean,
  ) {
    this.migrations = [new SparseVectorRebuild(collection, store, enableHybrid)];
    this.latestVersion = Math.max(...this.migrations.map((m) => m.version));
  }

  getMigrations(): Migration[] {
    return this.migrations;
  }

  async getVersion(): Promise<number> {
    return this.store.getSparseVersion(this.collection);
  }

  async setVersion(version: number): Promise<void> {
    await this.store.storeSparseVersion(this.collection, version);
  }
}
