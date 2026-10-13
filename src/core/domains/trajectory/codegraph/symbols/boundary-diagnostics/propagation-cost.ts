/**
 * Propagation cost (bd tea-rags-mcp-r8hme.49): MacCormack, Rusnak & Baldwin's
 * DSM measure — the density of the reflexive transitive closure of the file
 * dependency matrix, i.e. the mean share of the system a change to one file
 * can ripple into. Alongside it the Baldwin–MacCormack core-periphery reading
 * of visibility: every file's visibility fan-in (files reaching it — what a
 * change to it can affect) and fan-out (files it reaches — what it can be
 * affected by), cut on each axis by a threshold drawn from the population.
 *
 * Classes (Baldwin, MacCormack & Rusnak 2014):
 *  - core       — high on BOTH axes AND a member of a dependency cycle. The
 *                 paper's core is the largest cyclic group; an acyclic file
 *                 high on both axes is a hierarchy's waist, not a core, and is
 *                 counted apart (`acyclicHighVisibilityFileCount`). Any cyclic
 *                 group clearing both cuts qualifies, not only the largest:
 *                 picking one would need a size cut nothing here can derive.
 *  - shared     — high fan-in only (depended on, depends on little);
 *  - control    — high fan-out only (depends on much, little depends on it);
 *  - peripheral — neither.
 * Shape (bd tea-rags-mcp-j9kjf):
 *  - indeterminate — either cut fell back to its median floor (Otsu's eta below
 *                    the separability gate, or too few files): the visibility
 *                    distribution gives no evidence of a split, so neither a
 *                    core-periphery nor a hierarchical reading is supported;
 *  - corePeriphery — both cuts are Otsu and a core exists;
 *  - hierarchical  — both cuts are Otsu and no core exists.
 *
 * Cost: one exact closure via {@link transitiveVisibility} — SCC condensation
 * plus bitset rows — and one per component over its induced sub-graph.
 */
import type { FileDependencyGraph, RelPath } from "../../../../../contracts/types/codegraph.js";
import { resolveMajorityFlooredOtsuThreshold, transitiveVisibility } from "../../../../../primitives/graph/index.js";

/** Same population floor the other boundary detectors trust Otsu's split on. */
export const PROPAGATION_COST_OTSU_MIN_POPULATION = 8;

interface PropagationCostVisibilityCut {
  /** `otsu` = a bimodal split above the median; `majority` = the median fallback. */
  method: "otsu" | "majority";
  /** A file is high on this axis when its visibility is ≥ threshold and strictly above the median. */
  threshold: number;
  separability?: number;
}

interface PropagationCostComponent {
  component: string;
  fileCount: number;
  /** Closure density of the component's induced sub-graph — its internal propagation cost. */
  propagationCost: number;
  /** Mean share of the WHOLE system a change to one of its files can reach (Σ fan-in / (n·N)). */
  meanReach: number;
  coreFileCount: number;
}

type PropagationCostShape = "corePeriphery" | "hierarchical" | "indeterminate";

interface PropagationCostReport {
  fileCount: number;
  /** Distinct file → file dependencies between walked files, self-edges excluded. */
  edgeCount: number;
  /** Reachable (reflexive) pairs / N² — 0 for an empty graph. */
  propagationCost: number;
  /** Largest dependency cycle, in files (1 when acyclic, 0 when empty). */
  largestCycleSize: number;
  corePeriphery: {
    shape: PropagationCostShape;
    /** core / N. */
    coreShare: number;
    counts: { core: number; shared: number; control: number; peripheral: number };
    /** High on both axes but in no cycle — kept out of the four classes above. */
    acyclicHighVisibilityFileCount: number;
    visibilityFanIn: PropagationCostVisibilityCut;
    visibilityFanOut: PropagationCostVisibilityCut;
  };
  /** Per component of `options.componentOf`, by `meanReach` desc then name; empty without a partition. */
  components: PropagationCostComponent[];
  /**
   * Per walked file, the files reaching it — itself included — the population
   * `corePeriphery.visibilityFanIn` is cut over. Exact, never depth-capped
   * (bd tea-rags-mcp-r8hme.53 reads it as a file's reach).
   */
  fileVisibilityFanIn: ReadonlyMap<RelPath, number>;
  /** Whether a visibility fan-in clears `corePeriphery.visibilityFanIn`'s cut — at or above the threshold AND above the median. */
  admitsVisibilityFanIn: (fanIn: number) => boolean;
}

interface PropagationCostOptions {
  /** File → component; unmapped files belong to no component. */
  componentOf?: ReadonlyMap<RelPath, string>;
}

type FileVisibilityClass = "core" | "shared" | "control" | "peripheral" | "acyclicHighVisibility";

