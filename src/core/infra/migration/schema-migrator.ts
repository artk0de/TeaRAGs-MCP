import type { Migration, MigrationRunner, IndexStore, SparseStore } from "./types.js";
import { SchemaV4RelativePathKeyword } from "./schema_migrations/schema-v4-relativepath-keyword.js";
import { SchemaV5RelativePathText } from "./schema_migrations/schema-v5-relativepath-text.js";
import { SchemaV6FilterFieldIndexes } from "./schema_migrations/schema-v6-filter-field-indexes.js";
import { SchemaV7SparseConfig } from "./schema_migrations/schema-v7-sparse-config.js";
import { SchemaV8SymbolIdText } from "./schema_migrations/schema-v8-symbolid-text.js";
import { SparseVectorRebuild } from "./schema_migrations/sparse-vector-rebuild.js";

export interface SchemaMigratorOptions {
  enableHybrid: boolean;
}

export class SchemaMigrator implements MigrationRunner {
  private readonly migrations: Migration[];
  private appliedIndexes: string[] = [];

  constructor(
    private readonly collection: string,
    private readonly indexStore: IndexStore,
    private readonly sparseStore: SparseStore,
    private readonly options: SchemaMigratorOptions,
  ) {
    this.migrations = [
      new SchemaV4RelativePathKeyword(collection, indexStore),
      new SchemaV5RelativePathText(collection, indexStore),
      new SchemaV6FilterFieldIndexes(collection, indexStore),
      new SchemaV7SparseConfig(collection, indexStore, options.enableHybrid),
      new SchemaV8SymbolIdText(collection, indexStore),
      new SparseVectorRebuild(collection, sparseStore, options.enableHybrid),
    ];
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
