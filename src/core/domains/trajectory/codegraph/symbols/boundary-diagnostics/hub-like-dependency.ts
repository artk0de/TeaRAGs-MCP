import type { RelPath } from "../../../../../contracts/types/codegraph.js";
import { resolveMajorityFlooredOtsuThreshold } from "../../../../../primitives/graph/index.js";
import { compilePathPatternMatcher } from "../../../../../primitives/paths/index.js";
import { classifyComponentRelation } from "./constant-namespace.js";
import { MAIN_SEQUENCE_OTSU_MIN_POPULATION } from "./main-sequence.js";
import { DEFAULT_SDP_MIN_CONNECTION_COUNT } from "./stable-dependencies.js";
import type {
  ArchitectureComponent,
  ComponentDependency,
  ComponentGraph,
  DependencyDirectoryRelation,
  HubLikeDependencyAxisCut,
  HubLikeDependencyChurn,
  HubLikeDependencyNeighbour,
  HubLikeDependencyOptions,
  HubLikeDependencyReport,
  HubLikeDependencyScope,
  HubLikeDependencyViolation,
} from "./types.js";

/** Dependents and dependencies listed per hub, heaviest first; the counts keep the totals. */
export const HUB_LIKE_DEPENDENCY_EVIDENCE_LIMIT = 5;

/**
 * Arcan's balance condition: a hub's |Ca − Ce| / (Ca + Ce) stays below 1/4,
 * i.e. I in (0.375, 0.625). A definitional constant of the smell, not a corpus
 * tuning: the busy-but-lopsided component sits at an end of the instability
 * axis, where SDP and the main sequence already judge it, so calling it a hub
 * would report the same component twice under two names (owner, 2026-10-08).
 */
export const HUB_LIKE_DEPENDENCY_MAX_IMBALANCE = 0.25;

/** Same population floor the other boundary detectors trust Otsu's split on. */
export const HUB_LIKE_DEPENDENCY_OTSU_MIN_POPULATION = MAIN_SEQUENCE_OTSU_MIN_POPULATION;

/**
 * Hub-like dependency (bd tea-rags-mcp-r8hme.47, Arcan's smell): a component
 * many depend on that itself depends on many. Its I = Ce / (Ca + Ce) sits near
 * 0.5, so the Stable Dependencies check passes over it and the main sequence
 * may read it as healthy — yet a change on either side ripples through it.
 *
 * Same partition as SDP and the main sequence. A component is judged when its
 * Ca + Ce reaches `minConnectionCount` (the SDP floor: below it neither count
 * says the component is busy). Over the judged population each axis draws its
 * own cut: Otsu's split over log(1 + count), floored at the median count, the
 * floor alone when the population is too small or not bimodal enough (the
 * shared η separability gate) — so "many" means many FOR THIS CODEBASE. A hub
 * clears both cuts. The log scale for the same reason the volatility gate uses
 * it: coupling counts spread multiplicatively, and on the raw scale the one or
 * two largest components carry most of the variance, so Otsu would isolate
 * them and read every merely busy component as typical. log(1 + count) keeps
 * the many components with Ca 0 (entry points) or Ce 0 (sinks) finite.
 * A component clearing both cuts is still no hub unless its coupling is
 * balanced (`HUB_LIKE_DEPENDENCY_MAX_IMBALANCE`); one that is not is counted
 * in `summary.excluded.imbalanced`. Without it the median floors flagged 16 of
 * 60 tea-rags components, infra (I 0.06) and language (I 0.97) among them.
 *
 * Ce counts only dependencies outside `foundationComponents` (bd
 * tea-rags-mcp-g77p3): an edge into the pure-types foundation is no efferent
 * coupling, and counting it made every busy contracts consumer read balanced.
 * Neither axis counts a containment dependency — parent into nested or nested
 * into parent (bd tea-rags-mcp-j5gti): a component only its own child uses,
 * or that only uses its own parent, is composition, not a hub. The connection
 * floor and the reported instability stay the component's. The efferent cut
 * is drawn over the judged components with Ce > 0, the afferent cut over those
 * with Ca > 0 (bd tea-rags-mcp-nxikh).
 *
 * `sourcePathPattern` only decides which judged components are reported; the
 * cuts are whole-graph. `fileVolatility` attaches churn to every hub and never
 * changes a verdict.
 */
