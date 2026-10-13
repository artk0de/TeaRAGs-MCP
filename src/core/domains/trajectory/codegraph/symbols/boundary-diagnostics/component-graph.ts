import type { FileDependencyEdge, FileDependencyGraph, RelPath } from "../../../../../contracts/types/codegraph.js";
import { isNamespaceComponent } from "../../component-geometry/index.js";
import { classifyComponentRelation, deriveConstantNamespaceComponents } from "./constant-namespace.js";
import { isFacadeAggregationEdge } from "./facade-aggregation.js";
import type {
  ArchitectureComponent,
  ComponentDependency,
  ComponentFacadeAggregation,
  ComponentGraph,
  FacadeModuleAssessment,
} from "./types.js";

/** What the containment exclusion takes out of SDP judgement, named for a report. */
export const COMPONENT_CONTAINMENT_REASON =
  "containment: a component depending on a component nested inside its directory - composition, not a peer dependency";

/**
 * Aggregate the file dependency graph to components (bd tea-rags-mcp-r8hme.7) —
 * the unit Martin defined stability for.
 *
 * PARTITION — ONE for every component detector (bd tea-rags-mcp-r8hme.52.7):
 * every module `modules` assessed owns its directory subtree, minus the
 * subtrees of modules nested inside it, whatever its adoption status (bd
 * tea-rags-mcp-r8hme.30). Whether importers ADOPTED a facade says whether a
 * boundary can be LEAKED PAST — the leaking-abstraction detector's question,
 * which reads modules, not components — never whether the directory declares
 * itself a unit: a language vertical's `<lang>/index.ts` is its domain where
 * the factory is the only importer, a Go package is a domain its compiler
 * drew. A narrower adoption-only partition for SDP / main-sequence / hub /
 * shotgun once judged a too-few-importers kernel as part of its
 * facade-not-adopted parent and flagged the parent for the kernel's edges
 * (`ts/walker → language` on the self-index). A file outside every such module whose
 * path spells the constant it declares belongs to that constant's NAMESPACE
 * (bd tea-rags-mcp-r8hme.11, `deriveConstantNamespaceComponents`):
 * `app/models/billing/*` and `app/services/billing/*` are one `::Billing`.
 * Every other file belongs to its OWN directory — no roll-up into a parent:
 * rolling small directories up into the nearest ancestor with
 * enough files mixed unrelated namespaces into one component (on taxdome it
 * raised the judged component edges from 8962 to 13768 and the violations
 * from 267 to 390 without making any of them more specific).
 *
 * ENTRIES. A module whose facade file no file edge reaches and no external
 * file reaches (`isEntryFacade`, measured over every module whatever its
 * status) is a process or package root, not a domain boundary: it owns only
 * its OWN directory's files, which form the component marked `entryFacade`
 * The files below it fall as if it were absent, minus any enclosing module —
 * the walk stops at the entry (bd tea-rags-mcp-r8hme.52.4). Measured on the
 * self-index: `src/index.ts` owned 105 files (bootstrap, both adapters, the
 * infra root) with Ca 244 and sat in a 52-member layering knot.
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
 *
 * RELABEL. `componentRelabel` pins files to a component ahead of the walk
 * above — the what-if restructuring's relabelled facts (bd
 * tea-rags-mcp-r8hme.21), where a split group carved out of a module stays in
 * the module's directory and only the pin makes it a component of its own.
 */
