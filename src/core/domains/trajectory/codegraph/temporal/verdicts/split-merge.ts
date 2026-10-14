/**
 * Split / merge verdicts over the temporal co-change sub-graph (A5, bd
 * tea-rags-mcp-c3v6o): does the architecture report's component partition
 * match the partition history votes for?
 *
 * MERGE — two components whose admitted bundles overlap so strongly that they
 * change as one unit. Judged on COMPONENT-level bundle counts —
 * `support(A,B) = |bundles touching both|`, `changes(A) = |bundles touching
 * A|` — read from the persisted per-bundle file membership, never from the
 * pair table: the per-file partner cap truncates the pair set, and a pair's
 * support counts a multi-file bundle once per PAIR, not once per bundle.
 *
 * SPLIT — one component whose stored internal pairs cluster into ≥ 2 groups
 * (largest weight share under `TEMPORAL_COHESION_SPLIT_MAX_SHARE`), clustered
 * by the same `weightThresholdComponents` primitive behavioral cohesion uses
 * intra-file; this is its intra-component sibling. Computed from the STORED
 * pairs, floored by the drawn threshold — the `maxPartnersPerFile` cap may
 * under-represent internal pairs, which makes splits conservative (harder to
 * find), the documented direction.
 *
 * A split also has to be SEPARABLE and to DESCRIBE the component (bd
 * tea-rags-mcp-755bj). Separable: clusters a stored internal pair links at
 * least as often (support) as the weaker cluster's own weakest spanning link
 * are one chain, not two groups — the strength cut only kept the bridge out
 * because its rate was diluted, while the history co-changed across it as
 * often as inside. Describing: the clusters must hold a strict majority of the
 * component's co-changing files (endpoints of its stored internal pairs); two
 * strong pairs in a corner of a wide component say nothing about its border.
 *
 * MERGE never judges a NESTED pair — one component inside the other's own tree
 * (`componentAncestry`): the two already are one subtree, so a merge names no
 * border between them, and a parent co-changes with its descendants by
 * construction. Nested pairs leave the draw's population too: only judged
 * strengths set the bar.
 *
 * ONE DRAW. Internal pair strengths and component-pair strengths enter ONE
 * population for the majority-floored Otsu draw — silent coupling's own
 * mechanism (`resolveMajorityFlooredOtsuThreshold`,
 * `SILENT_COUPLING_OTSU_MIN_POPULATION`). Both kinds are Wilson lower bounds
 * of co-change rates over the same admitted bundles, so "how strong must
 * co-change evidence be" is a property of the history, not of the verdict
 * kind; two draws would let whichever kind is plentiful set a different bar
 * for the other. No reason to split the population was found — if one
 * appears, it is a design decision, not an implementation detail.
 *
 * Pure functions, no DuckDB: ports in (the report's partition, the stored
 * pairs, the bundle membership), verdicts out. Absence of data is silence —
 * an empty bundle membership yields EMPTY verdicts (the caller reports the
 * block not built), never zeros posing as verdicts; the read pairs' exclusion
 * counts still say what was read.
 */

import type { RelPath, TemporalCochangeEdge } from "../../../../../contracts/types/codegraph.js";
import {
  resolveMajorityFlooredOtsuThreshold,
  weightThresholdComponents,
  type WeightedNodeEdge,
} from "../../../../../primitives/graph/index.js";
import { componentAncestry } from "../../component-geometry/index.js";
import {
  cochangeStrength,
  SILENT_COUPLING_OTSU_MIN_POPULATION,
  SILENT_COUPLING_STRENGTH_MAJORITY,
} from "../boundary-diagnostics/index.js";
import { TEMPORAL_COHESION_SPLIT_MAX_SHARE } from "../cohesion/index.js";

/**
 * Files listed per split cluster — exemplars a reader can open, not the full
 * census (`clusters` keeps the count; the primitive's nodes are code-point
 * ordered, so the first N are stable exemplars).
 */
export const SPLIT_CLUSTER_EXEMPLAR_FILES = 8;

