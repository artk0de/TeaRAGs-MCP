import type { FileDependencyEdge, FileDependencyGraph } from "../../../../../contracts/types/codegraph.js";
import { compilePathPatternMatcher } from "../../../../../infra/path-pattern.js";
import {
  compareCodePoints,
  condensedPositions,
  levelCountOf,
  sccKnots,
  weightedFeedbackArcSet,
  type SimpleEdge,
} from "./layer-graph.js";
import { buildLayeringModel, cappedFileEdges } from "./layering.js";
import type {
  ComponentGraph,
  LayerMap,
  LayerMapBoundaryEdge,
  LayerMapKnot,
  LayerMapMoveCandidate,
  LayerMapNode,
  LayerMapOptions,
} from "./types.js";

/** The counted inner edge the map's levels, coupling counts and knots read. */
type InnerEdge = SimpleEdge & { count: number };

/**
 * The layering model read as a VIEW (bd tea-rags-mcp-r8hme.26): levels of the
 * nodes inside a scope — directory components or individual files — with the
 * edges crossing the boundary KEPT as boundary-out / boundary-in findings that
 * name the external component and its GLOBAL level, so an inner file reaching
 * a higher domain shows exactly where the pull is. A node with no inner
 * afferents whose outward edges all point into one other domain is a move
 * candidate. The node mapping is a pure `relPath -> node` function, so the
 * r8hme.30 domain partition plugs in as another mapping.
 */
export function buildLayerMap(
  componentGraph: ComponentGraph,
  graph: FileDependencyGraph,
  options: LayerMapOptions = {},
): LayerMap {
  const granularity = options.granularity ?? "directory";
  const global = buildLayeringModel(componentGraph);
  const matcher = compilePathPatternMatcher(options.scopePathPattern);
  const scoped = options.scopePathPattern ? matcher : undefined;
  const inScope = (relPath: string) => (scoped ? scoped(relPath) : true);
  const nodeOf = nodeMapping(
    componentGraph,
    granularity,
    scopeRoot(options.scopePathPattern ?? ""),
    options.directoryDepth,
  );
  const globalLevelOf = (componentDir: string) => global.positions.get(componentDir)?.level ?? 0;
  // Raw FILE edges, not the component graph's dependencies: the partition
  // excludes intra-component edges, and inside one domain those are exactly
  // the edges a file-granularity map exists to level.
  const fileEdges: readonly FileDependencyEdge[] = graph.edges;

  // The induced sub-graph: every file edge relabelled onto nodes; edges with
  // both ends inside are inner, the others become boundary findings that keep
  // the outside endpoint and its global level.
  const inner = new Map<string, InnerEdge>();
  const boundaryOut = new Map<string, LayerMapBoundaryEdge>();
  const boundaryIn = new Map<string, LayerMapBoundaryEdge>();
  for (const fileEdge of fileEdges) {
    const sourceIn = inScope(fileEdge.sourceRelPath);
    const targetIn = inScope(fileEdge.targetRelPath);
    if (sourceIn && targetIn) {
      const source = nodeOf(fileEdge.sourceRelPath);
      const target = nodeOf(fileEdge.targetRelPath);
      if (source === target) continue;
      const key = `${source}\u0000${target}`;
      const existing = inner.get(key);
      if (existing) {
        existing.callWeight += fileEdge.callWeight;
        existing.count++;
      } else {
        inner.set(key, { source, target, callWeight: fileEdge.callWeight, count: 1 });
      }
    } else if (sourceIn) {
      const external = componentGraph.componentOf.get(fileEdge.targetRelPath) ?? "";
      aggregateBoundary(boundaryOut, {
        sourceNode: nodeOf(fileEdge.sourceRelPath),
        externalComponent: external,
        externalLevel: globalLevelOf(external),
        callWeight: fileEdge.callWeight,
      });
    } else if (targetIn) {
      const external = componentGraph.componentOf.get(fileEdge.sourceRelPath) ?? "";
      aggregateBoundary(boundaryIn, {
        targetNode: nodeOf(fileEdge.targetRelPath),
        externalComponent: external,
        externalLevel: globalLevelOf(external),
        callWeight: fileEdge.callWeight,
      });
    }
  }

  const innerEdges = [...inner.values()];
  const mapNodes = [
    ...new Set([
      ...graph.files.filter((file) => inScope(file.relPath)).map((file) => nodeOf(file.relPath)),
      ...innerEdges.flatMap((edge) => [edge.source, edge.target]),
    ]),
  ];
  const positions = condensedPositions(innerEdges);
  const { levelOf, depthOf, knotOf } = positions;

  const afferent = new Map<string, number>();
  const efferent = new Map<string, number>();
  for (const edge of innerEdges) {
    afferent.set(edge.target, (afferent.get(edge.target) ?? 0) + edge.count);
    efferent.set(edge.source, (efferent.get(edge.source) ?? 0) + edge.count);
  }

  const nodes: LayerMapNode[] = mapNodes
    .map((node) => ({
      node,
      level: levelOf(node),
      depth: depthOf(node),
      inKnot: knotOf.has(node),
      innerAfferentCount: afferent.get(node) ?? 0,
      innerEfferentCount: efferent.get(node) ?? 0,
    }))
    .sort((a, b) => a.level - b.level || compareCodePoints(a.node, b.node));

  const knots: LayerMapKnot[] = sccKnots(innerEdges)
    .map((members) => buildKnot(innerEdges, members, nodeOf, fileEdges))
    .sort(
      (a, b) =>
        b.components.length - a.components.length ||
        compareCodePoints(a.components.join("\u0000"), b.components.join("\u0000")),
    );

  const moveCandidates: LayerMapMoveCandidate[] = [];
  for (const node of nodes) {
    if (node.inKnot || node.innerAfferentCount !== 0) continue;
    const outward = [...boundaryOut.values()].filter((edge) => edge.sourceNode === node.node);
    const components = new Set(outward.map((edge) => edge.externalComponent));
    if (components.size !== 1 || outward.length === 0) continue;
    moveCandidates.push({
      node: node.node,
      level: node.level,
      externalComponent: outward[0].externalComponent,
      callWeight: outward.reduce((sum, edge) => sum + edge.callWeight, 0),
    });
  }

  const maxLevel = nodes.reduce((max, node) => Math.max(max, node.level), 0);
  return {
    ...(options.scopePathPattern ? { scope: options.scopePathPattern } : {}),
    granularity,
    levelCount: levelCountOf(innerEdges.length > 0, maxLevel),
    nodes,
    knots,
    boundaryOut: [...boundaryOut.values()].sort(
      (a, b) =>
        compareCodePoints(a.externalComponent, b.externalComponent) ||
        compareCodePoints(a.sourceNode ?? "", b.sourceNode ?? ""),
    ),
    boundaryIn: [...boundaryIn.values()].sort(
      (a, b) =>
        compareCodePoints(a.externalComponent, b.externalComponent) ||
        compareCodePoints(a.targetNode ?? "", b.targetNode ?? ""),
    ),
    moveCandidates: moveCandidates.sort(
      (a, b) => compareCodePoints(a.externalComponent, b.externalComponent) || compareCodePoints(a.node, b.node),
    ),
    summary: {
      nodeCount: nodes.length,
      innerEdgeCount: innerEdges.reduce((sum, edge) => sum + edge.count, 0),
      boundaryOutEdgeCount: boundaryOut.size,
      boundaryInEdgeCount: boundaryIn.size,
    },
  };
}

