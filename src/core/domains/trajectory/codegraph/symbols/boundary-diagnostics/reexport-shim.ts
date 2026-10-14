import type { FileDependencyEdge, FileDependencyGraph, RelPath } from "../../../../../contracts/types/codegraph.js";
import { carriesReexport } from "./facade-aggregation.js";
import type { ReexportShimComponents } from "./types.js";

/** What the re-export shim exclusion takes out of SDP judgement, named for a report (bd tea-rags-mcp-ciq4d). */
export const REEXPORT_SHIM_REASON =
  "re-export shim: a component whose every file only re-exports other modules has no volatility of its own - edges into it are judged against the components it re-exports, its own edges are not judged";

/**
 * The components every walked file of which is a PURE RE-EXPORT (bd
 * tea-rags-mcp-ciq4d), and where each such file's re-exports finally land.
 *
 * A file is a pure re-export when the walk found no symbol it defines
 * (`symbolCount` 0), it has at least one outgoing edge, and every outgoing
 * edge forwards exports (`carriesReexport`) and carries no resolved call.
 * One file declaring anything of its own makes its component opaque.
 *
 * A shim file's ULTIMATE targets are the targets of its edges, followed
 * through every file that itself sits in a shim component, to the first file
 * that does not (or that the walk never extracted). Following is per file
 * edge, never by export name: an aliased re-export spells the name the source
 * module knows, not the one its importer imports, so a name filter would drop
 * real paths.
 */
export function deriveReexportShimComponents(
  graph: FileDependencyGraph,
  componentOf: ReadonlyMap<RelPath, string>,
): ReexportShimComponents {
  const outgoing = new Map<RelPath, FileDependencyEdge[]>();
  for (const edge of graph.edges) {
    if (edge.sourceRelPath === edge.targetRelPath) continue;
    const edges = outgoing.get(edge.sourceRelPath);
    if (edges) edges.push(edge);
    else outgoing.set(edge.sourceRelPath, [edge]);
  }

  const opaque = new Set<string>();
  const members = new Map<string, RelPath[]>();
  for (const file of graph.files) {
    const component = componentOf.get(file.relPath);
    if (component === undefined) continue;
    const files = members.get(component);
    if (files) files.push(file.relPath);
    else members.set(component, [file.relPath]);
    if (!isPureReexportFile(file.symbolCount, outgoing.get(file.relPath) ?? [])) opaque.add(component);
  }
  const componentDirs = new Set([...members.keys()].filter((c) => !opaque.has(c)));

  const ultimateTargetsOf = new Map<RelPath, RelPath[]>();
  for (const component of componentDirs) {
    for (const relPath of members.get(component) ?? []) {
      ultimateTargetsOf.set(relPath, ultimateTargets(relPath, outgoing, componentOf, componentDirs));
    }
  }
  return { componentDirs, ultimateTargetsOf };
}

function isPureReexportFile(symbolCount: number, edges: readonly FileDependencyEdge[]): boolean {
  return symbolCount === 0 && edges.length > 0 && edges.every((e) => e.callWeight === 0 && carriesReexport(e));
}

/** Depth-first through shim files, each visited once; sorted, distinct. */
function ultimateTargets(
  relPath: RelPath,
  outgoing: ReadonlyMap<RelPath, readonly FileDependencyEdge[]>,
  componentOf: ReadonlyMap<RelPath, string>,
  shimComponents: ReadonlySet<string>,
): RelPath[] {
  const targets = new Set<RelPath>();
  const visited = new Set<RelPath>([relPath]);
  const frontier: RelPath[] = [relPath];
  for (let next = frontier.pop(); next !== undefined; next = frontier.pop()) {
    for (const edge of outgoing.get(next) ?? []) {
      const target = edge.targetRelPath;
      const component = componentOf.get(target);
      if (component === undefined || !shimComponents.has(component)) targets.add(target);
      else if (!visited.has(target)) {
        visited.add(target);
        frontier.push(target);
      }
    }
  }
  return [...targets].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
}
