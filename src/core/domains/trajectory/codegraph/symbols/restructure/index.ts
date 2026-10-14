/**
 * What-if restructuring (bd tea-rags-mcp-r8hme.21): declarative move / merge /
 * split ops, and addFile / addEdge / removeEdge edge ops (bd
 * tea-rags-mcp-cm9gt.1), compiled into relabelled architecture graph facts.
 * The api runner judges base and relabelled facts and diffs them; this module
 * owns the value.
 */
export {
  applyArchitectureRestructure,
  architectureRestructureEdgeKey,
  compileArchitectureRestructure,
  type ArchitectureRestructureCompilation,
  type ArchitectureRestructureEdgeBase,
  type ArchitectureRestructureEdgeEdits,
  type ArchitectureRestructurePartition,
  type ArchitectureRestructureRelabel,
  type ArchitectureRestructureTargetFacts,
} from "./architecture-restructure.js";
