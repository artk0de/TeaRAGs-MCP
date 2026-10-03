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
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";

import type { PhysicalCollectionName } from "../../../../contracts/types/collection-identity.js";
import { WorkingTreeGraphIncompleteError } from "../../errors.js";
import { createCodegraphProviderRuntime, type CodegraphWorkerConfig } from "../factory.js";
import { applySeedDelta, type TreeGraphSeedRejection, type WorkingTreeGraphSeed } from "./tree-graph-seed-apply.js";
import { deleteThenWalk, finishTreeGraph, type TreeDeltaWalk, type TreeGraphClone } from "./tree-graph-walk.js";

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
  /**
   * The tree's previously published graph and the diff from it to this tree.
   * Present, the build applies the diff to a clone of it
   * ({@link applySeedDelta}); a seeded application that cannot equal the base
   * build is rejected and the build runs from `snapshotPath` over the whole
   * delta, as without a seed.
   */
  seed?: WorkingTreeGraphSeed;
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
  /** The graph was built from the input's seed (absent: no seed was given). */
  seeded?: boolean;
  /** Why the seed was not used, when one was given and the build ran from the base. */
  seedRejection?: string;
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
 * With a `seed`, steps 1–5 run first over a clone of the tree's previous graph
 * with the seed's diff ({@link applySeedDelta} owns what it adds to the diff and
 * what it rejects). A rejected or failed seeded attempt is discarded and the
 * build runs from the base snapshot over the whole delta; `seeded` /
 * `seedRejection` say which happened.
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
  for (const snapshotPath of [input.snapshotPath, ...(input.seed ? [input.seed.dbPath] : [])]) {
    if (hasNonEmptyWal(snapshotPath)) {
      throw new Error(`buildWorkingTreeGraph: snapshot ${snapshotPath} is not self-contained (WAL beside it)`);
    }
  }
  const startedAtMs = Date.now();
  const built = (dbPath: string, walked: TreeDeltaWalk, deletedFileCount: number): WorkingTreeGraphBuilt => ({
    dbPath,
    durationMs: Date.now() - startedAtMs,
    walkedFileCount: walked.walkedFileCount,
    deletedFileCount,
    hierarchyDependentCount: walked.hierarchyDependentCount,
  });

  let seedRejection: string | undefined;
  if (input.seed) {
    const { seed } = input;
    try {
      const attempt = await buildOnClone(
        input,
        seed.dbPath,
        async (clone) => applySeedDelta(clone, seed, input.snapshotPath),
        (result) => !isRejection(result),
      );
      if (!isRejection(attempt.result)) {
        return { ...built(attempt.dbPath, attempt.result, seed.deletedRelPaths.length), seeded: true };
      }
      seedRejection = attempt.result.rejected;
    } catch (err) {
      // A seed that cannot be applied (it vanished, its clone failed, its
      // derived tables stayed stale) is no reason to fail the build: the base
      // path below does not depend on it, and `buildOnClone` removed the clone.
      seedRejection = `seeded build failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const attempt = await buildOnClone(input, input.snapshotPath, async (clone) => {
    const { walked, hierarchyDependentCount } = await deleteThenWalk(
      clone,
      input.changedRelPaths,
      input.deletedRelPaths,
    );
    await finishTreeGraph(clone);
    return { walkedFileCount: walked.length, hierarchyDependentCount };
  });
  return {
    ...built(attempt.dbPath, attempt.result, input.deletedRelPaths.length),
    ...(input.seed ? { seeded: false, seedRejection } : {}),
  };
}

/**
 * Clone `snapshotPath` into the build's output and run `apply` over it with a
 * fresh direct-mode provider (step 1, then the caller's steps 2–5); every
 * client is closed afterwards, and a WAL left behind is refused. A result
 * `keep` declines is discarded with its clone, WAL and all.
 */
async function buildOnClone<T>(
  input: WorkingTreeGraphBuildInput,
  snapshotPath: string,
  apply: (clone: TreeGraphClone) => Promise<T>,
  keep: (result: T) => boolean = () => true,
): Promise<{ dbPath: string; result: T }> {
  const physical = input.physicalCollectionName;
  const { provider, pool } = await createCodegraphProviderRuntime({
    ...input.providerConfig,
    rootDir: input.outputRoot,
    collectionName: physical,
  });
  const dbPath = pool.pathFor(physical);
  let result: T;
  try {
    try {
      await mkdir(dirname(dbPath), { recursive: true });
      await copyFile(snapshotPath, dbPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      const { graphDb } = await pool.acquire(physical);
      result = await apply({ treeRoot: input.treeRoot, physical, provider, graphDb, dbPath });
    } finally {
      await pool.closeAll();
    }
    if (!keep(result)) {
      await removeGraphFile(dbPath);
      return { dbPath, result };
    }
    if (hasNonEmptyWal(dbPath)) throw new WorkingTreeGraphIncompleteError(dbPath, "walLeftBehind");
  } catch (err) {
    // The output path takes exactly one clone (COPYFILE_EXCL): a failed attempt
    // leaves it free for the next.
    await removeGraphFile(dbPath);
    throw err;
  }
  return { dbPath, result };
}

async function removeGraphFile(dbPath: string): Promise<void> {
  await rm(dbPath, { force: true });
  await rm(`${dbPath}.wal`, { force: true });
}

function isRejection(result: TreeDeltaWalk | TreeGraphSeedRejection): result is TreeGraphSeedRejection {
  return "rejected" in result;
}

function hasNonEmptyWal(dbPath: string): boolean {
  const wal = `${dbPath}.wal`;
  return existsSync(wal) && statSync(wal).size > 0;
}
