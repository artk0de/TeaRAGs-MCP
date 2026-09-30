import type { FileDependencyEdge, FileDependencyGraph, RelPath } from "../../../../../contracts/types/codegraph.js";
import { isFacadeAggregationEdge } from "./facade-aggregation.js";

/** The files at or below a domain root, in graph order. */
function insideDomain(domainRoot: string): (relPath: RelPath) => boolean {
  return (relPath) => relPath === domainRoot || relPath.startsWith(`${domainRoot}/`);
}

/**
 * The induced sub-graph of one directory (bd tea-rags-mcp-xb669.1): the files
 * at or below `domainRoot`, and the edges whose BOTH endpoints stayed inside —
 * the graph a domain-mode architecture report judges as a self-contained
 * system. Nothing is lost by inducing: edges leaving or entering are read
 * from the WHOLE graph by {@link domainBoundaryFileEdges} and reported as
 * boundary findings, which an internal view could never recompute.
 */
export function inducedDomainGraph(graph: FileDependencyGraph, domainRoot: string): FileDependencyGraph {
  const inside = insideDomain(domainRoot);
  const files = graph.files.filter((f) => inside(f.relPath));
  const kept = new Set(files.map((f) => f.relPath));
  const edges = graph.edges.filter((e) => kept.has(e.sourceRelPath) && kept.has(e.targetRelPath));
  return { files, edges };
}

/** The file edges crossing a domain's border: `out` leave it, `in` enter it. */
export interface DomainBoundaryFileEdges {
  out: FileDependencyEdge[];
  in: FileDependencyEdge[];
}

/**
 * The border of `domainRoot` in the WHOLE graph — every production edge with
 * exactly one endpoint inside. Facade aggregation is excluded by the same
 * rule the component graph applies: a parent facade re-exporting a nested
 * facade is the child's surface reaching its own consumers, not a dependency
 * the border carries (bd tea-rags-mcp-r8hme.30's map exclusion).
 */
export function domainBoundaryFileEdges(graph: FileDependencyGraph, domainRoot: string): DomainBoundaryFileEdges {
  const inside = insideDomain(domainRoot);
  const boundary: DomainBoundaryFileEdges = { out: [], in: [] };
  for (const edge of graph.edges) {
    const sourceIn = inside(edge.sourceRelPath);
    const targetIn = inside(edge.targetRelPath);
    if (sourceIn === targetIn) continue;
    if (isFacadeAggregationEdge(edge)) continue;
    if (sourceIn) boundary.out.push(edge);
    else boundary.in.push(edge);
  }
  return boundary;
}
