import type { FileDependencyGraph } from "../../../../../contracts/types/codegraph.js";
import { buildNonProductionPathFilter, type PathFilter } from "../../../../../infra/file-classification/index.js";

/** What the non-production exclusion takes out, named for a report (bd tea-rags-mcp-r8hme.9). */
export const NON_PRODUCTION_REASON =
  "non-production path: scripts, spikes, benchmarks, examples or fixtures - tooling, not architecture";

/** The graph the boundary detectors judge, and what was taken out to get it. */
export interface ProductionDependencyGraph {
  graph: FileDependencyGraph;
  /** Walked files whose path the classification names non-production. */
  excludedFileCount: number;
  /** Edges with a non-production endpoint, walked or not. */
  excludedEdgeCount: number;
}

/**
 * The file dependency graph without development tooling (bd tea-rags-mcp-r8hme.9):
 * every file `nonProduction` names, and every edge touching one — an unwalked
 * endpoint is classified by its path like any other. Applied BEFORE any
 * detector counts a fan, so a spike importing a module neither leaks past its
 * facade nor stabilises it. Tests never get here: the codegraph exclusion keeps
 * them out of the graph altogether.
 *
 * The classification is the file classifier's (`buildNonProductionPathFilter`,
 * `infra/file-classification`), not a glob owned here; it is a parameter so a
 * caller can judge with another one.
 */
export function excludeNonProductionFiles(
  graph: FileDependencyGraph,
  nonProduction: PathFilter = buildNonProductionPathFilter(),
): ProductionDependencyGraph {
  const files = graph.files.filter((f) => !nonProduction.ignores(f.relPath));
  const edges = graph.edges.filter(
    (e) => !nonProduction.ignores(e.sourceRelPath) && !nonProduction.ignores(e.targetRelPath),
  );
  return {
    graph: { files, edges },
    excludedFileCount: graph.files.length - files.length,
    excludedEdgeCount: graph.edges.length - edges.length,
  };
}
