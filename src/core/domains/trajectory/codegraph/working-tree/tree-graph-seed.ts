/**
 * Seeding a working-tree graph build from the tree's PREVIOUS graph (epic
 * xi2r9). A published tree graph is a self-contained graph of tree state S1 —
 * the base graph with S1's delta applied by the production incremental
 * sequence. Building S2 by applying the S1→S2 diff to a clone of it, through
 * the same sequence, is the incremental-reindex chain property: the cost scales
 * with the edit, not with the size of the tree's whole delta.
 *
 * A graph can seed only when its delta is recorded with it: which paths it
 * walked at which content, which it deleted. Every path outside that record
 * holds the BASE's rows.
 */
import type { WorkingTreeGraphSeed } from "./tree-graph-seed-apply.js";

/** A tree's delta against the base, as a seed records it and as a request states it. */
export interface WorkingTreeDeltaRecord {
  /** Paths the tree adds or modifies → the content hash (`fileContentHash`) of the bytes walked. */
  changed: Readonly<Record<string, string>>;
  /** Paths the base holds and the tree does not. */
  deleted: readonly string[];
}

/** What a build seeded from S1 applies to reach S2: walk these, delete those. Both sorted. */
export interface WorkingTreeSeedDelta {
  changedRelPaths: string[];
  deletedRelPaths: string[];
}

/**
 * The delta from the seed's tree state (`seed`) to the current one (`current`).
 *
 * - A path the current tree changes is walked unless the seed walked it at the
 *   same content — a path the seed deleted and the tree now holds included.
 * - A path the seed changed and the current delta does not name is either back
 *   at base content (on disk: walked, which restores base-equivalent rows) or a
 *   seed-ADDED file that is gone (absent: deleted — the base never had it, so
 *   no deletion names it).
 * - A path the seed deleted and the current delta does not name is back at base
 *   content: walked.
 * - A path the current tree deletes is deleted unless the seed deleted it too.
 *
 * `existsInTree` is asked only for the paths the current delta does not name.
 */
export async function treeDeltaAgainstSeed(
  seed: WorkingTreeDeltaRecord,
  current: WorkingTreeDeltaRecord,
  existsInTree: (relPath: string) => Promise<boolean>,
): Promise<WorkingTreeSeedDelta> {
  const seedDeleted = new Set(seed.deleted);
  const currentDeleted = new Set(current.deleted);
  const inCurrentDelta = (relPath: string): boolean =>
    Object.hasOwn(current.changed, relPath) || currentDeleted.has(relPath);

  const changed = new Set<string>();
  const deleted = new Set<string>();
  for (const [relPath, hash] of Object.entries(current.changed)) {
    if (!Object.hasOwn(seed.changed, relPath) || seed.changed[relPath] !== hash) changed.add(relPath);
  }
  for (const relPath of currentDeleted) {
    if (!seedDeleted.has(relPath)) deleted.add(relPath);
  }
  for (const relPath of Object.keys(seed.changed)) {
    if (inCurrentDelta(relPath)) continue;
    ((await existsInTree(relPath)) ? changed : deleted).add(relPath);
  }
  for (const relPath of seedDeleted) {
    if (inCurrentDelta(relPath)) continue;
    if (await existsInTree(relPath)) changed.add(relPath);
  }
  return { changedRelPaths: [...changed].sort(), deletedRelPaths: [...deleted].sort() };
}

/**
 * The build input's `seed` for building `current` from the published graph at
 * `dbPath` whose tree state `seed` records — `treeDeltaAgainstSeed` plus what
 * the seeded application needs to know about both deltas.
 */
export async function treeGraphSeedOf(
  dbPath: string,
  seed: WorkingTreeDeltaRecord,
  current: WorkingTreeDeltaRecord,
  existsInTree: (relPath: string) => Promise<boolean>,
): Promise<WorkingTreeGraphSeed> {
  const diff = await treeDeltaAgainstSeed(seed, current, existsInTree);
  const walked = new Set(diff.changedRelPaths);
  return {
    dbPath,
    changedRelPaths: diff.changedRelPaths,
    deletedRelPaths: diff.deletedRelPaths,
    restoredRelPaths: diff.changedRelPaths.filter((relPath) => !Object.hasOwn(current.changed, relPath)),
    heldRelPaths: Object.keys(current.changed)
      .filter((relPath) => !walked.has(relPath))
      .sort(),
    seedChangedRelPaths: Object.keys(seed.changed).sort(),
    seedDeletedRelPaths: [...seed.deleted].sort(),
  };
}
