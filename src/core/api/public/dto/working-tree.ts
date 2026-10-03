/**
 * `workingTree` marker DTOs (bd tea-rags-mcp-xi2r9). Declared in contracts so
 * the explore overlay that builds the marker can name it; re-exported here as
 * the consumer-facing shape.
 */
import type { WorkingTreeMarker } from "../../../contracts/types/working-tree.js";

export type { WorkingTreeFloor, WorkingTreeMarker, WorkingTreeState } from "../../../contracts/types/working-tree.js";

/**
 * The index a working tree is read against (live D10, bd tea-rags-mcp-xi2r9):
 * a linked worktree — or a subdirectory project of one — has no index of its
 * own, so a read tool handed its path answers for this index, never "not
 * indexed".
 */
export interface WorkingTreeIndexTarget {
  /** The base index's root — the path its status, metrics and drift are read at. */
  indexPath: string;
  /** How far the tree is from that index; absent when no overlay is wired. */
  workingTree?: WorkingTreeMarker;
}
