/**
 * Working-tree graph (epic xi2r9, WTO-7) — the codegraph of uncommitted edits,
 * built by the production incremental run over a private clone of the base
 * graph. `tree-graph-entry.ts` is deliberately absent: it is a process entry
 * forked by path, never imported.
 */
export {
  buildWorkingTreeGraph,
  type WorkingTreeGraphBuildDeps,
  type WorkingTreeGraphBuildInput,
  type WorkingTreeGraphBuilt,
  type WorkingTreeGraphParseCacheUse,
  type WorkingTreeGraphProviderConfig,
} from "./tree-graph-build.js";
export {
  WORKING_TREE_GRAPH_CHILD_IDLE_MS,
  WORKING_TREE_GRAPH_CHILD_RECYCLE_HEAP_FRACTION,
  WorkingTreeGraphProcessBuilder,
  type WorkingTreeGraphBuildBudget,
  type WorkingTreeGraphBuildOutcome,
  type WorkingTreeGraphProcessBuilderOptions,
} from "./tree-graph-process-builder.js";
export { type WorkingTreeGraphSeed } from "./tree-graph-seed-apply.js";
export {
  treeDeltaAgainstSeed,
  treeGraphSeedOf,
  type WorkingTreeDeltaRecord,
  type WorkingTreeSeedDelta,
} from "./tree-graph-seed.js";