export function computePropagationCost(
  graph: FileDependencyGraph,
  options: PropagationCostOptions = {},
): PropagationCostReport {
  const adjacency = fileAdjacency(graph);
  const fileCount = adjacency.size;
  let edgeCount = 0;
  for (const targets of adjacency.values()) edgeCount += targets.length;
  const visibility = transitiveVisibility(adjacency);
  const files = [...adjacency.keys()];
  const fanInCut = resolveVisibilityCut(files.map((f) => visibility.fanIn.get(f) as number));
  const fanOutCut = resolveVisibilityCut(files.map((f) => visibility.fanOut.get(f) as number));

  const classOf = new Map<RelPath, FileVisibilityClass>();
  const counts = { core: 0, shared: 0, control: 0, peripheral: 0 };
  let acyclicHighVisibilityFileCount = 0;
  for (const relPath of files) {
    const highIn = fanInCut.admits(visibility.fanIn.get(relPath) as number);
    const highOut = fanOutCut.admits(visibility.fanOut.get(relPath) as number);
    const cyclic = (visibility.sccSize.get(relPath) as number) > 1;
    const cls: FileVisibilityClass =
      highIn && highOut
        ? cyclic
          ? "core"
          : "acyclicHighVisibility"
        : highIn
          ? "shared"
          : highOut
            ? "control"
            : "peripheral";
    classOf.set(relPath, cls);
    if (cls === "acyclicHighVisibility") acyclicHighVisibilityFileCount++;
    else counts[cls]++;
  }
  return {
    fileCount,
    edgeCount,
    propagationCost: closureDensity(visibility.reachablePairCount, fileCount),
    largestCycleSize: visibility.largestSccSize,
    corePeriphery: {
      shape: propagationCostShape(fanInCut.summary, fanOutCut.summary, counts.core),
      coreShare: fileCount === 0 ? 0 : counts.core / fileCount,
      counts,
      acyclicHighVisibilityFileCount,
      visibilityFanIn: fanInCut.summary,
      visibilityFanOut: fanOutCut.summary,
    },
    components: options.componentOf
      ? componentBreakdown(adjacency, options.componentOf, visibility.fanIn, classOf)
      : [],
    fileVisibilityFanIn: visibility.fanIn,
    admitsVisibilityFanIn: fanInCut.admits,
  };
}

/** A floored cut is no evidence either way; only two Otsu cuts let the core decide. */
function propagationCostShape(
  fanIn: PropagationCostVisibilityCut,
  fanOut: PropagationCostVisibilityCut,
  coreFileCount: number,
): PropagationCostShape {
  if (fanIn.method === "majority" || fanOut.method === "majority") return "indeterminate";
  return coreFileCount > 0 ? "corePeriphery" : "hierarchical";
}

/** Deduplicated walked-file adjacency: no self-edges, no edge to a file outside the graph. */
function fileAdjacency(graph: FileDependencyGraph): Map<RelPath, RelPath[]> {
  const targetsOf = new Map<RelPath, Set<RelPath>>(graph.files.map((f) => [f.relPath, new Set()]));
  for (const e of graph.edges) {
    if (e.sourceRelPath === e.targetRelPath || !targetsOf.has(e.targetRelPath)) continue;
    targetsOf.get(e.sourceRelPath)?.add(e.targetRelPath);
  }
  return new Map([...targetsOf].map(([relPath, targets]) => [relPath, [...targets]]));
}

function closureDensity(reachablePairCount: number, nodeCount: number): number {
  return nodeCount === 0 ? 0 : reachablePairCount / (nodeCount * nodeCount);
}

interface VisibilityCut {
  summary: PropagationCostVisibilityCut;
  admits: (visibility: number) => boolean;
}

/** Otsu over the visibility counts, floored at their median. */
function resolveVisibilityCut(values: readonly number[]): VisibilityCut {
  const cut = resolveMajorityFlooredOtsuThreshold(values, {
    majority: medianOf(values),
    minPopulation: PROPAGATION_COST_OTSU_MIN_POPULATION,
  });
  return {
    summary: {
      method: cut.method,
      threshold: cut.threshold,
      ...(cut.separability !== undefined ? { separability: cut.separability } : {}),
    },
    admits: cut.admits,
  };
}

function componentBreakdown(
  adjacency: ReadonlyMap<RelPath, readonly RelPath[]>,
  componentOf: ReadonlyMap<RelPath, string>,
  systemFanIn: ReadonlyMap<RelPath, number>,
  classOf: ReadonlyMap<RelPath, FileVisibilityClass>,
): PropagationCostComponent[] {
  const membersOf = new Map<string, RelPath[]>();
  for (const relPath of adjacency.keys()) {
    const component = componentOf.get(relPath);
    if (component === undefined) continue;
    const members = membersOf.get(component) ?? [];
    members.push(relPath);
    membersOf.set(component, members);
  }
  const systemSize = adjacency.size;
  const rows: PropagationCostComponent[] = [];
  for (const [component, members] of membersOf) {
    const inside = new Set(members);
    const induced = new Map(
      members.map((m) => [m, (adjacency.get(m) as readonly RelPath[]).filter((t) => inside.has(t))]),
    );
    let fanInSum = 0;
    let coreFileCount = 0;
    for (const m of members) {
      fanInSum += systemFanIn.get(m) as number;
      if (classOf.get(m) === "core") coreFileCount++;
    }
    rows.push({
      component,
      fileCount: members.length,
      propagationCost: closureDensity(transitiveVisibility(induced).reachablePairCount, members.length),
      meanReach: fanInSum / (members.length * systemSize),
      coreFileCount,
    });
  }
  return rows.sort((a, b) => b.meanReach - a.meanReach || compareCodePoints(a.component, b.component));
}

/** 0 for an empty population. */
function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Locale-independent, so the order is the same on every machine. */
function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