/** The report's component partition: which component holds each file. */
export interface SplitMergeComponentPartition {
  componentOf: ReadonlyMap<RelPath, string>;
}

export interface SplitMergeInput {
  /** The partition the verdicts are keyed by — the report's own. */
  components: SplitMergeComponentPartition;
  /** The stored co-change pairs, as `readTemporalCochangeGraph` serves them. */
  edges: readonly TemporalCochangeEdge[];
  /** The admitted bundles' file memberships, keyed by bundle id. */
  bundles: ReadonlyMap<number, readonly RelPath[]>;
}

/** One component whose internal pairs fall into ≥ 2 co-change clusters. */
export interface SplitCandidate {
  component: string;
  /** Clusters the admitted internal pairs form. */
  clusters: number;
  /** The largest cluster's share of the component's admitted co-change weight in [0,1]. */
  largestWeightShare: number;
  /** Per cluster its exemplar files (≤ {@link SPLIT_CLUSTER_EXEMPLAR_FILES}), heaviest cluster first. */
  files: readonly (readonly RelPath[])[];
}

/** Two components whose admitted bundles overlap strongly enough to change as one unit. */
export interface MergeCandidate {
  componentA: string;
  componentB: string;
  /** Admitted bundles touching both components. */
  support: number;
  /**
   * `cochangeStrength` over the synthetic component edge
   * `{support, support/changesA, support/changesB}` — the larger direction's
   * Wilson lower bound. The severity.
   */
  strength: number;
  /** Admitted bundles touching componentA. */
  changesA: number;
  /** Admitted bundles touching componentB. */
  changesB: number;
}

/** Stored pairs read but not judged, by the first reason that applied. */
export interface SplitMergeExclusionCounts {
  /** A pair endpoint no component of the partition holds (unwalked, test, non-production). */
  unpartitionedEndpoints: number;
  /**
   * A pair whose endpoints sit in different components — SPLIT judges inside
   * one component; what changes ACROSS components is MERGE's question, and it
   * is answered from the bundles, not from the capped pair table.
   */
  crossComponentPairs: number;
}

export interface SplitMergeVerdicts {
  /** Worst split first: most clusters, then smallest largest-cluster share, then path. */
  splitCandidates: SplitCandidate[];
  /** Strongest first: strength, then support, then paths. */
  mergeCandidates: MergeCandidate[];
  /** The one draw's threshold over every judged strength, internal pairs and component pairs alike. */
  threshold: number;
  thresholdMethod: "otsu" | "majority";
  excluded: SplitMergeExclusionCounts;
}

/**
 * Judge the partition against the history. See the module docblock for the
 * merge / split / one-draw contracts; every strength here is
 * {@link cochangeStrength}, never a raw rate.
 */
