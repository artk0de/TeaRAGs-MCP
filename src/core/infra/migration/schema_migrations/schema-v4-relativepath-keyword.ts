import type { Migration, StepResult, IndexStore } from "../types.js";

export class SchemaV4RelativePathKeyword implements Migration {
  readonly name = "schema-v4-relativepath-keyword";
  readonly version = 4;

  constructor(
    private readonly collection: string,
    private readonly store: IndexStore,
  ) {}

  async apply(): Promise<StepResult> {
    await this.store.ensureIndex(this.collection, "relativePath", "keyword");
    return { applied: ["relativePath:keyword"] };
  }
}
