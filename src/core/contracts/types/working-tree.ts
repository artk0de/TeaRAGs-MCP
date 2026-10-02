/**
 * Working-tree vocabulary (bd tea-rags-mcp-xi2r9) shared by the resolver that
 * picks the tree (`api/internal/collection-resolver.ts`), the explore overlay
 * that measures it (`domains/explore/working-tree/`), and the DTOs that carry
 * the answer (`api/public/dto/working-tree.ts`). It lives in contracts because
 * the explore domain may not import the api layer that names the request.
 */

import type { PhysicalCollectionName } from "./collection-identity.js";

/**
 * Most files a working-tree delta may name before the overlay stops measuring
 * it. Shared with the ingest stamp writer, which records the files dirty at
 * index time only up to this cap (`RegistryGitState#indexedDirtyPaths`): the
 * overlay folds them into the delta, so a longer list could never be used.
 */
export const WORKING_TREE_DELTA_FILE_CAP = 200;

/** The tree a request reads, and the index it reads that tree against. */
export interface WorkingTree {
  /**
   * realpath of the tree's counterpart of the index root: the git toplevel the
   * caller stands in, joined with the index root's path below ITS toplevel — so
   * an index registered at `<repo>/sub` reads `<tree>/sub` (live P2-2). Paths
   * the overlay names are relative to it, like the index's own.
   */
  root: string;
  /** lower layer the tree is read against */
  baseIndex: { collectionName: string; root: string | undefined };
}

/**
 * A read path on which the tree's own data replaced the base's: delta chunks
 * for the base chunks of delta files (`chunks`, `sparse`), or the tree graph
 * for the base graph (`codegraph`, WTO-7).
 */
export type WorkingTreeFloor = "chunks" | "sparse" | "codegraph";

/**
 * Which tree an answer read and how far it is from the index. Attached to every
 * read answer as `workingTree`. `changedFiles: 0` means the delta was measured
 * and is empty; anything that could not be measured carries `degraded`.
 */
export interface WorkingTreeMarker {
  tree: string;
  indexedCommit: string | null;
  treeCommit: string | null;
  indexedDirty: boolean;
  changedFiles: number;
  deletedFiles: number;
  floors: WorkingTreeFloor[];
  degraded?: { reason: string; remedy: string };
  /**
   * Changed files the chunker could not read or parse: they contribute no delta
   * rows. Set once the delta chunks were read; one bad file never degrades the
   * whole answer.
   */
  unparsed?: string[];
}

/** How a base row of a delta file differs from the tree, where no floor replaced it. */
export type WorkingTreeState = "modified" | "deleted";

/**
 * One request for the working tree's codegraph (WTO-7): the delta the overlay
 * measured and the fingerprint naming it. Same tree + fingerprint + base graph
 * = one build, shared by every caller.
 */
export interface WorkingTreeGraphRequest {
  tree: WorkingTree;
  /** Files the tree adds or modifies against the base, relative to `tree.root`. */
  changed: readonly string[];
  /** Files the base holds and the tree does not (a rename's old path included). */
  deleted: readonly string[];
  fingerprint: string;
}

/**
 * The tree graph, or why the reader serves the base graph instead. Every
 * variant but `built` is a product answer — the reader degrades and names the
 * reason — never an error: still building when the wait lapsed, a failed /
 * timed-out / heap-exhausted child, no base graph, codegraph off.
 */
export type WorkingTreeGraphState =
  | {
      kind: "built";
      /** Self-contained DuckDB file (no WAL) holding the tree's graph; open it READ_ONLY. */
      dbPath: string;
      /** The base graph's physical collection — the tree graph keeps its name. */
      physicalCollectionName: PhysicalCollectionName;
    }
  | { kind: "unavailable"; reason: string };

/**
 * Port to the tree-graph cache. `graphFor(request, 0)` starts (or joins) the
 * build and returns at once — the overlay's warm-up; a positive `waitMs` bounds
 * how long the caller waits before it is told the graph is still building (the
 * build continues, the next call joins it). Never rejects.
 */
export interface WorkingTreeGraphSource {
  graphFor: (request: WorkingTreeGraphRequest, waitMs: number) => Promise<WorkingTreeGraphState>;
}
