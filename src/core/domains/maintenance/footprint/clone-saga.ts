import type { CollectionArtifact, FootprintContext, ResolvedCollection } from "./artifact.js";

/**
 * The saga reads only the factory's artifact set — the consumer-side structural
 * view (bd tea-rags-mcp-54xwd.2). `CollectionFootprintFactory` satisfies it;
 * naming the factory class here would close an import cycle back into it.
 */
interface FootprintBuilder {
  build: (
    source: ResolvedCollection,
    target: ResolvedCollection,
  ) => { context: FootprintContext; artifacts: CollectionArtifact[] };
}

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
 *
 * `targetIndexingMarkerPatch` reaches every artifact's context; the Qdrant
 * clone writes it before the target becomes addressable (see
 * `FootprintContext.targetIndexingMarkerPatch`). It adds no compensation of its
 * own: it lives on the collection the Qdrant artifact's rollback removes.
 */
export async function cloneCollectionFootprint(
  factory: FootprintBuilder,
  source: ResolvedCollection,
  target: ResolvedCollection,
  targetIndexingMarkerPatch?: Readonly<Record<string, unknown>>,
): Promise<void> {
  const built = factory.build(source, target);
  const context: FootprintContext = targetIndexingMarkerPatch
    ? { ...built.context, targetIndexingMarkerPatch }
    : built.context;
  const done: CollectionArtifact[] = [];
  try {
    for (const artifact of built.artifacts) {
      done.push(artifact);
      await artifact.clone(context);
    }
  } catch (error) {
    for (const artifact of [...done].reverse()) await artifact.remove(context).catch(() => undefined);
    throw error;
  }
}

/**
 * Tear the TARGET footprint down — the remove half of the saga, walked in
 * reverse clone order with every per-artifact failure swallowed (the
 * `CollectionArtifact.remove` contract). `WorktreeProvisioner#remove` runs this
 * through the port; the rollback inside {@link cloneCollectionFootprint} is the
 * same walk over the artifacts it managed to start.
 */
export async function removeCollectionFootprint(
  factory: FootprintBuilder,
  source: ResolvedCollection,
  target: ResolvedCollection,
): Promise<void> {
  const { context, artifacts } = factory.build(source, target);
  for (const artifact of [...artifacts].reverse()) await artifact.remove(context).catch(() => undefined);
}
