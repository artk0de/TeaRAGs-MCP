import type { FileDependencyEdge, FileDependencyGraphFile } from "../../../../../contracts/types/codegraph.js";
import { tarjanScc } from "../../../../../infra/graph/index.js";
import { compilePathPatternMatcher, type PathPatternMatcher } from "../../../../../infra/path-pattern.js";
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
  LayeringKeepCost,
  LayeringKnot,
  LayeringKnotDetail,
  LayeringKnotDrillDown,
  LayeringKnotLookup,
  LayeringLayerSkipViolation,
  LayeringModel,
  LayeringOptions,
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

  // One pass buckets every dependency leaving a knot member: into the knot's
  // internal edges, or its edges to external components.
  const internalOf = sccs.map((): ComponentDependency[] => []);
  const externalOf = sccs.map((): ComponentDependency[] => []);
  for (const dependency of edges) {
    const sourceKnot = knotOf.get(dependency.sourceComponent);
    if (sourceKnot === undefined) continue;
    const bucket = knotOf.get(dependency.targetComponent) === sourceKnot ? internalOf : externalOf;
    bucket[sourceKnot]?.push(dependency);
  }
  const baseLevelOf = (component: string) => positionOf(component).level;
  const knots = sccs
    .map((members, index) =>
      buildKnot(componentGraph, members, internalOf[index] ?? [], externalOf[index] ?? [], baseLevelOf),
    )
    .sort(byMemberCountThenMembers);

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
  options: LayeringOptions = {},
): LayeringReport {
  const model = options.model ?? buildLayeringModel(componentGraph);
  const compositionKnots = model.knots.filter((knot) => knot.composition);
  // Knot findings rank by member-instability spread (bd tea-rags-mcp-r8hme.32):
  // a knot fusing a stable member with a volatile one is an SDP break inside a
  // cycle and leads; same-size tangles of uniform instability follow. Ties keep
  // the model's member-count order.
  const realKnots = model.knots
    .filter((knot) => !knot.composition)
    .sort(
      (a, b) =>
        b.instabilitySpread - a.instabilitySpread ||
        b.components.length - a.components.length ||
        compareCodePoints(a.components.join("\u0000"), b.components.join("\u0000")),
    );

  const allFindings: LayeringViolation[] = [
    ...realKnots.map(
      (knot): LayeringViolation => ({
        kind: "knot",
        components: knot.components,
        feedbackArcSet: knot.feedbackArcSet,
        cutEdgeCount: knot.cutEdgeCount,
        levelsAfterCut: knot.levelsAfterCut,
        drillDown: knotDrillDown(knot.components),
        instabilitySpread: knot.instabilitySpread,
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

  const inScope = compilePathPatternMatcher(options.sourcePathPattern);
  const sourceScope = inScope && layeringSourceScope(componentGraph, inScope);
  const violations = sourceScope
    ? allFindings.filter((finding) => findingInScope(sourceScope, finding)).map((f) => projectOntoScope(sourceScope, f))
    : allFindings;
  const scope =
    sourceScope && options.sourcePathPattern
      ? { sourcePathPattern: options.sourcePathPattern, outOfScopeFindingCount: allFindings.length - violations.length }
      : undefined;

  const count = (kind: LayeringViolation["kind"]) => violations.filter((v) => v.kind === kind).length;
  const summary: LayeringSummary = {
    componentCount: componentGraph.components.size,
    componentEdgeCount: componentGraph.dependencies.length,
    levelCount: model.levelCount,
    coverage: model.coverage,
    coherence: model.coherence,
    knotCount: count("knot"),
    backEdgeCount: count("backEdge"),
    abstractionBypassCount: count("abstractionBypass"),
    compositionCycleCount: count("compositionCycle"),
    islandCount: count("island"),
    layerSkipCount: count("layerSkip"),
    violationCount: violations.length,
    ...(scope ? { scope } : {}),
  };
  return { violations, summary };
}

/**
 * What a source path pattern reaches in the component graph (bd
 * tea-rags-mcp-r8hme.33): a component is in scope when it owns a matching
 * file; a component dependency when a matching source file carries it — the
 * full edge, not the evidence cap.
 */
interface LayeringSourceScope {
  componentMatches: (component: string) => boolean;
  dependencyMatches: (sourceComponent: string, targetComponent: string) => boolean;
}

function layeringSourceScope(componentGraph: ComponentGraph, inScope: PathPatternMatcher): LayeringSourceScope {
  const filesOf = new Map<string, string[]>();
  for (const [relPath, component] of componentGraph.componentOf) {
    filesOf.set(component, [...(filesOf.get(component) ?? []), relPath]);
  }
  return {
    componentMatches: (component) => (filesOf.get(component) ?? []).some(inScope),
    dependencyMatches: (source, target) =>
      componentGraph.dependencies.some(
        (d) =>
          d.sourceComponent === source &&
          d.targetComponent === target &&
          d.fileEdges.some((e) => inScope(e.sourceRelPath)),
      ),
  };
}

/**
 * The keep/drop test for one finding: a dependency finding by the files
 * carrying its component edge, a component finding by the component's own
 * files, a knot or composition cycle when ANY member is in scope.
 */
function findingInScope(scope: LayeringSourceScope, finding: LayeringViolation): boolean {
  switch (finding.kind) {
    case "knot":
    case "compositionCycle":
      return finding.components.some(scope.componentMatches);
    case "island":
      return scope.componentMatches(finding.component);
    case "backEdge":
    case "abstractionBypass":
    case "layerSkip":
      return scope.dependencyMatches(finding.sourceComponent, finding.targetComponent);
  }
}

/**
 * A kept knot or composition cycle, projected onto the scope: only the
 * in-scope members, and (for a knot) only the cut edges an in-scope file
 * carries, with how many of each the scope dropped. A large knot is kept
 * under almost any scope — a 55-member knot on mastodon was — and printing it
 * whole buries the part the scope asked about. `cutEdgeCount` and
 * `levelsAfterCut` stay whole-knot: they price dissolving the whole knot.
 */
function projectOntoScope(scope: LayeringSourceScope, finding: LayeringViolation): LayeringViolation {
  switch (finding.kind) {
    case "knot":
      return { ...finding, ...projectKnotOntoScope(scope, finding.components, finding.feedbackArcSet) };
    case "compositionCycle": {
      const components = finding.components.filter(scope.componentMatches);
      const inScopeMembers = new Set(components);
      return {
        ...finding,
        components,
        nestedPairs: finding.nestedPairs.filter(
          (pair) => inScopeMembers.has(pair.parentComponent) || inScopeMembers.has(pair.nestedComponent),
        ),
        outOfScopeMemberCount: finding.components.length - components.length,
      };
    }
    case "island":
    case "backEdge":
    case "abstractionBypass":
    case "layerSkip":
      return finding;
  }
}

/**
 * A knot's members and cut, projected onto the scope — shared by the knot
 * finding and the knot lookup so both read the same projection.
 */
function projectKnotOntoScope(
  scope: LayeringSourceScope,
  members: readonly string[],
  cut: readonly LayeringFeedbackEdge[],
): Pick<LayeringKnotDetail, "components" | "feedbackArcSet" | "outOfScopeMemberCount" | "outOfScopeFeedbackEdgeCount"> {
  const components = members.filter(scope.componentMatches);
  const feedbackArcSet = cut.filter((edge) => scope.dependencyMatches(edge.sourceComponent, edge.targetComponent));
  return {
    components,
    feedbackArcSet,
    outOfScopeMemberCount: members.length - components.length,
    outOfScopeFeedbackEdgeCount: cut.length - feedbackArcSet.length,
  };
}

/**
 * The drill-down handles of one WHOLE knot (bd tea-rags-mcp-r8hme.38), from
 * its full Ca-ordered member list: the top member, and the deepest common
 * ancestor directory of every member as a glob — omitted at the root, where
 * `**` would select the whole repository rather than the knot.
 */
function knotDrillDown(members: readonly string[]): LayeringKnotDrillDown {
  const [first = [], ...rest] = members.map((member) => member.split("/").filter((segment) => segment !== ""));
  let shared = first.length;
  for (const segments of rest) {
    let i = 0;
    while (i < shared && i < segments.length && segments[i] === first[i]) i++;
    shared = i;
  }
  const ancestor = first.slice(0, shared).join("/");
  return { knotOf: members[0] ?? "", ...(ancestor ? { pathPattern: `${ancestor}/**` } : {}) };
}

/**
 * One knot looked up by any member (bd tea-rags-mcp-r8hme.38) — the handle a
 * knot finding's `drillDown.knotOf` names. Full lists, no paging: the caller
 * pages. A composition cycle is a knot of the model too and comes back with
 * `composition: true`. Under `sourcePathPattern` the members and the cut are
 * the projection the knot finding gets, and a back-edge is kept by the file
 * carrying it; positions stay whole-graph. Takes the prebuilt `model` of the
 * same component graph — building it is the expensive part.
 */
export function lookupLayeringKnot(
  componentGraph: ComponentGraph,
  model: LayeringModel,
  component: string,
  options: Pick<LayeringOptions, "sourcePathPattern"> = {},
): LayeringKnotLookup {
  const position = model.positions.get(component);
  if (!position) return { kind: "unknownComponent", component };
  const knot = position.inKnot ? model.knots.find((k) => k.components.includes(component)) : undefined;
  if (!knot) return { kind: "notInKnot", component, position };

  const inScope = compilePathPatternMatcher(options.sourcePathPattern);
  const scope = inScope && layeringSourceScope(componentGraph, inScope);
  const knotBackEdges = knot.composition ? [] : backEdges(componentGraph, [knot]);
  return {
    kind: "inKnot",
    component,
    position,
    knot: {
      components: knot.components,
      feedbackArcSet: knot.feedbackArcSet,
      cutEdgeCount: knot.cutEdgeCount,
      levelsAfterCut: knot.levelsAfterCut,
      composition: knot.composition,
      backEdges: scope ? knotBackEdges.filter((edge) => findingInScope(scope, edge)) : knotBackEdges,
      ...(scope ? projectKnotOntoScope(scope, knot.components, knot.feedbackArcSet) : {}),
    },
  };
}

/**
 * The keep cost of each named cut edge of one WHOLE knot (bd
 * tea-rags-mcp-r8hme.40): the knot's internal edges minus every OTHER
 * feedback-arc-set edge, Tarjan over the members alone, the re-collapsed SCCs
 * condensed, then the member-local levels — components outside the knot at
 * their levels in `model`. O(|K| + E_K) per edge after one O(E) pass that
 * gathers the knot's edges, so the caller prices a page of edges, never the
 * whole cut. Takes the prebuilt `model` of the same component graph; an edge
 * outside the knot's cut prices as the full cut.
 */
export function layeringKnotKeepCosts<Edge extends Pick<LayeringFeedbackEdge, "sourceComponent" | "targetComponent">>(
  componentGraph: ComponentGraph,
  model: LayeringModel,
  knot: Pick<LayeringKnot, "components" | "feedbackArcSet">,
  edges: readonly Edge[],
): { edge: Edge; keepCost: LayeringKeepCost }[] {
  const members = knot.components;
  const memberSet = new Set(members);
  const internal: (readonly [string, string])[] = [];
  const external: (readonly [string, string])[] = [];
  for (const dependency of componentGraph.dependencies) {
    if (!memberSet.has(dependency.sourceComponent)) continue;
    (memberSet.has(dependency.targetComponent) ? internal : external).push(dependencyPair(dependency));
  }
  const cut = new Set(knot.feedbackArcSet.map((edge) => dependencyKey(edge.sourceComponent, edge.targetComponent)));
  const baseLevelOf = (component: string) => model.positions.get(component)?.level ?? 0;

  return edges.map((edge) => {
    const kept = dependencyKey(edge.sourceComponent, edge.targetComponent);
    const keptInternal = internal.filter(([source, target]) => {
      const key = dependencyKey(source, target);
      return key === kept || !cut.has(key);
    });
    const recollapsed = tarjanScc(pairAdjacency(keptInternal));
    const sccOf = new Map<string, number>();
    recollapsed.forEach((scc, index) => {
      scc.forEach((member) => sccOf.set(member, index));
    });
    const nodeOf = (member: string) => {
      const scc = sccOf.get(member);
      return scc === undefined ? member : knotNode(scc);
    };
    const level = memberLevelsAfterCut(
      [...new Set(members.map(nodeOf))],
      keptInternal.map(([source, target]) => [nodeOf(source), nodeOf(target)] as const),
      external.map(([source, target]) => [nodeOf(source), target] as const),
      baseLevelOf,
    );
    return {
      edge,
      keepCost: {
        recollapsedMemberCount: recollapsed.reduce((sum, scc) => sum + scc.length, 0),
        levelsAfterKeep: new Set(members.map((member) => level.get(nodeOf(member)) ?? 0)).size,
      },
    };
  });
}

function pairAdjacency(pairs: readonly (readonly [string, string])[]): Map<string, readonly string[]> {
  const out = new Map<string, string[]>();
  for (const [source, target] of pairs) {
    const targets = out.get(source) ?? [];
    if (!targets.includes(target)) targets.push(target);
    out.set(source, targets);
  }
  return out;
}

function adjacency(dependencies: readonly ComponentDependency[]): Map<string, readonly string[]> {
  return pairAdjacency(dependencies.map(dependencyPair));
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
 * `levelsAfterCut` is the level count the members reach in the FULL graph
 * with the cut applied, computed member-locally (bd tea-rags-mcp-r8hme.36):
 * the cut removes only edges inside this knot, so every other SCC stays as it
 * was, and every component a member reaches outside the knot sits below it in
 * the base condensation — it cannot reach the knot back — with its base level
 * unchanged. A member's level is then the longest path over the knot's
 * remaining internal edges, an edge out of the knot counting 1 + that
 * component's base level. O(|K| + E_K) per knot instead of a whole-graph
 * Tarjan + condensation per knot.
 */
function buildKnot(
  componentGraph: ComponentGraph,
  members: readonly string[],
  internal: readonly ComponentDependency[],
  external: readonly ComponentDependency[],
  baseLevelOf: (component: string) => number,
): LayeringKnot {
  const byCa = (a: string, b: string) =>
    (componentGraph.components.get(b)?.afferentCount ?? 0) - (componentGraph.components.get(a)?.afferentCount ?? 0) ||
    compareCodePoints(a, b);

  const feedbackArcSet = eadesLinSmyth(internal);
  const cut = new Set(feedbackArcSet.map((edge) => dependencyKey(edge.sourceComponent, edge.targetComponent)));
  const dissolvedLevel = memberLevelsAfterCut(
    members,
    internal.filter((d) => !cut.has(dependencyKey(d.sourceComponent, d.targetComponent))).map(dependencyPair),
    external.map(dependencyPair),
    baseLevelOf,
  );
  const memberInstabilities = members.map((m) => componentGraph.components.get(m)?.instability ?? 0);

  return {
    components: [...members].sort(byCa),
    feedbackArcSet,
    cutEdgeCount: feedbackArcSet.length,
    levelsAfterCut: new Set(members.map((member) => dissolvedLevel.get(member) ?? 0)).size,
    composition: internal.every((d) => d.directoryRelation === "descendant" || d.directoryRelation === "ancestor"),
    instabilitySpread: Math.max(...memberInstabilities) - Math.min(...memberInstabilities),
  };
}

function dependencyKey(source: string, target: string): string {
  return `${source}\u0000${target}`;
}

function dependencyPair(dependency: ComponentDependency): readonly [string, string] {
  return [dependency.sourceComponent, dependency.targetComponent];
}

/**
 * The level of every member over the member-local graph: 0 for a member with
 * no outgoing edge, else the largest of 1 + a member successor's level and
 * 1 + `baseLevelOf` an external successor. `internalEdges` join members,
 * `externalEdges` run from a member to a component outside the member set.
 *
 * Iterative memoized DFS, so a long member chain cannot exhaust the stack. The
 * edges are expected acyclic (a feedback arc set removed, or SCCs already
 * condensed); a residual cycle does not loop — a successor still on the DFS
 * path counts as level 0, the same break `longestPath` applies.
 */
function memberLevelsAfterCut(
  members: readonly string[],
  internalEdges: readonly (readonly [string, string])[],
  externalEdges: readonly (readonly [string, string])[],
  baseLevelOf: (component: string) => number,
): Map<string, number> {
  const successors = new Map<string, string[]>();
  for (const [source, target] of internalEdges) {
    if (source === target) continue;
    const list = successors.get(source) ?? [];
    list.push(target);
    successors.set(source, list);
  }
  const externalFloor = new Map<string, number>();
  for (const [source, target] of externalEdges) {
    externalFloor.set(source, Math.max(externalFloor.get(source) ?? 0, 1 + baseLevelOf(target)));
  }

  const level = new Map<string, number>();
  const onPath = new Set<string>();
  for (const root of members) {
    if (level.has(root)) continue;
    const frames: { node: string; nextChild: number }[] = [{ node: root, nextChild: 0 }];
    onPath.add(root);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (!frame) break;
      const next = successors.get(frame.node) ?? [];
      if (frame.nextChild < next.length) {
        const child = next[frame.nextChild++] ?? frame.node;
        if (level.has(child) || onPath.has(child)) continue;
        onPath.add(child);
        frames.push({ node: child, nextChild: 0 });
        continue;
      }
      let value = externalFloor.get(frame.node) ?? 0;
      for (const child of next) value = Math.max(value, 1 + (level.get(child) ?? 0));
      level.set(frame.node, value);
      onPath.delete(frame.node);
      frames.pop();
    }
  }
  return level;
}

/**
 * Eades–Lin–Smyth over one knot's internal edges, weighted by call weight:
 * peel sinks to the sequence's end and sources to its front, else remove the
 * vertex with the largest weighted out-degree minus in-degree. The feedback
 * arc set is every edge pointing from later to earlier in the final sequence —
 * removing it leaves the sequence a topological order. Ties break by path, so
 * the cut is deterministic.
 *
 * O(V² + E): live degree counts and weights toward the REMAINING vertices are
 * kept per vertex and decremented along a removed vertex's own edges, so every
 * sink/source check and every weighted delta is O(1). Rescanning every internal
 * edge per check cost O(V²·E) and never finished on a knot of hundreds of
 * components.
 */
export function eadesLinSmyth(internal: readonly ComponentDependency[]): LayeringFeedbackEdge[] {
  const nodes = [...new Set(internal.flatMap((d) => [d.sourceComponent, d.targetComponent]))].sort(compareCodePoints);
  const indexOf = new Map(nodes.map((node, index) => [node, index]));
  const outgoing: { target: number; weight: number }[][] = nodes.map(() => []);
  const incoming: { source: number; weight: number }[][] = nodes.map(() => []);
  const liveOutCount = new Array<number>(nodes.length).fill(0);
  const liveInCount = new Array<number>(nodes.length).fill(0);
  const liveOutWeight = new Array<number>(nodes.length).fill(0);
  const liveInWeight = new Array<number>(nodes.length).fill(0);
  for (const d of internal) {
    const source = indexOf.get(d.sourceComponent) ?? 0;
    const target = indexOf.get(d.targetComponent) ?? 0;
    outgoing[source]?.push({ target, weight: d.callWeight });
    incoming[target]?.push({ source, weight: d.callWeight });
    liveOutCount[source] = (liveOutCount[source] ?? 0) + 1;
    liveInCount[target] = (liveInCount[target] ?? 0) + 1;
    liveOutWeight[source] = (liveOutWeight[source] ?? 0) + d.callWeight;
    liveInWeight[target] = (liveInWeight[target] ?? 0) + d.callWeight;
  }
  const isRemaining = new Array<boolean>(nodes.length).fill(true);
  let remainingCount = nodes.length;
  const remove = (node: number) => {
    isRemaining[node] = false;
    for (const { target, weight } of outgoing[node] ?? []) {
      if (!isRemaining[target]) continue;
      liveInCount[target] = (liveInCount[target] ?? 0) - 1;
      liveInWeight[target] = (liveInWeight[target] ?? 0) - weight;
    }
    for (const { source, weight } of incoming[node] ?? []) {
      if (!isRemaining[source]) continue;
      liveOutCount[source] = (liveOutCount[source] ?? 0) - 1;
      liveOutWeight[source] = (liveOutWeight[source] ?? 0) - weight;
    }
  };

  // Sources collect in `front` in peel order and stay that way — the left
  // block of the canonical sequence. Sinks and max-delta picks append to
  // `back` in removal order; prepending them to the canonical right block is
  // the same list read backwards, so `back` reverses once at the end (bd
  // tea-rags-mcp-r8hme.42: the two reversals used to be swapped, which cut
  // every edge of a pure source-chain DAG). `nodes` is already in code-point
  // order, so each pass walks the remaining vertices in that order and reads
  // live state as it changes.
  const front: string[] = [];
  const back: string[] = [];
  while (remainingCount > 0) {
    let moved = true;
    while (moved && remainingCount > 0) {
      moved = false;
      for (let node = 0; node < nodes.length; node++) {
        if (!isRemaining[node]) continue;
        const liveOut = (liveOutCount[node] ?? 0) > 0;
        if (liveOut && (liveInCount[node] ?? 0) > 0) continue;
        (liveOut ? front : back).push(nodes[node] ?? "");
        remove(node);
        remainingCount--;
        moved = true;
      }
    }
    if (remainingCount === 0) break;
    let best = -1;
    let bestDelta = Number.NEGATIVE_INFINITY;
    for (let node = 0; node < nodes.length; node++) {
      if (!isRemaining[node]) continue;
      const delta = (liveOutWeight[node] ?? 0) - (liveInWeight[node] ?? 0);
      if (delta > bestDelta) {
        bestDelta = delta;
        best = node;
      }
    }
    if (best < 0) break;
    remove(best);
    remainingCount--;
    back.push(nodes[best] ?? "");
  }
  const position = new Map<string, number>();
  [...front, ...back.reverse()].forEach((node, index) => position.set(node, index));

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

export function cappedFileEdges(fileEdges: readonly FileDependencyEdge[]): FileDependencyEdge[] {
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
