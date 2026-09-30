import type { FileDependencyEdge, FileDependencyGraphFile } from "../../../../../contracts/types/codegraph.js";
import { tarjanScc } from "../../../../../infra/graph/tarjan-scc.js";
import { COMPONENT_EVIDENCE_FILE_EDGE_LIMIT } from "./component-stable-dependencies.js";
import { DEFAULT_MAIN_SEQUENCE_MIN_TYPE_COUNT } from "./main-sequence.js";
import type {
  ComponentDependency,
  ComponentGraph,
  LayeringAbstractionBypassViolation,
  LayeringBackEdgeViolation,
  LayeringComponentPosition,
  LayeringFeedbackEdge,
  LayeringIslandViolation,
  LayeringKnot,
  LayeringLayerSkipViolation,
  LayeringModel,
  LayeringReport,
  LayeringSummary,
  LayeringViolation,
} from "./types.js";

/**
 * A component must hold at least the main-sequence type floor before its
 * abstractness decides an abstraction bypass: below 5 a single type moves A by
 * 0.2 or more — the whole distance between concrete and abstract.
 */
const BYPASS_MIN_TYPE_COUNT = DEFAULT_MAIN_SEQUENCE_MIN_TYPE_COUNT;

/** A component at or below this share of abstract types counts as concrete. */
const BYPASS_CONCRETE_MAX_ABSTRACTNESS = 0.5;

/** A component at or above this share of abstract types counts as the abstraction beneath. */
const BYPASS_ABSTRACT_MIN_ABSTRACTNESS = 0.5;

/** A dependency jumping this many levels or more straight down is a layer skip. */
const LAYER_SKIP_MIN_LEVELS = 2;

/**
 * Inferred layering without a declared architecture (bd tea-rags-mcp-r8hme.22)
 * — report-time, no indexing change. The component graph is condensed by SCC
 * (Tarjan, the same primitive `find_cycles` persists); levels run by longest
 * path over the condensation, L0 the foundation the rest of the stack depends
 * on. Every knot carries a greedy weighted feedback arc set (Eades–Lin–Smyth)
 * naming the edges whose cut buys levels. Coverage is the share of components
 * outside non-trivial SCCs; coherence, the rank correlation of level vs
 * instability — a real stack is monotone (stable below, unstable above),
 * spaghetti reads flat or negative.
 *
 * Every component gets a position; one with no layering edge sits at level 0,
 * depth 0. A low component nothing depends on is reported as a detached island
 * by the detector — `height` alone would have called it a foundation.
 */
export function buildLayeringModel(componentGraph: ComponentGraph): LayeringModel {
  const edges = componentGraph.dependencies;
  const sccs = tarjanScc(adjacency(edges));
  const knotOf = new Map<string, number>();
  sccs.forEach((members, index) => {
    members.forEach((member) => knotOf.set(member, index));
  });
  const condensation = condense(edges, knotOf);
  const nodes = nodesOf(condensation, knotOf);
  const level = longestPath(nodes, condensation.outgoing);
  const depth = longestPath(nodes, condensation.incoming);

  const positionOf = (component: string): LayeringComponentPosition => {
    const knot = knotOf.get(component);
    const node = knot === undefined ? component : knotNode(knot);
    return { level: level.get(node) ?? 0, depth: depth.get(node) ?? 0, inKnot: knot !== undefined };
  };
  const positions = new Map<string, LayeringComponentPosition>(
    [...componentGraph.components.keys()].map((component) => [component, positionOf(component)]),
  );

  const knots = sccs.map((members) => buildKnot(componentGraph, members)).sort(byMemberCountThenMembers);

  return {
    positions,
    // Distinct levels, 0-based: maxLevel is the highest index, the count is
    // one past it — 0 when the graph holds no layering edge at all.
    levelCount: componentGraph.dependencies.length === 0 ? 0 : maxOver(nodes, level) + 1,
    knots,
    coverage: coverage(componentGraph, knotOf),
    coherence: coherence(componentGraph, positions),
  };
}

/**
 * The layering findings over the model: knots, the minority-weight back-edges
 * inside them and abstraction bypasses are violations; composition cycles,
 * detached islands and layer skips are informational — same shape, so the
 * diff-scoped review and the cost ranking treat every finding uniformly.
 */