export function detectHubLikeDependencies(
  componentGraph: ComponentGraph,
  options: HubLikeDependencyOptions = {},
): HubLikeDependencyReport {
  const cuts = resolveHubLikeDependencyCuts(componentGraph, options);
  const { judged, fanCountsOf, afferent, efferent } = cuts;

  const pathsOf = componentPaths(componentGraph);
  const inScope = compilePathPatternMatcher(options.sourcePathPattern);
  const scope: HubLikeDependencyScope | undefined =
    inScope && options.sourcePathPattern
      ? { sourcePathPattern: options.sourcePathPattern, outOfScopeComponentCount: 0 }
      : undefined;

  const hubs: ArchitectureComponent[] = [];
  let imbalanced = 0;
  for (const component of judged) {
    if (scope && inScope && !(pathsOf.get(component.componentDir) ?? []).some(inScope)) {
      scope.outOfScopeComponentCount++;
      continue;
    }
    const verdict = classifyHubLikeFan(fanCountsOf(component), cuts);
    if (verdict === "hub") hubs.push(component);
    else if (verdict === "imbalanced") imbalanced++;
  }

  const reach = hubs.length > 0 ? new ReverseComponentReach(componentGraph.dependencies) : undefined;
  const violations = hubs.map((hub): HubLikeDependencyViolation => {
    const fan = fanCountsOf(hub);
    const dependents = componentGraph.dependencies.filter((d) => d.targetComponent === hub.componentDir);
    const dependencies = componentGraph.dependencies.filter((d) => d.sourceComponent === hub.componentDir);
    const churn = options.fileVolatility
      ? meanReading(pathsOf.get(hub.componentDir) ?? [], options.fileVolatility)
      : undefined;
    return {
      component: hub.componentDir,
      kind: hub.kind,
      facadeRelPath: hub.facadeRelPath,
      afferentCount: fan.afferentCount,
      efferentCount: fan.efferentCount,
      instability: hub.instability,
      fileCount: hub.fileCount,
      dependentComponentCount: dependents.length,
      dependencyComponentCount: dependencies.length,
      topDependents: heaviest(dependents, (d) => d.sourceComponent),
      topDependencies: heaviest(dependencies, (d) => d.targetComponent),
      transitiveImpact: reach?.countReaching(hub.componentDir) ?? 0,
      ...(churn ? { churn } : {}),
      ...(hub.entryFacade ? { compositionRoot: true as const } : {}),
    };
  });
  violations.sort(
    (a, b) =>
      Math.min(b.afferentCount, b.efferentCount) - Math.min(a.afferentCount, a.efferentCount) ||
      Math.max(b.afferentCount, b.efferentCount) - Math.max(a.afferentCount, a.efferentCount) ||
      compareCodePoints(a.component, b.component),
  );

  return {
    violations,
    summary: {
      componentCount: componentGraph.components.size,
      judgedComponentCount: judged.length,
      violationCount: violations.length,
      minConnectionCount: cuts.minConnectionCount,
      afferent: afferent.summary,
      efferent: efferent.summary,
      excluded: { lowConnectionCount: cuts.lowConnectionCount, imbalanced },
      churnMeasured: options.fileVolatility !== undefined,
      ...(scope ? { scope } : {}),
    },
  };
}

/**
 * A component's coupling as the hub verdict reads it: the hub's Ca and Ce —
 * containment dependencies left out of both (bd tea-rags-mcp-j5gti), the
 * measured foundation out of Ce (bd tea-rags-mcp-g77p3) — and the component's
 * own Ca + Ce the connection floor judges.
 */
export interface HubLikeDependencyFanCounts {
  afferentCount: number;
  efferentCount: number;
  connectionCount: number;
}

/**
 * A read-only view over the whole-repo hub-like verdict (bd
 * tea-rags-mcp-89k7k.1.19.4) for a consumer judging edges the graph never saw
 * — the diff-scoped `hubLike` family. Counts and cuts are the detector's own,
 * drawn once over the whole graph; the view never redraws a cut, so a diff
 * moves a component against the SAME line the report judges it by.
 */
export interface HubLikeDependencyReading {
  /**
   * The component's counts as the hub verdict reads them, plus the detector's
   * own `compositionRoot` stamp; undefined when the graph does not hold it.
   */
  fanCountsOf: (component: string) => (HubLikeDependencyFanCounts & { compositionRoot?: true }) | undefined;
  /** Whether a dependency into the component is left out of the hub's Ce (the measured foundation). */
  isFoundation: (component: string) => boolean;
  /** Whether a dependency between the two is containment (one nested in the other), left out of both axes. */
  isContainment: (sourceComponent: string, targetComponent: string) => boolean;
  /** The detector's verdict on a component at these counts: connection floor, both cuts, balance. */
  isHub: (fan: HubLikeDependencyFanCounts) => boolean;
}

