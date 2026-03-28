import type { Migration, StepResult, IndexStore } from "../types.js";

export class SchemaV7SparseConfig implements Migration {
  readonly name = "schema-v7-sparse-config";
  readonly version = 7;

  constructor(
    private readonly collection: string,
    private readonly store: IndexStore,
    private readonly enableHybrid: boolean,
  ) {}

  async apply(): Promise<StepResult> {
    if (!this.enableHybrid) {
      return { applied: ["sparse-config: skipped (hybrid disabled)"] };
    }

    const info = await this.store.getCollectionInfo(this.collection);
    if (info.hybridEnabled) {
      return { applied: ["sparse-config: skipped (already enabled)"] };
    }

    await this.store.updateSparseConfig(this.collection);
    return { applied: ["sparse-config: enabled"] };
  }
}