export function detectLayeringViolations(
  componentGraph: ComponentGraph,
  files: readonly FileDependencyGraphFile[],
): LayeringReport {
  const model = buildLayeringModel(componentGraph);
  const compositionKnots = model.knots.filter((knot) => knot.composition);
  const realKnots = model.knots.filter((knot) => !knot.composition);

  const violations: LayeringViolation[] = [
    ...realKnots.map(
      (knot): LayeringViolation => ({
        kind: "knot",
        components: knot.components,
        feedbackArcSet: knot.feedbackArcSet,
        cutEdgeCount: knot.cutEdgeCount,
        levelsAfterCut: knot.levelsAfterCut,
      }),
    ),
    ...backEdges(componentGraph, realKnots),
    ...abstractionBypasses(componentGraph, files, knotMemberSets(model)),
    ...compositionKnots.map(
      (knot): LayeringViolation => ({
        kind: "compositionCycle",
        components: knot.components,
        nestedPairs: nestedPairs(componentGraph, knot.components),
      }),
    ),
    ...islands(componentGraph, model),
    ...layerSkips(componentGraph, model),
  ];

  const count = (kind: LayeringViolation["kind"]) => violations.filter((v) => v.kind === kind).length;
  const summary: LayeringSummary = {
    componentCount: componentGraph.components.size,
    componentEdgeCount: componentGraph.dependencies.length,
    levelCount: model.levelCount,
    coverage: model.coverage,
    coherence: model.coherence,
    knotCount: realKnots.length,
    backEdgeCount: count("backEdge"),
    abstractionBypassCount: count("abstractionBypass"),
    compositionCycleCount: compositionKnots.length,
    islandCount: count("island"),
    layerSkipCount: count("layerSkip"),
    violationCount: violations.length,
  };
  return { violations, summary };
}

function adjacency(dependencies: readonly ComponentDependency[]): Map<string, readonly string[]> {
  const out = new Map<string, string[]>();
  for (const dependency of dependencies) {
    const targets = out.get(dependency.sourceComponent) ?? [];
    if (!targets.includes(dependency.targetComponent)) targets.push(dependency.targetComponent);
    out.set(dependency.sourceComponent, targets);
  }
  return out;
}

/** Condensation node name for SCC #index — NUL keeps it disjoint from every component path. */
function knotNode(index: number): string {
  return `\u0000knot${index}`;
}

/**
 * The condensation of the component graph: every knot collapses to one node
 * named `knotNode(index)`, every other component stands for itself.
 */
function condense(
  dependencies: readonly ComponentDependency[],
  knotOf: Map<string, number>,
): { outgoing: Map<string, string[]>; incoming: Map<string, string[]> } {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  const nodeOf = (component: string) => {
    const knot = knotOf.get(component);
    return knot === undefined ? component : knotNode(knot);
  };
  const link = (map: Map<string, string[]>, from: string, to: string) => {
    if (from === to) return;
    const targets = map.get(from) ?? [];
    if (!targets.includes(to)) targets.push(to);
    map.set(from, targets);
  };
  for (const dependency of dependencies) {
    link(outgoing, nodeOf(dependency.sourceComponent), nodeOf(dependency.targetComponent));
    link(incoming, nodeOf(dependency.targetComponent), nodeOf(dependency.sourceComponent));
  }
  return { outgoing, incoming };
}

function nodesOf(
  condensation: { outgoing: Map<string, string[]>; incoming: Map<string, string[]> },
  knotOf: Map<string, number>,
): string[] {
  // BOTH directions: the level walk reaches sinks only by recursion from
  // above, the depth walk reaches them never — seed every node that appears
  // on either side so both maps answer for every component.
  return [
    ...new Set([
      ...condensation.outgoing.keys(),
      ...condensation.incoming.keys(),
      ...[...knotOf.keys()].map((_, index) => knotNode(index)),
    ]),
  ];
}

/**
 * Longest path over the condensation, memoized DFS: 0 for a node with no
 * outgoing (no incoming) edges, else 1 + the deepest successor (predecessor).
 * The condensation is acyclic by construction; the pre-set memo only breaks a
 * hypothetical cycle instead of looping forever.
 */
function longestPath(nodes: readonly string[], next: Map<string, string[]>): Map<string, number> {
  const memo = new Map<string, number>();
  const resolve = (node: string): number => {
    const cached = memo.get(node);
    if (cached !== undefined) return cached;
    memo.set(node, 0);
    const successors = next.get(node) ?? [];
    const value = successors.length === 0 ? 0 : 1 + Math.max(...successors.map(resolve));
    memo.set(node, value);
    return value;
  };
  nodes.forEach(resolve);
  return memo;
}

