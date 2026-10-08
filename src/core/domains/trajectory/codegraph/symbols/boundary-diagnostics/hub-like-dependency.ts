import type { RelPath } from "../../../../../contracts/types/codegraph.js";
import { resolveMajorityFlooredOtsuThreshold } from "../../../../../infra/graph/index.js";
import { compilePathPatternMatcher } from "../../../../../infra/path-pattern.js";
import { isDeclaredCompositionRoot } from "./component-stable-dependencies.js";
import { MAIN_SEQUENCE_OTSU_MIN_POPULATION } from "./main-sequence.js";
import { DEFAULT_SDP_MIN_CONNECTION_COUNT } from "./stable-dependencies.js";
import type {
  ArchitectureComponent,
  ComponentDependency,
  ComponentGraph,
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
 *
 * `sourcePathPattern` only decides which judged components are reported; the
 * cuts are whole-graph. `fileVolatility` attaches churn to every hub and never
 * changes a verdict.
 */
export function detectHubLikeDependencies(
  componentGraph: ComponentGraph,
  options: HubLikeDependencyOptions = {},
): HubLikeDependencyReport {
  const minConnectionCount = options.minConnectionCount ?? DEFAULT_SDP_MIN_CONNECTION_COUNT;
  const judged: ArchitectureComponent[] = [];
  let lowConnectionCount = 0;
  for (const component of componentGraph.components.values()) {
    if (component.connectionCount < minConnectionCount) lowConnectionCount++;
    else judged.push(component);
  }

  const afferent = resolveAxisCut(judged.map((c) => c.afferentCount));
  const efferent = resolveAxisCut(judged.map((c) => c.efferentCount));

  const pathsOf = componentPaths(componentGraph);
  const inScope = compilePathPatternMatcher(options.sourcePathPattern);
  const scope: HubLikeDependencyScope | undefined =
    inScope && options.sourcePathPattern
      ? { sourcePathPattern: options.sourcePathPattern, outOfScopeComponentCount: 0 }
      : undefined;

  const hubs: ArchitectureComponent[] = [];
  for (const component of judged) {
    if (scope && inScope && !(pathsOf.get(component.componentDir) ?? []).some(inScope)) {
      scope.outOfScopeComponentCount++;
      continue;
    }
    if (afferent.admits(component.afferentCount) && efferent.admits(component.efferentCount)) hubs.push(component);
  }

  const reach = hubs.length > 0 ? new ReverseComponentReach(componentGraph.dependencies) : undefined;
  const violations = hubs.map((hub): HubLikeDependencyViolation => {
    const dependents = componentGraph.dependencies.filter((d) => d.targetComponent === hub.componentDir);
    const dependencies = componentGraph.dependencies.filter((d) => d.sourceComponent === hub.componentDir);
    const churn = options.fileVolatility
      ? meanReading(pathsOf.get(hub.componentDir) ?? [], options.fileVolatility)
      : undefined;
    return {
      component: hub.componentDir,
      kind: hub.kind,
      facadeRelPath: hub.facadeRelPath,
      afferentCount: hub.afferentCount,
      efferentCount: hub.efferentCount,
      instability: hub.instability,
      fileCount: hub.fileCount,
      dependentComponentCount: dependents.length,
      dependencyComponentCount: dependencies.length,
      topDependents: heaviest(dependents, (d) => d.sourceComponent),
      topDependencies: heaviest(dependencies, (d) => d.targetComponent),
      transitiveImpact: reach?.countReaching(hub.componentDir) ?? 0,
      ...(churn ? { churn } : {}),
      ...(isDeclaredCompositionRoot(hub.componentDir) ? { compositionRoot: true as const } : {}),
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
      minConnectionCount,
      afferent: afferent.summary,
      efferent: efferent.summary,
      excluded: { lowConnectionCount },
      churnMeasured: options.fileVolatility !== undefined,
      ...(scope ? { scope } : {}),
    },
  };
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
