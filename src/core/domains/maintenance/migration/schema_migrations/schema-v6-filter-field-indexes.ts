import type { Migration, StepResult, IndexStore } from "../types.js";

export class SchemaV6FilterFieldIndexes implements Migration {
  readonly name = "schema-v6-filter-field-indexes";
  readonly version = 6;

  constructor(
    private readonly collection: string,
    private readonly store: IndexStore,
  ) {}

  async apply(): Promise<StepResult> {
    await this.store.ensureIndex(this.collection, "language", "keyword");
    await this.store.ensureIndex(this.collection, "fileExtension", "keyword");
    await this.store.ensureIndex(this.collection, "chunkType", "keyword");
    return { applied: ["language:keyword", "fileExtension:keyword", "chunkType:keyword"] };
  }
}
