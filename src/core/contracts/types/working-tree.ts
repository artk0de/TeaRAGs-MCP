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
 * for the base chunks of delta files (`chunks`, `sparse`), delta rows ranked by
 * their own dense vectors (`dense`, WTO-5), or the tree graph for the base
 * graph (`codegraph`, WTO-7).
 */
export type WorkingTreeFloor = "chunks" | "sparse" | "dense" | "codegraph";

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
  /**
   * Why graph data in this answer came from the INDEX's graph although the
   * tree changed files (WTO-7): the tree graph was still building past the
   * caller's wait, its build failed, or codegraph is off. Set only while
   * `floors` lacks `"codegraph"`: the graph edges and codegraph signals then
   * describe the indexed commit, not the tree.
   */
  treeGraphUnavailable?: string;
  /**
   * Why some of the tree's rows were left out of this answer's dense ranking
   * (WTO-5): their vectors were still being made past the wait, or the
   * embedding provider failed. Set only by an answer that ranked by vectors;
   * the touched files' base rows are excluded either way, so a row named here
   * is simply absent from the dense leg.
   */
  denseUnavailable?: { reason: string };
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

/**
 * A view's access to its tree graph: wait at most `waitMs` for the graph of the
 * view's delta. Present only on a view whose measured delta is non-empty — a
 * clean or degraded view has no tree graph to read. Never rejects.
 */
export type WorkingTreeGraphReader = (waitMs: number) => Promise<WorkingTreeGraphState>;

/** One row the tree holds and the index does not — a delta chunk as the overlay yields it. */
export interface WorkingTreeDeltaRow {
  id: string | number;
  payload: Record<string, unknown>;
}

/**
 * One base-index point of a file the tree touched, with the payload subset its
 * readers use: `relativePath`, `symbolId`, `startLine`, `endLine`, `git`,
 * `codegraph`.
 */
export interface WorkingTreeBasePoint {
  id: string | number;
  payload: Record<string, unknown>;
}

/**
 * The base points of a view's touched files (changed ∪ deleted), by path, in
 * path order; a path the base index never held has no entry.
 */
export type WorkingTreeTouchedBasePointsByPath = ReadonlyMap<string, readonly WorkingTreeBasePoint[]>;

/**
 * A view's read of its touched files' base points — one read per request,
 * shared by every consumer of the view (hybrid's `has_id` exclusion, the delta
 * signals' inheritance).
 */
export type WorkingTreeTouchedBasePointsReader = () => Promise<WorkingTreeTouchedBasePointsByPath>;

/** Everything the signal source needs to enrich one view's delta rows. */
export interface WorkingTreeDeltaSignalRequest {
  tree: WorkingTree;
  /** Delta rows of changed files; returned enriched, in the same order. */
  rows: readonly WorkingTreeDeltaRow[];
  /** The view's tree graph; absent when no graph source is wired. */
  readTreeGraph?: WorkingTreeGraphReader;
  /**
   * The view's touched-file base points, the source of inherited git /
   * codegraph payload. Absent → no base reader wired: rows inherit nothing.
   */
  readTouchedBasePoints?: WorkingTreeTouchedBasePointsReader;
  /**
   * The delta's moves: a changed path → the deleted path git pairs it with
   * (`WorkingTreeDelta#renamedFrom`). A moved file's history is its OLD path's,
   * so its rows inherit git from the old path's base points. Absent → no moves.
   */
  renamedFrom?: ReadonlyMap<string, string>;
}

/**
 * Enriched delta rows, and the tree-graph state their codegraph block was
 * decided by: `built` — computed from the tree graph; `unavailable` — inherited
 * from the base points. Absent when no tree graph could be asked.
 */
export interface WorkingTreeDeltaSignalResult {
  rows: WorkingTreeDeltaRow[];
  treeGraph?: WorkingTreeGraphState;
}

/**
 * Port that gives delta rows the trajectory payload ingest would have given
 * them (WTO-6/7). The chunk layer yields structure only, so without it every
 * delta row ranks as a file with no history and no graph — the live probe had a
 * modified `hybrid.ts` at #24 under `hotspots`, scored as zero-git. Implemented
 * in `api/internal` (it reads Qdrant and the codegraph), injected into the
 * overlay so every consumer of delta rows gets them enriched. A missing base
 * point or graph is not an error — the row carries less. Never rejects.
 */
export interface WorkingTreeDeltaSignalSource {
  enrich: (request: WorkingTreeDeltaSignalRequest) => Promise<WorkingTreeDeltaSignalResult>;
}

/** One delta row whose `git.chunk` is computed on demand, in the TREE file's lines. */
export interface WorkingTreeGitChunkTarget {
  /** The caller's key for the row; the answer is keyed by it. */
  key: string;
  startLine: number;
  endLine: number;
}

/**
 * One delta file the git trajectory is asked about: its history, and what of it
 * no base point answers.
 */
export interface WorkingTreeGitSignalTarget {
  /** The HISTORY path, relative to the tree root: the file's own, or a move's old path. */
  relativePath: string;
  /** The tree file the rows were chunked from (relative to the tree root) — where their lines are read. */
  treePath: string;
  /** Last line the file's rows reach — the line count ingest computes file signals over. */
  maxEndLine: number;
  /** Whether `git.file` is wanted (no base point of the history path carries one). */
  fileSignals: boolean;
  /** Rows no base point of the same symbol answers. */
  chunks: readonly WorkingTreeGitChunkTarget[];
}

/** What the git trajectory computed for one history path. */
export interface WorkingTreeGitSignals {
  /** `git.file`, when asked for and the path has commit history. */
  file?: Record<string, unknown>;
  /** `git.chunk` by row key; a row whose lines hold no committed history is absent. */
  chunks: ReadonlyMap<string, Record<string, unknown>>;
}

/**
 * Port to the git trajectory's own signal computation (bd tea-rags-mcp-xi2r9,
 * D12), for what no base point answers: `git.file` of a file the base never
 * chunked (below the chunk floor, committed after the index), `git.chunk` of a
 * row whose symbol the base never held. Answers the blocks ingest would have
 * written — the file backfill's history and blame, the chunk walk's
 * hunk→range attribution — keyed by `relativePath`. A row's lines are the
 * tree file's; lines the working file added hold no history, so a row made only
 * of them, and a path never committed, get nothing. Implemented in
 * `api/internal` over the git trajectory and wired at the composition root, so
 * explore never imports trajectory. Never rejects.
 */
export interface WorkingTreeGitSignalSource {
  signalsOf: (
    root: string,
    targets: readonly WorkingTreeGitSignalTarget[],
  ) => Promise<ReadonlyMap<string, WorkingTreeGitSignals>>;
}