export function computeSplitMergeVerdicts(input: SplitMergeInput): SplitMergeVerdicts {
  const { componentOf } = input.components;
  const excluded = countExclusions(input.edges, componentOf);
  if (input.bundles.size === 0) {
    // No bundle membership persisted (pre-042 index, or a build that admitted
    // nothing): nothing can be judged honestly. The caller reports not built.
    return {
      splitCandidates: [],
      mergeCandidates: [],
      threshold: SILENT_COUPLING_STRENGTH_MAJORITY,
      thresholdMethod: "majority",
      excluded,
    };
  }

  // Internal pairs per component — SPLIT's input.
  const internalByComponent = new Map<string, TemporalCochangeEdge[]>();
  for (const edge of input.edges) {
    const component = componentOf.get(edge.relPathA);
    if (component === undefined || componentOf.get(edge.relPathB) !== component) continue;
    const list = internalByComponent.get(component);
    if (list) list.push(edge);
    else internalByComponent.set(component, [edge]);
  }

  // Component-level bundle counts — MERGE's input. A bundle touches a
  // component when any of its files sits in it, however many do.
  const changesByComponent = new Map<string, number>();
  const supportByPair = new Map<string, number>();
  for (const files of input.bundles.values()) {
    const touched = new Set<string>();
    for (const relPath of files) {
      const component = componentOf.get(relPath);
      if (component !== undefined) touched.add(component);
    }
    for (const component of touched) {
      changesByComponent.set(component, (changesByComponent.get(component) ?? 0) + 1);
    }
    const pairComponents = [...touched].sort(compareCodePoints);
    for (let i = 0; i < pairComponents.length; i++) {
      for (let j = i + 1; j < pairComponents.length; j++) {
        const key = `${pairComponents[i]}\u0000${pairComponents[j]}`;
        supportByPair.set(key, (supportByPair.get(key) ?? 0) + 1);
      }
    }
  }

  // Component pairs as synthetic edges: support and changes make the two
  // directed confidences, cochangeStrength the Wilson-bound severity.
  const componentPairs = [...supportByPair].flatMap(([key, support]) => {
    const separator = key.indexOf("\u0000");
    const componentA = key.slice(0, separator);
    const componentB = key.slice(separator + 1);
    if (isNestedComponentPair(componentA, componentB)) return [];
    const changesA = changesByComponent.get(componentA) ?? 0;
    const changesB = changesByComponent.get(componentB) ?? 0;
    return {
      componentA,
      componentB,
      support,
      strength: cochangeStrength({
        support,
        confidenceAB: support / changesA,
        confidenceBA: support / changesB,
      }),
      changesA,
      changesB,
    };
  });

  // ONE draw over every judged strength — internal pairs and component pairs.
  const policy = resolveMajorityFlooredOtsuThreshold(
    [
      ...[...internalByComponent.values()].flatMap((edges) => edges.map((edge) => cochangeStrength(edge))),
      ...componentPairs.map((pair) => pair.strength),
    ],
    { majority: SILENT_COUPLING_STRENGTH_MAJORITY, minPopulation: SILENT_COUPLING_OTSU_MIN_POPULATION },
  );

  const splitCandidates: SplitCandidate[] = [];
  for (const [component, edges] of internalByComponent) {
    const admitted = edges.filter((edge) => policy.admits(cochangeStrength(edge)));
    const analysis = weightThresholdComponents(
      admitted.map((edge) => ({ a: edge.relPathA, b: edge.relPathB, weight: cochangeStrength(edge) })),
      { minWeight: policy.threshold },
    );
    if (analysis.components.length < 2) continue;
    const clusters = joinInseparableClusters(analysis.components, admitted, edges);
    if (clusters.length < 2) continue;
    const totalWeight = clusters.reduce((sum, cluster) => sum + cluster.internalWeight, 0);
    const largestWeightShare = clusters[0].internalWeight / totalWeight;
    if (largestWeightShare >= TEMPORAL_COHESION_SPLIT_MAX_SHARE) continue;
    const coChangingFiles = new Set(edges.flatMap((edge) => [edge.relPathA, edge.relPathB])).size;
    const clusteredFiles = clusters.reduce((sum, cluster) => sum + cluster.nodes.length, 0);
    if (clusteredFiles * 2 <= coChangingFiles) continue;
    splitCandidates.push({
      component,
      clusters: clusters.length,
      largestWeightShare,
      files: clusters.map((cluster) => cluster.nodes.slice(0, SPLIT_CLUSTER_EXEMPLAR_FILES)),
    });
  }
  splitCandidates.sort(
    (a, b) =>
      b.clusters - a.clusters ||
      a.largestWeightShare - b.largestWeightShare ||
      compareCodePoints(a.component, b.component),
  );

  const mergeCandidates = componentPairs
    .filter((pair) => policy.admits(pair.strength))
    .sort(
      (a, b) =>
        b.strength - a.strength ||
        b.support - a.support ||
        compareCodePoints(a.componentA, b.componentA) ||
        compareCodePoints(a.componentB, b.componentB),
    );

  return {
    splitCandidates,
    mergeCandidates,
    threshold: policy.threshold,
    thresholdMethod: policy.method,
    excluded,
  };
}

