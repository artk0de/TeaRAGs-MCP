/**
 * What-if restructuring (bd tea-rags-mcp-r8hme.21): declarative move / merge /
 * split ops compiled into relabelled architecture graph facts. The api runner
 * judges base and relabelled facts and diffs them; this module owns the value.
 */
export {
  applyArchitectureRestructure,
  compileArchitectureRestructure,
  type ArchitectureRestructureCompilation,
  type ArchitectureRestructurePartition,
  type ArchitectureRestructureRelabel,
  type ArchitectureRestructureTargetFacts,
} from "./architecture-restructure.js";
