import {
  SchemaV4RelativePathKeyword,
  SchemaV5RelativePathText,
  SchemaV6FilterFieldIndexes,
  SchemaV7SparseConfig,
  SchemaV8SymbolIdText,
  SchemaV9EnrichedAtBackfill,
  SchemaV10PurgeMarkdownChunks,
  SchemaV11RenameParentSymbolId,
  SchemaV12EnrichmentPayloadIndexes,
} from "./schema_migrations/index.js";
import type { EnrichmentStore, IndexStore, Migration, MigrationRunner, SnapshotStore } from "./types.js";

export interface SchemaMigratorOptions {
  enableHybrid: boolean;
  providerKey?: string;
}

export class SchemaMigrator implements MigrationRunner {
  private readonly migrations: Migration[];
  private readonly appliedIndexes: string[] = [];

  /** Latest schema version — computed from registered migrations. */
  readonly latestVersion: number;

  constructor(
    private readonly collection: string,
    private readonly indexStore: IndexStore,
    private readonly options: SchemaMigratorOptions,
    private readonly enrichmentStore?: EnrichmentStore,
    private readonly snapshotStore?: SnapshotStore,
  ) {
    this.migrations = [
      new SchemaV4RelativePathKeyword(collection, indexStore),
      new SchemaV5RelativePathText(collection, indexStore),
      new SchemaV6FilterFieldIndexes(collection, indexStore),
      new SchemaV7SparseConfig(collection, indexStore, options.enableHybrid),
      new SchemaV8SymbolIdText(collection, indexStore),
      ...(enrichmentStore && options.providerKey
        ? [new SchemaV9EnrichedAtBackfill(collection, enrichmentStore, options.providerKey)]
        : []),
      new SchemaV10PurgeMarkdownChunks(collection, indexStore, snapshotStore),
      new SchemaV11RenameParentSymbolId(
        collection,
        indexStore as IndexStore &
          Required<Pick<IndexStore, "scrollAllPayload" | "batchSetPayload" | "deletePayloadKeys">>,
      ),
      new SchemaV12EnrichmentPayloadIndexes(collection, indexStore),
    ];
    this.latestVersion = Math.max(...this.migrations.map((m) => m.version));
  }

  getMigrations(): Migration[] {
    return this.migrations;
  }

  async getVersion(): Promise<number> {
    return this.indexStore.getSchemaVersion(this.collection);
  }

  async setVersion(version: number): Promise<void> {
    await this.indexStore.storeSchemaVersion(this.collection, version, this.appliedIndexes);
  }
}
