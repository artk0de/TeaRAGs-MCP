import type { FileDependencyEdge, RelPath } from "../../../../../contracts/types/codegraph.js";
import {
  benjaminiHochbergRejectionCount,
  CONVENTIONAL_FDR_Q,
  geometricUpperTail,
} from "../../../../../primitives/math/index.js";
import { componentAncestry, isNamespaceComponent } from "../../component-geometry/index.js";
import { MAIN_SEQUENCE_OTSU_MIN_POPULATION } from "./main-sequence.js";
import type { ComponentDependency, CompositionTableCut, CompositionTables } from "./types.js";

/**
 * Composition TABLES (bd tea-rags-mcp-r8hme.52.17): files that wire many
 * components without calling any — a registration list, a routing table, a
 * module registry. Measured, never named: the population is every file whose
 * walked dependency edges (self-edges aside) ALL carry callWeight 0 and at
 * least one of which crosses into another component; a file's value is the
 * number of distinct components its crossing edges reach.
 *
 * The cut is a significance test, not a split (owner decision 2026-10-14):
 * the population is a point mass at 1 with a decaying tail, never bimodal, so
 * Otsu's η gate refused it on every corpus and a quartile fence collapses
 * (IQR 0). Each file's excess, count − 1, is tested against a geometric null
 * whose parameter is the population's own mean excess (the MLE); its upper
 * tail P(X ≥ count − 1) is the file's p, and Benjamini–Hochberg at
 * {@link CONVENTIONAL_FDR_Q} over the whole population flags the files whose
 * fan-out the null cannot produce. Below
 * {@link MAIN_SEQUENCE_OTSU_MIN_POPULATION} files the mean is not a fit and no
 * file is flagged (`thresholdMethod: "none"`). Annotation evidence only — no
 * detector excludes on it (owner decision 2026-10-14; r8hme.51 stands).
 */
export function measureCompositionTables(
  edges: readonly FileDependencyEdge[],
  componentOf: ReadonlyMap<RelPath, string>,
  dependencies: readonly ComponentDependency[],
): CompositionTables {
  const calling = new Set<RelPath>();
  for (const edge of edges) {
    if (edge.sourceRelPath === edge.targetRelPath) continue;
    if (!componentOf.has(edge.sourceRelPath) || !componentOf.has(edge.targetRelPath)) continue;
    if (edge.callWeight > 0) calling.add(edge.sourceRelPath);
  }
  const reachedComponents = new Map<RelPath, Set<string>>();
  for (const dependency of dependencies) {
    for (const edge of dependency.fileEdges) {
      if (calling.has(edge.sourceRelPath)) continue;
      const reached = reachedComponents.get(edge.sourceRelPath) ?? new Set<string>();
      reached.add(dependency.targetComponent);
      reachedComponents.set(edge.sourceRelPath, reached);
    }
  }

  const fanOuts = [...reachedComponents].map(([relPath, reached]) => ({ relPath, count: reached.size }));
  const counts = fanOuts.map((f) => f.count);
  const median = medianOf(counts);
  if (counts.length < MAIN_SEQUENCE_OTSU_MIN_POPULATION) {
    const unfitted: CompositionTableCut = { thresholdMethod: "none", median, population: counts.length, fileCount: 0 };
    return { files: new Set<RelPath>(), cut: unfitted };
  }

  const nullMean = counts.reduce((sum, count) => sum + (count - 1), 0) / counts.length;
  const tested = fanOuts
    .filter((f) => f.count > 1)
    .map((f) => ({ relPath: f.relPath, p: geometricUpperTail(f.count - 1, nullMean) }))
    .sort((x, y) => x.p - y.p || (x.relPath < y.relPath ? -1 : x.relPath > y.relPath ? 1 : 0));
  const rejected = benjaminiHochbergRejectionCount(
    tested.map((t) => t.p),
    counts.length,
    CONVENTIONAL_FDR_Q,
  );
  const files = new Set(tested.slice(0, rejected).map((t) => t.relPath));
  const summary: CompositionTableCut = {
    thresholdMethod: "geometricTailBH",
    q: CONVENTIONAL_FDR_Q,
    nullMean,
    median,
    population: counts.length,
    testedCount: tested.length,
    fileCount: files.size,
  };
  return { files, cut: summary };
}

/**
 * Parent SURFACES (bd tea-rags-mcp-r8hme.52.17): components that stand at the
 * edge of their parent — used from outside it, using its own internals (a
 * domain's `api/` over the domain's models and services). Measured over the
 * component dependencies' file edges, counting distinct files at the far end,
 * as Ca and Ce do:
 *
 * - afferent: the distinct files with an edge into the component; the share
 *   OUTSIDE the parent;
 * - efferent: the distinct files the component has an edge into; the share
 *   INSIDE the parent.
 *
 * Both shares must be a strict majority (> 1/2) — the definition of "most",
 * not a tuned cut: at or below one half the other side is at least as large,
 * so the component is no more a surface than not. The parent is the
 * component's enclosing node in its own tree (`componentAncestry`): a
 * namespace's enclosing constant path — a file is inside it when its
 * component is that namespace or nested in it; a directory's enclosing
 * directory — a file is inside when its path is under it, whatever component
 * holds it. A top-level component has no parent and is never a surface.
 */
export function measureParentSurfaces(
  dependencies: readonly ComponentDependency[],
  componentOf: ReadonlyMap<RelPath, string>,
): ReadonlySet<string> {
  const afferentFiles = new Map<string, Set<RelPath>>();
  const efferentTargets = new Map<string, Set<RelPath>>();
  for (const dependency of dependencies) {
    for (const edge of dependency.fileEdges) {
      addTo(afferentFiles, dependency.targetComponent, edge.sourceRelPath);
      addTo(efferentTargets, dependency.sourceComponent, edge.targetRelPath);
    }
  }

  const surfaces = new Set<string>();
  for (const [component, afferent] of afferentFiles) {
    const efferent = efferentTargets.get(component);
    if (efferent === undefined) continue;
    const insideParent = parentScopeOf(component, componentOf);
    if (insideParent === undefined) continue;
    const outsideShare = countWhere(afferent, (f) => !insideParent(f)) / afferent.size;
    const insideShare = countWhere(efferent, insideParent) / efferent.size;
    if (outsideShare > 1 / 2 && insideShare > 1 / 2) surfaces.add(component);
  }
  return surfaces;
}

/** Whether a file sits inside the component's parent; undefined for a component with no parent. */
function parentScopeOf(
  component: string,
  componentOf: ReadonlyMap<RelPath, string>,
): ((relPath: RelPath) => boolean) | undefined {
  const ancestry = componentAncestry(component);
  if (ancestry.length < 2) return undefined;
  const parent = ancestry[ancestry.length - 2];
  if (isNamespaceComponent(component)) {
    return (relPath) => {
      const fileComponent = componentOf.get(relPath);
      return fileComponent !== undefined && componentAncestry(fileComponent).includes(parent);
    };
  }
  const prefix = `${parent}/`;
  return (relPath) => relPath.startsWith(prefix);
}

function addTo(map: Map<string, Set<RelPath>>, key: string, value: RelPath): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

function countWhere(values: ReadonlySet<RelPath>, predicate: (value: RelPath) => boolean): number {
  let count = 0;
  for (const value of values) if (predicate(value)) count++;
  return count;
}

function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