/** One co-change cluster inside a component: its files and admitted weight. */
interface SplitCluster {
  nodes: readonly RelPath[];
  internalWeight: number;
}

/**
 * Join the clusters the history does not separate: a stored pair across two
 * clusters whose support reaches the weaker cluster's bottleneck — the
 * smallest support the cluster needs to stay connected — chains them. Joined
 * clusters keep the primitive's order: heaviest first, files code-point ordered.
 */
function joinInseparableClusters(
  clusters: readonly SplitCluster[],
  admitted: readonly TemporalCochangeEdge[],
  internal: readonly TemporalCochangeEdge[],
): SplitCluster[] {
  const clusterOf = new Map<RelPath, number>();
  clusters.forEach((cluster, index) => {
    for (const node of cluster.nodes) clusterOf.set(node, index);
  });
  const bottlenecks = clusters.map((cluster, index) =>
    clusterBottleneckSupport(
      cluster.nodes.length,
      admitted.filter((edge) => clusterOf.get(edge.relPathA) === index),
    ),
  );
  const links: WeightedNodeEdge[] = [];
  for (const edge of internal) {
    const a = clusterOf.get(edge.relPathA);
    const b = clusterOf.get(edge.relPathB);
    if (a === undefined || b === undefined || a === b) continue;
    if (edge.support >= Math.min(bottlenecks[a], bottlenecks[b])) links.push({ a: String(a), b: String(b), weight: 1 });
  }
  const joined = new Set<number>();
  const splitClusters: SplitCluster[] = [];
  for (const group of weightThresholdComponents(links, { minWeight: 1 }).components) {
    const joinedIndices = group.nodes.map(Number);
    for (const member of joinedIndices) joined.add(member);
    splitClusters.push({
      nodes: joinedIndices.flatMap((member) => clusters[member].nodes).sort(compareCodePoints),
      internalWeight: joinedIndices.reduce((sum, member) => sum + clusters[member].internalWeight, 0),
    });
  }
  clusters.forEach((cluster, index) => {
    if (!joined.has(index)) splitClusters.push(cluster);
  });
  return splitClusters.sort((x, y) => y.internalWeight - x.internalWeight || compareCodePoints(x.nodes[0], y.nodes[0]));
}

/**
 * The largest support level at which a cluster's admitted pairs still connect
 * all its files — the weakest link of its maximum-support spanning tree.
 */
function clusterBottleneckSupport(fileCount: number, intra: readonly TemporalCochangeEdge[]): number {
  const bySupport = intra.map((edge) => ({ a: edge.relPathA, b: edge.relPathB, weight: edge.support }));
  const levels = [...new Set(bySupport.map((edge) => edge.weight))].sort((x, y) => y - x);
  for (const level of levels) {
    const { components } = weightThresholdComponents(bySupport, { minWeight: level });
    if (components.length === 1 && components[0].nodes.length === fileCount) return level;
  }
  // Unreachable for a cluster the primitive built from these pairs.
  return levels.at(-1) ?? 0;
}

/** One component lies in the other's own tree (directory or constant namespace). */
function isNestedComponentPair(componentA: string, componentB: string): boolean {
  return componentAncestry(componentB).includes(componentA) || componentAncestry(componentA).includes(componentB);
}

/** The stored pairs no verdict judged, by the first reason that applied. */
function countExclusions(
  edges: readonly TemporalCochangeEdge[],
  componentOf: ReadonlyMap<RelPath, string>,
): SplitMergeExclusionCounts {
  const excluded: SplitMergeExclusionCounts = { unpartitionedEndpoints: 0, crossComponentPairs: 0 };
  for (const edge of edges) {
    const a = componentOf.get(edge.relPathA);
    const b = componentOf.get(edge.relPathB);
    if (a === undefined || b === undefined) excluded.unpartitionedEndpoints++;
    else if (a !== b) excluded.crossComponentPairs++;
  }
  return excluded;
}

/** Locale-independent, so the order is the same on every machine. */
function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