export function buildComponentGraph(
  graph: FileDependencyGraph,
  modules: readonly FacadeModuleAssessment[],
  componentRelabel?: ReadonlyMap<RelPath, string>,
): ComponentGraph {
  // Entries are measured over EVERY module: the predicate reads the graph,
  // not the adoption verdict (bd tea-rags-mcp-r8hme.52.4).
  const importedFiles = importedFileSet(graph.edges);
  const entryModules = new Map<string, FacadeModuleAssessment>();
  for (const m of modules) if (isEntryFacade(m, importedFiles)) entryModules.set(m.moduleDir, m);
  const componentModules = new Map<string, FacadeModuleAssessment>();
  for (const m of modules) {
    if (!entryModules.has(m.moduleDir)) componentModules.set(m.moduleDir, m);
  }

  const namespaceOf = deriveConstantNamespaceComponents(graph.files);
  const componentOf = new Map<RelPath, string>();
  const members = new Map<string, number>();
  for (const f of graph.files) {
    const component =
      componentRelabel?.get(f.relPath) ?? owningComponent(f.relPath, componentModules, entryModules, namespaceOf);
    componentOf.set(f.relPath, component);
    members.set(component, (members.get(component) ?? 0) + 1);
  }

  const excluded = { selfEdges: 0, unwalkedEndpoints: 0, intraComponent: 0, facadeAggregations: 0 };
  const afferent = new Map<string, Set<RelPath>>();
  const efferent = new Map<string, Set<RelPath>>();
  const carried = new Map<string, FileDependencyEdge[]>();
  const aggregations = new Map<string, ComponentFacadeAggregation>();
  for (const edge of graph.edges) {
    const source = componentOf.get(edge.sourceRelPath);
    const target = componentOf.get(edge.targetRelPath);
    if (edge.sourceRelPath === edge.targetRelPath) excluded.selfEdges++;
    else if (source === undefined || target === undefined) excluded.unwalkedEndpoints++;
    else if (source === target) excluded.intraComponent++;
    else if (isFacadeAggregationEdge(edge)) {
      excluded.facadeAggregations++;
      aggregations.set(`${source}\u0000${target}`, { parentComponent: source, nestedComponent: target });
    } else {
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
    // An entry stays a module component — it only gives up the subtree below
    // its own directory.
    const entry = entryModules.get(componentDir);
    const module = componentModules.get(componentDir) ?? entry;
    const afferentCount = afferent.get(componentDir)?.size ?? 0;
    const efferentCount = efferent.get(componentDir)?.size ?? 0;
    const connectionCount = afferentCount + efferentCount;
    components.set(componentDir, {
      componentDir,
      kind: module ? "module" : isNamespaceComponent(componentDir) ? "namespace" : "directory",
      facadeRelPath: module?.facadeRelPath ?? null,
      fileCount,
      afferentCount,
      efferentCount,
      connectionCount,
      instability: connectionCount === 0 ? 0 : efferentCount / connectionCount,
      ...(entry ? { entryFacade: true as const } : {}),
    });
  }

  const dependencies: ComponentDependency[] = [...carried]
    .map(([key, fileEdges]) => {
      const [sourceComponent, targetComponent] = key.split("\u0000");
      return {
        sourceComponent,
        targetComponent,
        directoryRelation: classifyComponentRelation(sourceComponent, targetComponent),
        callWeight: fileEdges.reduce((sum, e) => sum + e.callWeight, 0),
        fileEdges,
      };
    })
    .sort(
      (a, b) =>
        compareCodePoints(a.sourceComponent, b.sourceComponent) ||
        compareCodePoints(a.targetComponent, b.targetComponent),
    );

  const facadeAggregations = [...aggregations.values()].sort(
    (a, b) =>
      compareCodePoints(a.parentComponent, b.parentComponent) ||
      compareCodePoints(a.nestedComponent, b.nestedComponent),
  );

  return { components, componentOf, dependencies, excluded, facadeAggregations, fileEdgeCount: graph.edges.length };
}

/**
 * An entry module (bd tea-rags-mcp-r8hme.52.2): its facade file is the target
 * of no file edge — facade aggregation included, so a nested facade its parent
 * re-exports is NOT an entry — and no file outside the module reaches it. A
 * process or package entry, measured; no path or file name decides it. A Go
 * package (no facade file) is never one.
 */
function isEntryFacade(module: FacadeModuleAssessment, importedFiles: ReadonlySet<RelPath>): boolean {
  return (
    module.facadeRelPath !== null && module.externalImporterCount === 0 && !importedFiles.has(module.facadeRelPath)
  );
}

/** Every file some OTHER file has an edge into — facade aggregation included. */
function importedFileSet(edges: readonly FileDependencyEdge[]): ReadonlySet<RelPath> {
  const imported = new Set<RelPath>();
  for (const edge of edges) if (edge.sourceRelPath !== edge.targetRelPath) imported.add(edge.targetRelPath);
  return imported;
}

/**
 * The innermost component module containing `relPath`, else the constant
 * namespace its path spells, else the file's own directory. An entry module
 * (bd tea-rags-mcp-r8hme.52.4) owns only the files of its own directory: the
 * walk stops at it, so a file below it that no nearer module claims falls to
 * its namespace or own directory, never to the entry and never past it to an
 * enclosing module.
 */
function owningComponent(
  relPath: RelPath,
  componentModules: ReadonlyMap<string, FacadeModuleAssessment>,
  entryModules: ReadonlyMap<string, FacadeModuleAssessment>,
  namespaceOf: ReadonlyMap<RelPath, string>,
): string {
  const ownDir = directoryOf(relPath);
  if (entryModules.has(ownDir)) return ownDir;
  let dir = ownDir;
  for (;;) {
    if (componentModules.has(dir)) return dir;
    if (dir === "" || entryModules.has(dir)) return namespaceOf.get(relPath) ?? ownDir;
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