/** The view over `componentGraph`, with the cuts `detectHubLikeDependencies` draws under the same options. */
export function readHubLikeDependency(
  componentGraph: ComponentGraph,
  options: Pick<HubLikeDependencyOptions, "minConnectionCount" | "foundationComponents"> = {},
): HubLikeDependencyReading {
  const cuts = resolveHubLikeDependencyCuts(componentGraph, options);
  const foundation = options.foundationComponents ?? new Set<string>();
  return {
    fanCountsOf: (componentDir) => {
      const component = componentGraph.components.get(componentDir);
      if (component === undefined) return undefined;
      return {
        ...cuts.fanCountsOf(component),
        ...(component.entryFacade ? { compositionRoot: true as const } : {}),
      };
    },
    isFoundation: (componentDir) => foundation.has(componentDir),
    isContainment: (sourceComponent, targetComponent) =>
      isContainmentRelation(classifyComponentRelation(sourceComponent, targetComponent)),
    isHub: (fan) => classifyHubLikeFan(fan, cuts) === "hub",
  };
}

/** The whole-graph inputs of the hub verdict: the judged population and its two axis cuts. */
interface HubLikeDependencyCuts {
  minConnectionCount: number;
  judged: readonly ArchitectureComponent[];
  lowConnectionCount: number;
  fanCountsOf: (component: ArchitectureComponent) => HubLikeDependencyFanCounts;
  afferent: AxisCut;
  efferent: AxisCut;
}

function resolveHubLikeDependencyCuts(
  componentGraph: ComponentGraph,
  options: Pick<HubLikeDependencyOptions, "minConnectionCount" | "foundationComponents">,
): HubLikeDependencyCuts {
  const minConnectionCount = options.minConnectionCount ?? DEFAULT_SDP_MIN_CONNECTION_COUNT;
  const judged: ArchitectureComponent[] = [];
  let lowConnectionCount = 0;
  for (const component of componentGraph.components.values()) {
    if (component.connectionCount < minConnectionCount) lowConnectionCount++;
    else judged.push(component);
  }

  // Both axes read past containment (bd tea-rags-mcp-j5gti), Ce past the
  // foundation too (bd tea-rags-mcp-g77p3); the connection floor stays the
  // component's own. Each cut is drawn over the components with a non-zero
  // count on its axis only: a Ce 0 leaf or a Ca 0 entry is never a hub, and a
  // mass of them would drag the median down to where every busy component
  // clears it (efferent g77p3, afferent bd tea-rags-mcp-nxikh).
  const fanCountsOf = hubFanCounts(componentGraph, options.foundationComponents);
  const judgedFans = judged.map(fanCountsOf);
  return {
    minConnectionCount,
    judged,
    lowConnectionCount,
    fanCountsOf,
    afferent: resolveAxisCut(judgedFans.map((fan) => fan.afferentCount).filter((count) => count > 0)),
    efferent: resolveAxisCut(judgedFans.map((fan) => fan.efferentCount).filter((count) => count > 0)),
  };
}

/** One component's place against the cuts: below the floor, not busy on an axis, busy but lopsided, or a hub. */
function classifyHubLikeFan(
  fan: HubLikeDependencyFanCounts,
  cuts: HubLikeDependencyCuts,
): "lowConnection" | "notBusy" | "imbalanced" | "hub" {
  if (fan.connectionCount < cuts.minConnectionCount) return "lowConnection";
  if (!cuts.afferent.admits(fan.afferentCount) || !cuts.efferent.admits(fan.efferentCount)) return "notBusy";
  return couplingImbalance(fan.afferentCount, fan.efferentCount) < HUB_LIKE_DEPENDENCY_MAX_IMBALANCE
    ? "hub"
    : "imbalanced";
}

/** |Ca − Ce| / (Ca + Ce); zero coupling reads as fully lopsided. */
function couplingImbalance(afferentCount: number, efferentCount: number): number {
  const total = afferentCount + efferentCount;
  return total === 0 ? 1 : Math.abs(afferentCount - efferentCount) / total;
}

/**
 * The hub's counts per component — the component graph's own Ca and Ce
 * (distinct source files) over the dependencies that are not containment (bd
 * tea-rags-mcp-j5gti), Ce also without those into `foundationComponents` (bd
 * tea-rags-mcp-g77p3). A file reaching an excluded component AND anything else
 * still counts once.
 */
