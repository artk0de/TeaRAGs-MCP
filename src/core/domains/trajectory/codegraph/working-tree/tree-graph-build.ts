/**
 * The working-tree graph build (epic xi2r9, WTO-7): the PRODUCTION incremental
 * codegraph run over the working-tree delta, pointed at a private clone of the
 * base graph. No resolution code lives here — the walker, the resolver chain
 * (ts.Program strategies included), hierarchy-dependent re-resolution, PageRank
 * and cycles are the provider's, exactly as `reindex_changes` runs them. What
 * this module owns is the SEQUENCE an incremental reindex imposes on those
 * entry points, and turning the result into one self-contained file.
 *
 * Runs in a child process (`tree-graph-entry.ts`, spawned by
 * `WorkingTreeGraphProcessBuilder`): a whole-project ts.Program and DuckDB's
 * native allocations are bounded by killing the process, not by hoping a
 * long-lived server gives the memory back.
 */
import { constants, existsSync, statSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { GraphDbClient } from "../../../../contracts/types/codegraph-storage.js";
import type { PhysicalCollectionName } from "../../../../contracts/types/collection-identity.js";
import { WorkingTreeGraphIncompleteError } from "../../errors.js";
import { createCodegraphProviderRuntime, type CodegraphWorkerConfig } from "../factory.js";
import type { CodegraphEnrichmentProvider } from "../symbols/provider.js";

/**
 * The plain-data slice of `CodegraphWorkerConfig` a tree build reuses. No
 * `daemonSocketPath`: the clone is private to the build, so the provider runs in
 * direct mode and holds the only client. No `rootDir` / `collectionName`: those
 * are the build's own staging layout. No `temporal`: co-change history describes
 * commits, which a working tree adds none of.
 */
export type WorkingTreeGraphProviderConfig = Pick<
  CodegraphWorkerConfig,
  | "languageModulePath"
  | "migrationsModulePath"
  | "customExcludePatterns"
  | "ambiguousResolveMode"
  | "dbMemoryLimit"
  | "dbThreads"
>;

/** Everything one tree build reads. Plain data — it crosses the child-process IPC boundary as is. */
export interface WorkingTreeGraphBuildInput {
  /**
   * A self-contained base graph: one DuckDB file with no WAL beside it
   * (`GraphDbClient#exportSnapshot`). Read, cloned, never opened — a WAL here
   * would hold writes the clone silently lacks, so its presence is refused.
   */
  snapshotPath: string;
  /** A staging directory the caller owns; the graph lands at `<outputRoot>/codegraph/<physical>.duckdb`. */
  outputRoot: string;
  /** The physical collection the base graph belongs to — the clone keeps its name. */
  physicalCollectionName: PhysicalCollectionName;
  /** The working tree's root: every changed path is read from here. */
  treeRoot: string;
  /** Files the tree adds or modifies against the base, relative to `treeRoot`. */
  changedRelPaths: readonly string[];
  /** Files the base holds and the tree does not (a rename's old path included). */
  deletedRelPaths: readonly string[];
  providerConfig: WorkingTreeGraphProviderConfig;
}

/** A finished tree build: where its graph is and what it took to make. */
export interface WorkingTreeGraphBuilt {
  /** The self-contained output graph (CHECKPOINTed, every client closed, no WAL). */
  dbPath: string;
  durationMs: number;
  /** Files walked: the changed paths plus the hierarchy dependents of the deletions. */
  walkedFileCount: number;
  deletedFileCount: number;
  /** UNCHANGED files re-walked because a deleted file held a type their call cones read. */
  hierarchyDependentCount: number;
}

/**
 * Build the working tree's graph into `<outputRoot>/codegraph/<physical>.duckdb`.
 *
 * The order is the incremental reindex's, and each step is load-bearing:
 *
 * 1. **Clone** the snapshot with `COPYFILE_EXCL | COPYFILE_FICLONE` — a fresh
 *    inode (the pool's dev/ino check and the rename-only guard both rely on a
 *    database never being copied OVER a path), copy-on-write on APFS.
 * 2. **Deletions first** (`handleDeletedPaths`, as `EnrichmentCoordinator#notifyDeletions`
 *    precedes the walk): it removes the files' rows AND their in-memory
 *    symbol-table entries, so a changed file still importing a deleted one
 *    cannot resolve into it; it prunes cycles / ranks touching them and marks
 *    the derived tables stale; and it NULLs the content hash of every unchanged
 *    caller whose CHA cone held a type the deleted files declared.
 * 3. **Walk** the changed paths plus those newly-NULLed callers — the files
 *    `EnrichmentCoordinator#runRepairPass` would see drift on and re-walk in the
 *    same run. A NULL that predates the deletion is not this delta's and is left.
 * 4. **Derived tables**: a walk's `sink.finish()` recomputes cycles and PageRank
 *    over the whole graph (no language partition here). A deletion-only delta
 *    with nothing to re-walk goes through `finalizeSignals` with no run sink —
 *    the `runFinalizeOnly` seam — which recomputes exactly when a deletion left
 *    them stale. Still stale afterwards means the best-effort recompute failed,
 *    and the graph is refused rather than published with dead ranks.
 * 5. **Self-contained**: CHECKPOINT through the client, then close every client.
 *    Closing never checkpoints by design (`PRAGMA disable_checkpoint_on_shutdown`
 *    in `DuckDbGraphSession#close`), so without the explicit one the build's
 *    writes would sit in a WAL the publisher does not carry.
 *
 * @throws Error (programming error) for an empty delta — the caller never builds
 *   one — or a snapshot with a non-empty WAL beside it.
 * @throws WorkingTreeGraphIncompleteError when the output still has stale derived
 *   tables or a non-empty WAL.
 */
export async function buildWorkingTreeGraph(input: WorkingTreeGraphBuildInput): Promise<WorkingTreeGraphBuilt> {
  if (input.changedRelPaths.length === 0 && input.deletedRelPaths.length === 0) {
    throw new Error("buildWorkingTreeGraph: empty delta — a clean working tree reads the base graph");
  }
  if (hasNonEmptyWal(input.snapshotPath)) {
    throw new Error(`buildWorkingTreeGraph: snapshot ${input.snapshotPath} is not self-contained (WAL beside it)`);
  }
  const startedAtMs = Date.now();
  const physical = input.physicalCollectionName;
  const { provider, pool } = await createCodegraphProviderRuntime({
    ...input.providerConfig,
    rootDir: input.outputRoot,
    collectionName: physical,
  });
  const dbPath = pool.pathFor(physical);
  let walked: TreeDeltaWalk;
  try {
    await mkdir(dirname(dbPath), { recursive: true });
    await copyFile(input.snapshotPath, dbPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    walked = await applyTreeDelta(input, provider, (await pool.acquire(physical)).graphDb, dbPath);
  } finally {
    await pool.closeAll();
  }
  if (hasNonEmptyWal(dbPath)) throw new WorkingTreeGraphIncompleteError(dbPath, "walLeftBehind");
  return {
    dbPath,
    durationMs: Date.now() - startedAtMs,
    walkedFileCount: walked.walkedFileCount,
    deletedFileCount: input.deletedRelPaths.length,
    hierarchyDependentCount: walked.hierarchyDependentCount,
  };
}

interface TreeDeltaWalk {
  walkedFileCount: number;
  hierarchyDependentCount: number;
}

/** Steps 2–5 of {@link buildWorkingTreeGraph} over the opened clone; the caller closes the pool. */
async function applyTreeDelta(
  input: WorkingTreeGraphBuildInput,
  provider: CodegraphEnrichmentProvider,
  graphDb: GraphDbClient,
  dbPath: string,
): Promise<TreeDeltaWalk> {
  const physical = input.physicalCollectionName;
  const nulledBefore = await pathsWithoutContentHash(graphDb);
  await provider.handleDeletedPaths([...input.deletedRelPaths], { collectionName: physical });
  const delta = new Set([...input.changedRelPaths, ...input.deletedRelPaths]);
  const dependents = [...(await pathsWithoutContentHash(graphDb))].filter(
    (relPath) => !nulledBefore.has(relPath) && !delta.has(relPath) && existsSync(join(input.treeRoot, relPath)),
  );

  const walk = [...input.changedRelPaths, ...dependents];
  if (walk.length > 0) {
    await provider.buildFileSignals(input.treeRoot, { paths: walk, collectionName: physical });
  } else {
    await provider.finalizeSignals(input.treeRoot, { collectionName: physical });
  }
  if (await graphDb.hasStaleDerivedTables()) {
    throw new WorkingTreeGraphIncompleteError(dbPath, "staleDerivedTables");
  }
  await graphDb.checkpoint();
  return { walkedFileCount: walk.length, hierarchyDependentCount: dependents.length };
}

/** Files the graph knows whose content hash is NULL — the drift marker the repair pass re-walks. */
async function pathsWithoutContentHash(graphDb: GraphDbClient): Promise<Set<string>> {
  const rows = await graphDb.listFileContentHashes();
  return new Set(rows.filter((row) => row.contentHash === null).map((row) => row.relPath));
}

function hasNonEmptyWal(dbPath: string): boolean {
  const wal = `${dbPath}.wal`;
  return existsSync(wal) && statSync(wal).size > 0;
}
