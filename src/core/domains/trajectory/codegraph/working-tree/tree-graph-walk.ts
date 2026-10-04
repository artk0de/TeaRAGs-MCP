/**
 * The incremental steps a tree build runs over its opened clone (epic xi2r9,
 * WTO-7) — deletions first, then the walk, then the self-contained finish —
 * shared by the build from the base snapshot and the build seeded from the
 * tree's previous graph (`tree-graph-seed-apply.ts`). Why each step is ordered
 * as it is: `buildWorkingTreeGraph`'s docblock.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { GraphDbClient } from "../../../../contracts/types/codegraph-storage.js";
import type { PhysicalCollectionName } from "../../../../contracts/types/collection-identity.js";
import { readFileContentHash, readFileContentHashSync } from "../../../../infra/file-content-hash.js";
import { WorkingTreeGraphIncompleteError } from "../../errors.js";
import type { CodegraphEnrichmentProvider } from "../symbols/provider.js";

/** One opened clone a tree build writes: the provider over it and its client. */
export interface TreeGraphClone {
  treeRoot: string;
  physical: PhysicalCollectionName;
  provider: CodegraphEnrichmentProvider;
  graphDb: GraphDbClient;
  dbPath: string;
}

/** What one delta application walked. */
export interface TreeDeltaWalk {
  walkedFileCount: number;
  hierarchyDependentCount: number;
}

/** Walked files hashed at once: one descriptor each, well inside any default fd limit. */
const CONTENT_HASH_READ_CONCURRENCY = 64;

/**
 * Steps 2–3 of `buildWorkingTreeGraph`: delete, then walk `changed` plus
 * `alsoWalk` plus the unchanged files the deletion NULLed (hierarchy
 * dependents). Returns the walked paths and how many were dependents; with
 * nothing to walk, the derived tables go through `finalizeSignals`.
 */
export async function deleteThenWalk(
  clone: TreeGraphClone,
  changed: readonly string[],
  deleted: readonly string[],
  alsoWalk: readonly string[] = [],
): Promise<{ walked: string[]; hierarchyDependentCount: number }> {
  const nulledBefore = await pathsWithoutContentHash(clone.graphDb);
  await clone.provider.handleDeletedPaths([...deleted], { collectionName: clone.physical });
  const delta = new Set([...changed, ...deleted, ...alsoWalk]);
  const dependents = [...(await pathsWithoutContentHash(clone.graphDb))].filter(
    (relPath) => !nulledBefore.has(relPath) && !delta.has(relPath) && existsSync(join(clone.treeRoot, relPath)),
  );
  const walked = [...new Set([...changed, ...alsoWalk, ...dependents])];
  if (walked.length > 0) await walkTreeFiles(clone, walked);
  else await clone.provider.finalizeSignals(clone.treeRoot, { collectionName: clone.physical });
  return { walked, hierarchyDependentCount: dependents.length };
}

/** One incremental walk of `relPaths`, each stamped with its content hash ({@link contentHashesOf}). */
export async function walkTreeFiles(clone: TreeGraphClone, relPaths: readonly string[]): Promise<void> {
  await clone.provider.buildFileSignals(clone.treeRoot, {
    paths: [...relPaths],
    collectionName: clone.physical,
    contentHashes: await contentHashesOf(clone.treeRoot, relPaths),
  });
}

/**
 * Steps 4–5: refuse stale derived tables, then CHECKPOINT so the file carries
 * every write (closing never checkpoints).
 *
 * @throws WorkingTreeGraphIncompleteError when the derived tables are still stale.
 */
export async function finishTreeGraph(clone: TreeGraphClone): Promise<void> {
  if (await clone.graphDb.hasStaleDerivedTables()) {
    throw new WorkingTreeGraphIncompleteError(clone.dbPath, "staleDerivedTables");
  }
  await clone.graphDb.checkpoint();
}

/**
 * The content hash of every file a run writes, stamped onto its row as an
 * ingest run stamps it. A tree graph SEEDS the tree's next build, and that
 * build reads these hashes: a NULL is the drift marker step 2 tells a
 * deletion's hierarchy dependents by, so a file written unstamped would read as
 * "already NULL" and never be re-resolved there.
 *
 * The run writes more files than it is handed — the hierarchy barrier
 * re-resolves unchanged files whose cone moved — and an ingest run stamps
 * those too, from its whole-project scan. So the walked files are hashed up
 * front (concurrently) and any other file on first lookup; the run reads the
 * map through `get` alone. A file that cannot be read stays unstamped.
 */
async function contentHashesOf(treeRoot: string, relPaths: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const hashes = new TreeContentHashes(treeRoot);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < relPaths.length) {
      const relPath = relPaths[next++];
      const hash = await readFileContentHash(join(treeRoot, relPath));
      if (hash !== undefined) hashes.set(relPath, hash);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONTENT_HASH_READ_CONCURRENCY, relPaths.length) }, worker));
  return hashes;
}

/** A content-hash map that hashes a tree file on its first lookup. */
class TreeContentHashes extends Map<string, string> {
  private readonly unreadable = new Set<string>();

  constructor(private readonly treeRoot: string) {
    super();
  }

  override get(relPath: string): string | undefined {
    const known = super.get(relPath);
    if (known !== undefined || this.unreadable.has(relPath)) return known;
    const hash = readFileContentHashSync(join(this.treeRoot, relPath));
    if (hash === undefined) this.unreadable.add(relPath);
    else this.set(relPath, hash);
    return hash;
  }
}

/** Files the graph knows whose content hash is NULL — the drift marker the repair pass re-walks. */
async function pathsWithoutContentHash(graphDb: GraphDbClient): Promise<Set<string>> {
  const rows = await graphDb.listFileContentHashes();
  return new Set(rows.filter((row) => row.contentHash === null).map((row) => row.relPath));
}
