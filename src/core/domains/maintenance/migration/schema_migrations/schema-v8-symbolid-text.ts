import type { Migration, StepResult, IndexStore } from "../types.js";

export class SchemaV8SymbolIdText implements Migration {
  readonly name = "schema-v8-symbolid-text";
  readonly version = 8;

  constructor(
    private readonly collection: string,
    private readonly store: IndexStore,
  ) {}

  async apply(): Promise<StepResult> {
    await this.store.ensureIndex(this.collection, "symbolId", "text");
    return { applied: ["symbolId:text"] };
  }
}
