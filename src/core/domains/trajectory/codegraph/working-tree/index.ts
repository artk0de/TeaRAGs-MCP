/**
 * Working-tree graph (epic xi2r9, WTO-7) — the codegraph of uncommitted edits,
 * built by the production incremental run over a private clone of the base
 * graph. `tree-graph-entry.ts` is deliberately absent: it is a process entry
 * forked by path, never imported.
 */
export {
  buildWorkingTreeGraph,
  type WorkingTreeGraphBuildInput,
  type WorkingTreeGraphBuilt,
  type WorkingTreeGraphProviderConfig,
} from "./tree-graph-build.js";
export {
  WorkingTreeGraphProcessBuilder,
  type WorkingTreeGraphBuildBudget,
  type WorkingTreeGraphBuildOutcome,
} from "./tree-graph-process-builder.js";
