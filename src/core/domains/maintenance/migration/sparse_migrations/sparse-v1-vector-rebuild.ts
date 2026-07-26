import type { Migration, SparseStore, StepResult } from "../types.js";

export class SparseV1VectorRebuild implements Migration {
  readonly name = "sparse-v1-vector-rebuild";
  readonly version = 1;

  constructor(
    private readonly collection: string,
    private readonly store: SparseStore,
    private readonly enableHybrid: boolean,
  ) {}

  async apply(): Promise<StepResult> {
    if (!this.enableHybrid) {
      return { applied: ["sparse-rebuild: skipped (hybrid disabled)"] };
    }

    await this.store.rebuildSparseVectors(this.collection);
    return { applied: ["sparse-rebuild: rebuilt BM25 vectors"] };
  }
}