function maxOver(nodes: readonly string[], level: Map<string, number>): number {
  return nodes.reduce((max, node) => Math.max(max, level.get(node) ?? 0), 0);
}

/** Share of components outside non-trivial SCCs, over all; 0 for an empty graph. */
function coverage(componentGraph: ComponentGraph, knotOf: Map<string, number>): number {
  const total = componentGraph.components.size;
  if (total === 0) return 0;
  let outside = 0;
  for (const component of componentGraph.components.keys()) {
    if (!knotOf.has(component)) outside++;
  }
  return outside / total;
}

/**
 * Spearman rank correlation of level vs instability over the components a
 * layering edge touches, as Pearson over average ranks (the tie-corrected
 * form); 0 under two such components or when either side is constant.
 */
function coherence(componentGraph: ComponentGraph, positions: Map<string, LayeringComponentPosition>): number {
  const pairs: { level: number; instability: number }[] = [];
  for (const [component, position] of positions) {
    const c = componentGraph.components.get(component);
    if (c && (c.afferentCount > 0 || c.efferentCount > 0)) {
      pairs.push({ level: position.level, instability: c.instability });
    }
  }
  if (pairs.length < 2) return 0;
  return pearson(averageRanks(pairs.map((p) => p.level)), averageRanks(pairs.map((p) => p.instability)));
}

function averageRanks(values: readonly number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].value === order[i].value) j++;
    const average = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k].index] = average;
    i = j + 1;
  }
  return ranks;
}

function pearson(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  const meanX = xs.reduce((s, x) => s + x, 0) / n;
  const meanY = ys.reduce((s, y) => s + y, 0) / n;
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (let i = 0; i < n; i++) {
    covariance += (xs[i] - meanX) * (ys[i] - meanY);
    varianceX += (xs[i] - meanX) ** 2;
    varianceY += (ys[i] - meanY) ** 2;
  }
  if (varianceX === 0 || varianceY === 0) return 0;
  return covariance / Math.sqrt(varianceX * varianceY);
}

/**
 * One knot: members ranked by Ca, the greedy weighted feedback arc set that
 * dissolves it, and how many levels the members occupy once it is cut. A knot
 * whose every internal edge joins a directory to one nested inside it is
 * composition — a module and its own sub-parts, not a layering defect.
 *
 * `levelsAfterCut` re-runs the whole condensation with the cut applied, so
 * other knots stay condensed and the number is a level count the members
 * really reach, not a wish.
 */
function buildKnot(componentGraph: ComponentGraph, members: readonly string[]): LayeringKnot {
  const memberSet = new Set(members);
  const internal = componentGraph.dependencies.filter(
    (d) => memberSet.has(d.sourceComponent) && memberSet.has(d.targetComponent),
  );
  const byCa = (a: string, b: string) =>
    (componentGraph.components.get(b)?.afferentCount ?? 0) - (componentGraph.components.get(a)?.afferentCount ?? 0) ||
    compareCodePoints(a, b);

  const feedbackArcSet = eadesLinSmyth(internal);
  const cut = new Set(feedbackArcSet.map((edge) => `${edge.sourceComponent}\u0000${edge.targetComponent}`));
  const withoutCut = componentGraph.dependencies.filter(
    (d) => !cut.has(`${d.sourceComponent}\u0000${d.targetComponent}`),
  );
  const dissolvedLevel = levelsAfterCutOf(withoutCut);

  return {
    components: [...members].sort(byCa),
    feedbackArcSet,
    cutEdgeCount: feedbackArcSet.length,
    levelsAfterCut: new Set(members.map(dissolvedLevel)).size,
    composition: internal.every((d) => d.directoryRelation === "descendant" || d.directoryRelation === "ancestor"),
  };
}

/**
 * The levels of the FULL graph with `cutEdges` removed: re-run Tarjan (the cut
 * dissolves this knot; other knots re-condense), then the longest path. Every
 * component — knot member or not — answers with the level it would sit at.
 */
