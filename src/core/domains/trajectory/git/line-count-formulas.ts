/**
 * The git trajectory's `line-count` formulas (bd tea-rags-mcp-39xca.20): how a
 * `git.*` value inherited from a base point is recomputed over a working tree's
 * line count. The history is the base's — an uncommitted edit has none of its
 * own — and only the denominator moves, exactly what a reindex of the tree
 * recomputes. The working-tree overlay applies these generically; the
 * arithmetic stays here, beside the assemblers that write the same keys.
 */

import type { PayloadSignalLineCountFormula } from "../../../contracts/types/trajectory.js";
import { computeRelativeChurn } from "./infra/metrics/extractors.js";

/**
 * `git.file.relativeChurn` — the window's churned lines over the file's line
 * count (`assembleFileSignals`). The file block keeps `linesAdded` /
 * `linesDeleted`, so the base's line count is not needed; a block without
 * them is not recomputed.
 */
const fileRelativeChurnAtLineCount: PayloadSignalLineCountFormula = ({ block, treeLineCount }) => {
  const { linesAdded, linesDeleted } = block;
  if (typeof linesAdded !== "number" || typeof linesDeleted !== "number") return undefined;
  return computeRelativeChurn(linesAdded, linesDeleted, treeLineCount);
};

/** Every `line-count` git payload signal's formula, by descriptor key. */
export const gitLineCountFormulas: ReadonlyMap<string, PayloadSignalLineCountFormula> = new Map([
  ["git.file.relativeChurn", fileRelativeChurnAtLineCount],
]);
