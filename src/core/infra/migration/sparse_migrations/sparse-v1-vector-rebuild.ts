import type { Migration, SparseStore, StepResult } from "../types.js";

export const CURRENT_SPARSE_VERSION = 1;

export class SparseVectorRebuild implements Migration {
  readonly name = "sparse-vector-rebuild";
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

    const current = await this.store.getSparseVersion(this.collection);
    if (current >= CURRENT_SPARSE_VERSION) {
      return { applied: ["sparse-rebuild: skipped (already at current version)"] };
    }

    await this.store.rebuildSparseVectors(this.collection);
    await this.store.storeSparseVersion(this.collection, CURRENT_SPARSE_VERSION);
    return { applied: [`sparse-rebuild: rebuilt to v${CURRENT_SPARSE_VERSION}`] };
  }
}
