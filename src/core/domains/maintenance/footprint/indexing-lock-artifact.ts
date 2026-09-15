import type { IndexingLockArtifactStoreFactory } from "../../../contracts/index.js";
import { IndexingLockHeldError } from "../errors.js";
import type { CollectionArtifact, FootprintContext } from "./artifact.js";

/**
 * The collection's `<logical>.indexing.lock` (bd tea-rags-mcp-39xca.13) — logical,
 * like the claim that writes it, because one lock covers every generation a run
 * builds.
 *
 * A lock belongs to the process running an index operation, so it is never
 * cloned: a fresh clone is not being indexed. Removal deletes a dead run's lock
 * and REFUSES a live one with `IndexingLockHeldError` — the purge records that as
 * a failure, the worktree teardown skips it — so no teardown deletes a lock a
 * running operation still owns.
 */
export class IndexingLockArtifact implements CollectionArtifact {
  readonly id = "indexing-lock" as const;
  readonly addressing = "logical" as const;
  constructor(
    private readonly lockDir: string,
    private readonly makeStore: IndexingLockArtifactStoreFactory,
  ) {}

  async clone(): Promise<void> {
    // Nothing to copy — see the class docblock.
  }

  async remove(ctx: FootprintContext): Promise<void> {
    const outcome = await this.makeStore(this.lockDir, ctx.target.logicalName).removeIfStale();
    if (outcome.status === "held-live") throw new IndexingLockHeldError(ctx.target.logicalName, outcome.holder);
  }
}