function levelsAfterCutOf(dependencies: readonly ComponentDependency[]): (component: string) => number {
  const postSccs = tarjanScc(adjacency(dependencies));
  const postKnotOf = new Map<string, number>();
  postSccs.forEach((members, index) => {
    members.forEach((member) => postKnotOf.set(member, index));
  });
  const postCondensation = condense(dependencies, postKnotOf);
  const postLevel = longestPath(nodesOf(postCondensation, postKnotOf), postCondensation.outgoing);
  return (component: string) => {
    const knot = postKnotOf.get(component);
    return postLevel.get(knot === undefined ? component : knotNode(knot)) ?? 0;
  };
}

/**
 * Eades–Lin–Smyth over one knot's internal edges, weighted by call weight:
 * peel sinks to the sequence's end and sources to its front, else remove the
 * vertex with the largest weighted out-degree minus in-degree. The feedback
 * arc set is every edge pointing from later to earlier in the final sequence —
 * removing it leaves the sequence a topological order. Ties break by path, so
 * the cut is deterministic.
 */
function eadesLinSmyth(internal: readonly ComponentDependency[]): LayeringFeedbackEdge[] {
  const position = new Map<string, number>();
  const remaining = new Set(internal.flatMap((d) => [d.sourceComponent, d.targetComponent]));
  const sequence: string[] = [];
  const liveOut = (node: string) =>
    internal.some((d) => d.sourceComponent === node && remaining.has(d.targetComponent));
  const liveIn = (node: string) => internal.some((d) => d.targetComponent === node && remaining.has(d.sourceComponent));
  const weightDelta = (node: string) => {
    let outWeight = 0;
    let inWeight = 0;
    for (const d of internal) {
      if (!remaining.has(d.sourceComponent) || !remaining.has(d.targetComponent)) continue;
      if (d.sourceComponent === node) outWeight += d.callWeight;
      if (d.targetComponent === node) inWeight += d.callWeight;
    }
    return outWeight - inWeight;
  };

  while (remaining.size > 0) {
    let moved = true;
    while (moved && remaining.size > 0) {
      moved = false;
      for (const node of [...remaining].sort(compareCodePoints)) {
        if (liveOut(node) && liveIn(node)) continue;
        if (!liveOut(node)) sequence.push(node);
        else sequence.unshift(node);
        remaining.delete(node);
        moved = true;
      }
    }
    if (remaining.size === 0) break;
    let best: string | undefined;
    let bestDelta = Number.NEGATIVE_INFINITY;
    for (const node of [...remaining].sort(compareCodePoints)) {
      const delta = weightDelta(node);
      if (delta > bestDelta) {
        bestDelta = delta;
        best = node;
      }
    }
    if (best === undefined) break;
    remaining.delete(best);
    sequence.push(best);
  }
  sequence.forEach((node, index) => position.set(node, index));

  return internal
    .filter((d) => (position.get(d.sourceComponent) ?? 0) > (position.get(d.targetComponent) ?? 0))
    .map((d) => ({
      sourceComponent: d.sourceComponent,
      targetComponent: d.targetComponent,
      callWeight: d.callWeight,
      fileEdges: cappedFileEdges(d.fileEdges),
    }))
    .sort(
      (a, b) =>
        b.callWeight - a.callWeight ||
        compareCodePoints(a.sourceComponent, b.sourceComponent) ||
        compareCodePoints(a.targetComponent, b.targetComponent),
    );
}

/**
 * Inside one knot, the pairs whose weights disagree: the minority direction is
 * the back-edge, with the majority weight as its evidence. Equal weights are
 * ambiguous — never guessed.
 */
function backEdges(componentGraph: ComponentGraph, knots: readonly LayeringKnot[]): LayeringBackEdgeViolation[] {
  const knotMembers = new Set(knots.flatMap((knot) => knot.components));
  const byPair = new Map<string, ComponentDependency[]>();
  for (const dependency of componentGraph.dependencies) {
    if (!knotMembers.has(dependency.sourceComponent) || !knotMembers.has(dependency.targetComponent)) continue;
    const key = [dependency.sourceComponent, dependency.targetComponent].sort(compareCodePoints).join("\u0000");
    byPair.set(key, [...(byPair.get(key) ?? []), dependency]);
  }

  const findings: LayeringBackEdgeViolation[] = [];
  for (const directions of byPair.values()) {
    if (directions.length !== 2) continue;
    const [a, b] = directions;
    if (a.callWeight === b.callWeight) continue;
    const back = a.callWeight < b.callWeight ? a : b;
    const forward = a.callWeight < b.callWeight ? b : a;
    findings.push({
      kind: "backEdge",
      sourceComponent: back.sourceComponent,
      targetComponent: back.targetComponent,
      callWeight: back.callWeight,
      counterFlowWeight: forward.callWeight,
      fileEdgeCount: back.fileEdges.length,
      fileEdges: cappedFileEdges(back.fileEdges),
    });
  }
  return findings.sort(
    (x, y) =>
      y.callWeight - x.callWeight ||
      compareCodePoints(x.sourceComponent, y.sourceComponent) ||
      compareCodePoints(x.targetComponent, y.targetComponent),
  );
}

