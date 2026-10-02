/**
 * Working-tree vocabulary (bd tea-rags-mcp-xi2r9) shared by the resolver that
 * picks the tree (`api/internal/collection-resolver.ts`), the explore overlay
 * that measures it (`domains/explore/working-tree/`), and the DTOs that carry
 * the answer (`api/public/dto/working-tree.ts`). It lives in contracts because
 * the explore domain may not import the api layer that names the request.
 */

/** The tree a request reads, and the index it reads that tree against. */
export interface WorkingTree {
  /** realpath of the tree the caller stands in (git toplevel, not a subdir) */
  root: string;
  /** lower layer the tree is read against */
  baseIndex: { collectionName: string; root: string | undefined };
}

/** A read path on which delta chunks replace the base chunks of delta files. */
export type WorkingTreeFloor = "chunks" | "sparse";

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
