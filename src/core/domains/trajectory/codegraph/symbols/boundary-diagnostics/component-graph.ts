import type { FileDependencyEdge, FileDependencyGraph, RelPath } from "../../../../../contracts/types/codegraph.js";
import { classifyDirectoryRelation } from "./directory-relation.js";
import { isFacadeAggregationEdge } from "./facade-aggregation.js";
import type {
  ArchitectureComponent,
  ComponentDependency,
  ComponentGraph,
  FacadeModuleAssessment,
  FacadeModuleStatus,
} from "./types.js";

/**
 * Module statuses whose facade makes a COMPONENT (bd tea-rags-mcp-r8hme.7): the
 * modules the leaking-abstraction detector had enough importers to measure —
 * judged boundaries (`active`) and measured-but-bypassed ones
 * (`facade-not-adopted`). A facade with fewer importers than the adoption
 * floor is not evidence of a boundary, and a Go package has no facade file.
 *
 * Measured on the self-index: treating EVERY entry-file directory as a
 * component made `src` (it has `src/index.ts`) a catch-all owning every file
 * below it that no nearer facade claimed — `src/cli/**`, `src/bootstrap/**` —
 * with 131 dependents, which put it on the stable side of 14 of the 38
 * violations it produced.
 */
export const COMPONENT_MODULE_STATUSES: ReadonlySet<FacadeModuleStatus> = new Set(["active", "facade-not-adopted"]);

/** What the containment exclusion takes out of SDP judgement, named for a report. */
export const COMPONENT_CONTAINMENT_REASON =
  "containment: a component depending on a component nested inside its directory - composition, not a peer dependency";

/**
 * Aggregate the file dependency graph to components (bd tea-rags-mcp-r8hme.7) —
 * the unit Martin defined stability for.
 *
 * PARTITION. A module whose facade `modules` measured
 * ({@link COMPONENT_MODULE_STATUSES}) owns its directory subtree, minus the
 * subtrees of modules nested inside it. Every other file belongs to its OWN
 * directory — no roll-up into a parent: for Ruby the directory IS the
 * namespace, and rolling small directories up into the nearest ancestor with
 * enough files mixed unrelated namespaces into one component (on taxdome it
 * raised the judged component edges from 8962 to 13768 and the violations
 * from 267 to 390 without making any of them more specific).
 *
 * EDGES. A file edge becomes part of a component dependency unless it is a
 * self-edge, has an endpoint the walk never extracted, stays inside one
 * component, or is facade aggregation (`isFacadeAggregationEdge` — the child's
 * surface is part of the parent's). Those are counted in `excluded`.
 *
 * COUPLING. Ca = distinct files outside the component with an edge into it;
 * Ce = distinct files inside it with an edge out; I = Ce / (Ca + Ce), 0 with
 * no edge — Martin's class counts, with files for classes. A dependency on a
 * component nested inside the source's directory (containment) still counts
 * here: the child's volatility is the parent's all the same; whether to JUDGE
 * it is the detector's call.
 */
export function buildComponentGraph(
  graph: FileDependencyGraph,
  modules: readonly FacadeModuleAssessment[],
): ComponentGraph {
  const componentModules = new Map<string, FacadeModuleAssessment>();
  for (const m of modules) if (COMPONENT_MODULE_STATUSES.has(m.status)) componentModules.set(m.moduleDir, m);

  const componentOf = new Map<RelPath, string>();
  const members = new Map<string, number>();
  for (const f of graph.files) {
    const component = owningComponent(f.relPath, componentModules);
    componentOf.set(f.relPath, component);
    members.set(component, (members.get(component) ?? 0) + 1);
  }

  const excluded = { selfEdges: 0, unwalkedEndpoints: 0, intraComponent: 0, facadeAggregations: 0 };
  const afferent = new Map<string, Set<RelPath>>();
  const efferent = new Map<string, Set<RelPath>>();
  const carried = new Map<string, FileDependencyEdge[]>();
  for (const edge of graph.edges) {
    const source = componentOf.get(edge.sourceRelPath);
    const target = componentOf.get(edge.targetRelPath);
    if (edge.sourceRelPath === edge.targetRelPath) excluded.selfEdges++;
    else if (source === undefined || target === undefined) excluded.unwalkedEndpoints++;
    else if (source === target) excluded.intraComponent++;
    else if (isFacadeAggregationEdge(edge)) excluded.facadeAggregations++;
    else {
      addTo(afferent, target, edge.sourceRelPath);
      addTo(efferent, source, edge.sourceRelPath);
      const key = `${source}\u0000${target}`;
      const fileEdges = carried.get(key);
      if (fileEdges) fileEdges.push(edge);
      else carried.set(key, [edge]);
    }
  }

  const components = new Map<string, ArchitectureComponent>();
  for (const [componentDir, fileCount] of [...members].sort(([a], [b]) => compareCodePoints(a, b))) {
    const module = componentModules.get(componentDir);
    const afferentCount = afferent.get(componentDir)?.size ?? 0;
    const efferentCount = efferent.get(componentDir)?.size ?? 0;
    const connectionCount = afferentCount + efferentCount;
    components.set(componentDir, {
      componentDir,
      kind: module ? "module" : "directory",
      facadeRelPath: module?.facadeRelPath ?? null,
      fileCount,
      afferentCount,
      efferentCount,
      connectionCount,
      instability: connectionCount === 0 ? 0 : efferentCount / connectionCount,
    });
  }

  const dependencies: ComponentDependency[] = [...carried]
    .map(([key, fileEdges]) => {
      const [sourceComponent, targetComponent] = key.split("\u0000");
      return {
        sourceComponent,
        targetComponent,
        directoryRelation: classifyDirectoryRelation(`${sourceComponent}/_`, `${targetComponent}/_`),
        callWeight: fileEdges.reduce((sum, e) => sum + e.callWeight, 0),
        fileEdges,
      };
    })
    .sort(
      (a, b) =>
        compareCodePoints(a.sourceComponent, b.sourceComponent) ||
        compareCodePoints(a.targetComponent, b.targetComponent),
    );

  return { components, componentOf, dependencies, excluded, fileEdgeCount: graph.edges.length };
}

/** The innermost component module containing `relPath`, else the file's own directory. */
function owningComponent(relPath: RelPath, componentModules: ReadonlyMap<string, FacadeModuleAssessment>): string {
  const ownDir = directoryOf(relPath);
  let dir = ownDir;
  for (;;) {
    if (componentModules.has(dir)) return dir;
    if (dir === "") return ownDir;
    dir = directoryOf(dir);
  }
}

function addTo(map: Map<string, Set<RelPath>>, key: string, relPath: RelPath): void {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(relPath);
}

function directoryOf(relPath: string): string {
  const slash = relPath.lastIndexOf("/");
  return slash === -1 ? "" : relPath.slice(0, slash);
}

/** Locale-independent, so the order is the same on every machine. */
function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
