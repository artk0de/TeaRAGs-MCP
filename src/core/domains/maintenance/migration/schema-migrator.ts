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
  SchemaV13RenameOwnershipPayload,
  SchemaV14EnrichmentScanIndexes,
  SchemaV15CodegraphFilterIndexes,
  SchemaV16DropUndeclaredPayloadIndexes,
} from "./schema_migrations/index.js";
import type { EnrichmentStore, IndexStore, Migration, MigrationRunner, SnapshotStore } from "./types.js";

export interface SchemaMigratorOptions {
  enableHybrid: boolean;
  providerKey?: string;
  /**
   * Physical payload keys the FULL trajectory registry declares — every
   * trajectory this build can register, not only the ones this process did.
   * Built by the api composition root (`createIngestDependencies`).
   *
   * v16 exists only when this set is non-empty: absent keys mean nothing to
   * judge an index against, so the collection stays below 16 and the next run
   * that has them performs the drop. Production always supplies it, so there
   * the latest schema version is 16; a construction without it reports 15.
   */
  declaredPayloadKeys?: ReadonlySet<string>;
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
      new SchemaV13RenameOwnershipPayload(
        collection,
        indexStore as IndexStore &
          Required<Pick<IndexStore, "scrollAllPayload" | "batchSetPayload" | "deletePayloadKeys">>,
      ),
      new SchemaV14EnrichmentScanIndexes(collection, indexStore),
      new SchemaV15CodegraphFilterIndexes(collection, indexStore),
      ...(options.declaredPayloadKeys && options.declaredPayloadKeys.size > 0
        ? [
            new SchemaV16DropUndeclaredPayloadIndexes(
              collection,
              indexStore as IndexStore & Required<Pick<IndexStore, "listPayloadIndexes" | "dropPayloadIndex">>,
              options.declaredPayloadKeys,
            ),
          ]
        : []),
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