function cappedFileEdges(fileEdges: readonly FileDependencyEdge[]): FileDependencyEdge[] {
  return [...fileEdges]
    .sort((a, b) => b.callWeight - a.callWeight || compareCodePoints(a.sourceRelPath, b.sourceRelPath))
    .slice(0, COMPONENT_EVIDENCE_FILE_EDGE_LIMIT);
}

function knotMemberSets(model: LayeringModel): (a: string, b: string) => boolean {
  const memberSets = model.knots.map((knot) => new Set(knot.components));
  return (a, b) => memberSets.some((set) => set.has(a) && set.has(b));
}

/**
 * DIP bypasses: a consumer reaching a measured-concrete component that itself
 * depends on a measured-abstract one below it, while never touching that
 * abstraction. Both abstractness readings must exist (the walker's type
 * census, the main-sequence type floor); unmeasured components are never
 * judged. A pair already tied in one knot is the knot's own finding, not a
 * bypass. One finding per consumer→concrete edge, naming the most abstract
 * component bypassed beneath it.
 */
function abstractionBypasses(
  componentGraph: ComponentGraph,
  files: readonly FileDependencyGraphFile[],
  sameKnot: (a: string, b: string) => boolean,
): LayeringAbstractionBypassViolation[] {
  const abstractness = abstractnessByComponent(componentGraph, files);
  const targetsOf = new Map<string, string[]>();
  for (const dependency of componentGraph.dependencies) {
    targetsOf.set(dependency.sourceComponent, [
      ...(targetsOf.get(dependency.sourceComponent) ?? []),
      dependency.targetComponent,
    ]);
  }

  const findings: LayeringAbstractionBypassViolation[] = [];
  for (const dependency of componentGraph.dependencies) {
    const consumer = dependency.sourceComponent;
    const concrete = dependency.targetComponent;
    if (sameKnot(consumer, concrete)) continue;
    const concreteReading = abstractness.get(concrete);
    if (!concreteReading || concreteReading.typeCount < BYPASS_MIN_TYPE_COUNT) continue;
    if (concreteReading.abstractness > BYPASS_CONCRETE_MAX_ABSTRACTNESS) continue;
    let bypassed: { component: string; abstractness: number } | undefined;
    for (const below of targetsOf.get(concrete) ?? []) {
      if ((targetsOf.get(consumer) ?? []).includes(below)) continue;
      const reading = abstractness.get(below);
      if (!reading || reading.typeCount < BYPASS_MIN_TYPE_COUNT) continue;
      if (reading.abstractness < BYPASS_ABSTRACT_MIN_ABSTRACTNESS) continue;
      if (!bypassed || reading.abstractness > bypassed.abstractness) {
        bypassed = { component: below, abstractness: reading.abstractness };
      }
    }
    if (!bypassed) continue;
    findings.push({
      kind: "abstractionBypass",
      sourceComponent: consumer,
      targetComponent: concrete,
      bypassedComponent: bypassed.component,
      concreteAbstractness: concreteReading.abstractness,
      bypassedAbstractness: bypassed.abstractness,
      callWeight: dependency.callWeight,
    });
  }
  return findings.sort(
    (a, b) =>
      b.callWeight - a.callWeight ||
      compareCodePoints(a.sourceComponent, b.sourceComponent) ||
      compareCodePoints(a.targetComponent, b.targetComponent),
  );
}

interface AbstractnessReading {
  abstractness: number;
  typeCount: number;
}