/**
 * The pure node mapping every layering view shares (bd tea-rags-mcp-r8hme.30
 * builds its domain partition on this seam): a file maps to its component's
 * directory, collapsed to at most `depth` segments below the scope root.
 */
export function nodeMapping(
  componentGraph: ComponentGraph,
  granularity: "directory" | "file",
  scopeRoot: string,
  directoryDepth?: number,
): (relPath: string) => string {
  if (granularity === "file") return (relPath) => relPath;
  return (relPath) => collapseDirectory(componentGraph.componentOf.get(relPath) ?? "", scopeRoot, directoryDepth);
}

/** Collapse a directory to at most `depth` segments below the scope root. */
export function collapseDirectory(componentDir: string, scopeRoot: string, depth?: number): string {
  if (depth === undefined) return componentDir;
  const root = scopeRoot === "" ? [] : scopeRoot.split("/");
  const segments = componentDir === "" ? [] : componentDir.split("/");
  return [...root, ...segments.slice(root.length).slice(0, depth)].join("/");
}

/** The literal prefix of a picomatch glob, up to the first wildcard segment. */
function scopeRoot(scopePathPattern: string): string {
  const literal: string[] = [];
  for (const segment of scopePathPattern.split("/")) {
    if (/[*?[\]{}()!]/.test(segment)) break;
    literal.push(segment);
  }
  return literal.join("/");
}

function aggregateBoundary(map: Map<string, LayerMapBoundaryEdge>, edge: LayerMapBoundaryEdge): void {
  const key = `${edge.sourceNode ?? ""}\u0000${edge.targetNode ?? ""}\u0000${edge.externalComponent}`;
  const existing = map.get(key);
  if (existing) existing.callWeight += edge.callWeight;
  else map.set(key, edge);
}

function buildKnot(
  innerEdges: readonly InnerEdge[],
  members: readonly string[],
  nodeOf: (relPath: string) => string,
  fileEdges: readonly FileDependencyEdge[],
): LayerMapKnot {
  const memberSet = new Set(members);
  const internal = innerEdges.filter((edge) => memberSet.has(edge.source) && memberSet.has(edge.target));
  const byCa = (a: string, b: string) =>
    innerEdges.filter((edge) => edge.target === b).length - innerEdges.filter((edge) => edge.target === a).length ||
    compareCodePoints(a, b);

  const arcSet = weightedFeedbackArcSet(internal);
  const cut = new Set(arcSet.map((edge) => `${edge.source}\u0000${edge.target}`));
  const afterCut = condensedPositions(innerEdges.filter((edge) => !cut.has(`${edge.source}\u0000${edge.target}`)));

  return {
    components: [...members].sort(byCa),
    feedbackArcSet: arcSet.map((edge) => ({
      sourceComponent: edge.source,
      targetComponent: edge.target,
      callWeight: edge.callWeight,
      fileEdges: cappedFileEdges(
        fileEdges.filter(
          (fileEdge) =>
            memberSet.has(nodeOf(fileEdge.sourceRelPath)) &&
            nodeOf(fileEdge.sourceRelPath) === edge.source &&
            nodeOf(fileEdge.targetRelPath) === edge.target,
        ),
      ),
    })),
    cutEdgeCount: arcSet.length,
    levelsAfterCut: new Set(members.map(afterCut.levelOf)).size,
  };
}