function hubFanCounts(
  componentGraph: ComponentGraph,
  foundationComponents: ReadonlySet<string> | undefined,
): (component: ArchitectureComponent) => HubLikeDependencyFanCounts {
  const afferentFiles = new Map<string, Set<RelPath>>();
  const efferentFiles = new Map<string, Set<RelPath>>();
  const addSourceFiles = (into: Map<string, Set<RelPath>>, component: string, dependency: ComponentDependency) => {
    const files = into.get(component) ?? new Set<RelPath>();
    for (const edge of dependency.fileEdges) files.add(edge.sourceRelPath);
    into.set(component, files);
  };
  for (const dependency of componentGraph.dependencies) {
    if (isContainmentRelation(dependency.directoryRelation)) continue;
    addSourceFiles(afferentFiles, dependency.targetComponent, dependency);
    if (foundationComponents?.has(dependency.targetComponent)) continue;
    addSourceFiles(efferentFiles, dependency.sourceComponent, dependency);
  }
  return (component) => ({
    afferentCount: afferentFiles.get(component.componentDir)?.size ?? 0,
    efferentCount: efferentFiles.get(component.componentDir)?.size ?? 0,
    connectionCount: component.connectionCount,
  });
}

/** A parent↔nested dependency, either direction. */
function isContainmentRelation(relation: DependencyDirectoryRelation): boolean {
  return relation === "descendant" || relation === "ancestor";
}

interface AxisCut {
  summary: HubLikeDependencyAxisCut;
  admits: (count: number) => boolean;
}

/** Otsu over log(1 + count), floored at the median count — reported back on the count scale. */
function resolveAxisCut(counts: readonly number[]): AxisCut {
  const median = medianOf(counts);
  const cut = resolveMajorityFlooredOtsuThreshold(counts.map(Math.log1p), {
    majority: Math.log1p(median),
    minPopulation: HUB_LIKE_DEPENDENCY_OTSU_MIN_POPULATION,
  });
  return {
    summary: {
      threshold: cut.method === "otsu" ? Math.expm1(cut.threshold) : median,
      thresholdMethod: cut.method === "otsu" ? "otsu" : "median",
      ...(cut.separability !== undefined ? { separability: cut.separability } : {}),
      median,
    },
    admits: (count) => cut.admits(Math.log1p(count)),
  };
}

/**
 * Components that reach a target through component dependencies, counted by a
 * reverse breadth-first walk — the component-level reading of the file
 * signal `transitiveImpact`.
 */
class ReverseComponentReach {
  private readonly dependentsOf = new Map<string, string[]>();

  constructor(dependencies: readonly ComponentDependency[]) {
    for (const d of dependencies) {
      const list = this.dependentsOf.get(d.targetComponent) ?? [];
      list.push(d.sourceComponent);
      this.dependentsOf.set(d.targetComponent, list);
    }
  }

  countReaching(target: string): number {
    const seen = new Set<string>([target]);
    const queue = [target];
    // An array iterator visits elements pushed during the walk: a BFS queue.
    for (const current of queue) {
      for (const dependent of this.dependentsOf.get(current) ?? []) {
        if (seen.has(dependent)) continue;
        seen.add(dependent);
        queue.push(dependent);
      }
    }
    return seen.size - 1;
  }
}

function heaviest(
  dependencies: readonly ComponentDependency[],
  neighbourOf: (dependency: ComponentDependency) => string,
): HubLikeDependencyNeighbour[] {
  return dependencies
    .map(
      (dependency): HubLikeDependencyNeighbour => ({
        component: neighbourOf(dependency),
        directoryRelation: dependency.directoryRelation,
        fileEdgeCount: dependency.fileEdges.length,
        callWeight: dependency.callWeight,
      }),
    )
    .sort(
      (a, b) =>
        b.fileEdgeCount - a.fileEdgeCount || b.callWeight - a.callWeight || compareCodePoints(a.component, b.component),
    )
    .slice(0, HUB_LIKE_DEPENDENCY_EVIDENCE_LIMIT);
}

function meanReading(
  relPaths: readonly RelPath[],
  fileVolatility: ReadonlyMap<RelPath, number>,
): HubLikeDependencyChurn | undefined {
  let sum = 0;
  let measuredFileCount = 0;
  for (const relPath of relPaths) {
    const reading = fileVolatility.get(relPath);
    if (reading === undefined) continue;
    sum += reading;
    measuredFileCount++;
  }
  return measuredFileCount > 0 ? { value: sum / measuredFileCount, measuredFileCount } : undefined;
}

function componentPaths(componentGraph: ComponentGraph): Map<string, RelPath[]> {
  const out = new Map<string, RelPath[]>();
  for (const [relPath, componentDir] of componentGraph.componentOf) {
    const list = out.get(componentDir) ?? [];
    list.push(relPath);
    out.set(componentDir, list);
  }
  return out;
}

/** 0 for an empty population: nothing judged, nothing admitted below it either. */
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