/** A = abstract / (abstract + concrete) over the component's measured files. */
function abstractnessByComponent(
  componentGraph: ComponentGraph,
  files: readonly FileDependencyGraphFile[],
): Map<string, AbstractnessReading> {
  const byPath = new Map(files.map((f) => [f.relPath, f]));
  const totals = new Map<string, { abstract: number; concrete: number }>();
  for (const [relPath, componentDir] of componentGraph.componentOf) {
    const census = byPath.get(relPath)?.typeAbstractness;
    if (!census) continue;
    const total = totals.get(componentDir) ?? { abstract: 0, concrete: 0 };
    total.abstract += census.abstractTypeCount;
    total.concrete += census.concreteTypeCount;
    totals.set(componentDir, total);
  }
  const readings = new Map<string, AbstractnessReading>();
  for (const [componentDir, { abstract, concrete }] of totals) {
    const typeCount = abstract + concrete;
    readings.set(componentDir, { abstractness: typeCount === 0 ? 0 : abstract / typeCount, typeCount });
  }
  return readings;
}

function nestedPairs(
  componentGraph: ComponentGraph,
  members: readonly string[],
): { parentComponent: string; nestedComponent: string }[] {
  const memberSet = new Set(members);
  // Both directions of one parent↔nested pair name the same composition once.
  const seen = new Set<string>();
  const pairs: { parentComponent: string; nestedComponent: string }[] = [];
  for (const dependency of componentGraph.dependencies) {
    if (!memberSet.has(dependency.sourceComponent) || !memberSet.has(dependency.targetComponent)) continue;
    let parentComponent: string;
    let nestedComponent: string;
    if (dependency.directoryRelation === "descendant") {
      parentComponent = dependency.sourceComponent;
      nestedComponent = dependency.targetComponent;
    } else if (dependency.directoryRelation === "ancestor") {
      parentComponent = dependency.targetComponent;
      nestedComponent = dependency.sourceComponent;
    } else continue;
    const key = `${parentComponent}\u0000${nestedComponent}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ parentComponent, nestedComponent });
  }
  return pairs.sort(
    (a, b) =>
      compareCodePoints(a.parentComponent, b.parentComponent) ||
      compareCodePoints(a.nestedComponent, b.nestedComponent),
  );
}

/**
 * Detached islands: depth 0 (nothing depends on the component) and below the
 * top of the stack — hanging off the side, a dead-code candidate, not a
 * foundation. A component at the top level with nothing above it is a
 * composition root; a knot member shares its knot's position and is never
 * judged alone.
 */
function islands(componentGraph: ComponentGraph, model: LayeringModel): LayeringIslandViolation[] {
  const findings: LayeringIslandViolation[] = [];
  for (const [component, position] of model.positions) {
    if (position.inKnot || position.depth !== 0) continue;
    if (position.level >= model.levelCount - 1) continue;
    const c = componentGraph.components.get(component);
    if (!c) continue;
    findings.push({
      kind: "island",
      component,
      height: position.level,
      depth: position.depth,
      afferentCount: c.afferentCount,
      instability: c.instability,
    });
  }
  return findings.sort((a, b) => a.height - b.height || compareCodePoints(a.component, b.component));
}

/**
 * Layer skips: a dependency jumping `LAYER_SKIP_MIN_LEVELS` or more straight
 * down. Judged only between components standing for themselves — a knot
 * member's level is its knot's, not its own, and would misread.
 */
function layerSkips(componentGraph: ComponentGraph, model: LayeringModel): LayeringLayerSkipViolation[] {
  const findings: LayeringLayerSkipViolation[] = [];
  for (const dependency of componentGraph.dependencies) {
    const source = model.positions.get(dependency.sourceComponent);
    const target = model.positions.get(dependency.targetComponent);
    if (!source || !target || source.inKnot || target.inKnot) continue;
    const skipped = source.level - target.level;
    if (skipped < LAYER_SKIP_MIN_LEVELS) continue;
    findings.push({
      kind: "layerSkip",
      sourceComponent: dependency.sourceComponent,
      targetComponent: dependency.targetComponent,
      sourceLevel: source.level,
      targetLevel: target.level,
      skippedLevels: skipped,
      callWeight: dependency.callWeight,
    });
  }
  return findings.sort(
    (a, b) =>
      b.skippedLevels - a.skippedLevels ||
      compareCodePoints(a.sourceComponent, b.sourceComponent) ||
      compareCodePoints(a.targetComponent, b.targetComponent),
  );
}

function byMemberCountThenMembers(a: LayeringKnot, b: LayeringKnot): number {
  return (
    b.components.length - a.components.length ||
    compareCodePoints(a.components.join("\u0000"), b.components.join("\u0000"))
  );
}

/** Locale-independent, so the order is the same on every machine. */
function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
