/**
 * A fake `WorkingTreeView` for pure strategy tests (bd tea-rags-mcp-xi2r9.3):
 * real git is covered by the delta tests and the live run, so a strategy test
 * hands the view in directly — the touched paths and the rows the tree yields.
 */

import type { WorkingTreeTouchedBasePointsByPath } from "../../../../../src/core/contracts/types/working-tree.js";
import type { ScrollChunk } from "../../../../../src/core/domains/explore/chunk-grouping/types.js";
import type {
  WorkingTreeDenseVectors,
  WorkingTreeView,
} from "../../../../../src/core/domains/explore/working-tree/index.js";

export interface FakeWorkingTreeViewInput {
  changed?: string[];
  deleted?: string[];
  /** Rows of the changed files as the chunk layer would yield them. Omit → no chunk layer wired. */
  rows?: ScrollChunk[];
  /** The rows' dense vectors as the dense floor would answer them (WTO-5). Omit → no dense source wired. */
  dense?: WorkingTreeDenseVectors;
  /** The touched files' base points. Omit → no base-point reader wired. */
  basePoints?: WorkingTreeTouchedBasePointsByPath;
}

export function fakeWorkingTreeView({
  changed = [],
  deleted = [],
  rows,
  dense,
  basePoints,
}: FakeWorkingTreeViewInput): WorkingTreeView {
  const view: WorkingTreeView = {
    marker: {
      tree: "/tree",
      indexedCommit: "a".repeat(40),
      treeCommit: "b".repeat(40),
      indexedDirty: false,
      changedFiles: changed.length,
      deletedFiles: deleted.length,
      floors: [],
    },
    touchedPaths: new Set([...changed, ...deleted]),
    deletedPaths: new Set(deleted),
  };
  if (rows) view.readDeltaChunks = async () => rows;
  if (dense) view.readDeltaVectors = async () => dense;
  if (basePoints) view.readTouchedBasePoints = async () => basePoints;
  return view;
}

/** A code chunk row as ingest stores it. */
export function codeRow(id: string, payload: Record<string, unknown>): ScrollChunk {
  return {
    id,
    payload: { chunkType: "function", language: "typescript", startLine: 1, endLine: 3, content: "", ...payload },
  };
}
