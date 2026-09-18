import type { CollectionArtifact, ResolvedCollection } from "./artifact.js";
import type { CollectionFootprintFactory } from "./factory.js";

/**
 * Clone a collection's whole footprint onto `target`, or leave nothing behind.
 *
 * The one copy path for a collection: the explicit worktree clone
 * (`WorktreeProvisioner#create`) and the automatic sibling-worktree seed of a
 * first index both run it, so a new artifact added to the factory reaches both.
 *
 * Every artifact is pushed onto the rollback list BEFORE its clone runs, so the
 * artifact that throws takes part in its own rollback; the rollback walks the
 * list in reverse and swallows each teardown's failure, because one dead step
 * must not abandon the rest (the `CollectionArtifact.remove` contract). The
 * clone's own error is what the caller receives.
 */
export async function cloneCollectionFootprint(
  factory: Pick<CollectionFootprintFactory, "build">,
  source: ResolvedCollection,
  target: ResolvedCollection,
): Promise<void> {
  const { context, artifacts } = factory.build(source, target);
  const done: CollectionArtifact[] = [];
  try {
    for (const artifact of artifacts) {
      done.push(artifact);
      await artifact.clone(context);
    }
  } catch (error) {
    for (const artifact of [...done].reverse()) await artifact.remove(context).catch(() => undefined);
    throw error;
  }
}
