import type { Migration, StepResult, IndexStore } from "../types.js";

export class SchemaV5RelativePathText implements Migration {
  readonly name = "schema-v5-relativepath-text";
  readonly version = 5;

  constructor(
    private readonly collection: string,
    private readonly store: IndexStore,
  ) {}

  async apply(): Promise<StepResult> {
    await this.store.ensureIndex(this.collection, "relativePath", "text");
    return { applied: ["relativePath:text"] };
  }
}
