import type { DiffDetectorFinding } from "../../../../contracts/types/diff-detector-finding.js";
import type {
  DiffDetectorBaseEdgeReader,
  DiffDetectorCatalog,
  DiffDetectorGraphReader,
  DiffFamilyDetector,
  OverlayEdge,
} from "./diff-family-detector.js";
import { pastThresholdBefore, targetsBeforeChange, wasEfferentBeforeChange } from "./pre-existing.js";
import { detectorStatus, format3, round3, withRenderedSubject } from "./shared.js";

/** Below this |deltaD| a touched component's main-sequence move reads as no move. */
const MAIN_SEQUENCE_EPSILON = 0.001;

/**
 * Flap tolerance (bd tea-rags-mcp-odhsp): the DDG skill's rule D5 reads a
 * main-sequence distance move of |dD| <= 0.02 as a flap, never a defect. The
 * detector holds the rule itself, so a move within tolerance is no finding —
 * it is counted on the family row (`excludedFlapCount`). Compared on the
 * three-decimal evidence precision, so a move AT the tolerance suppresses
 * instead of tripping on float noise.
 */
const MAIN_SEQUENCE_FLAP_TOLERANCE = 0.02;

/** One touched component's diff-added cross-component edges and the files they make efferent for the first time. */
interface CrossingEdges {
  edges: OverlayEdge[];
  newlyEfferentFiles: Set<string>;
}

/**
 * Main-sequence DELTAS for the components of changed files only — untouched
 * components never appear, and a touched component that does not move does
 * not either.
 *
 * SMALL-N GUARD (bd tea-rags-mcp-r8hme.45): a touched component whose
 * `connectionCount` is below `minConnectionCount` — the same SDP floor the
 * whole-repo detector excludes at — is not judged, only counted on the
 * family's status row. At connectionCount n a component's instability moves
 * in steps of 1/n, so one new edge on a one-or-two-edge component is a
 * half-to-full-scale move — the small-N false positive every facade/refactor
 * diff drew on components whose legal fanOut is one contracts edge. The
 * guard reads the BASE `connectionCount` (below), which the recompute never
 * moves (k lands on top of the fan, not inside it), so it composes with both
 * paths.
 *
 * BEFORE = THE BASE (bd tea-rags-mcp-aht0q): the catalog's facts are the
 * INDEX's, and an index that caught up past the merge-base already holds the
 * diff's own edges — adding k on top counted them twice (a component the base
 * did not hold reported its post-diff fan as "before"). So a changed file
 * whose indexed edges reach another component while its base edges do not is
 * subtracted from Ce (and from Ca of each component it newly reaches) before
 * k lands, and I, D are recomputed there at the held abstractness. A
 * component the base connected to nothing has no before side and is counted
 * with the low-connection exclusions. An index AT the base subtracts nothing,
 * so the facts stay the catalog's verbatim. A reconstructed before-distance
 * farther from the sequence than the diff leaves is a move ONTO it — no
 * finding.
 *
 * EXACT RECOMPUTE (bd tea-rags-mcp-89k7k.19): when the catalog serves the
 * component's fan counts (Ca/Ce — the same `ArchitectureComponent` facts
 * the whole-repo report derives), the SOURCE's component's instability moves
 * to exactly I' = (Ce + k)/(Ca + Ce + k) — the whole-repo detector's own
 * instability arithmetic re-applied to the post-diff fan. One newly efferent
 * file on a 24-connection component moves I by ~1/25, never the full-scale
 * step that saturated such a component to I=1.000 and D 0.946 from a single
 * facade import (the 89k7k.14 replay residual: the +1-per-edge step had no
 * access to the fan counts through the diff ports).
 *
 * k = NEWLY EFFERENT FILES (bd tea-rags-mcp-zuwvv): the report's Ce
 * (`buildComponentGraph`) counts DISTINCT source files with at least one
 * cross-component edge, so k is the number of distinct sources among the
 * component's diff-added cross-component edges whose targets BEFORE the
 * change (`targetsBeforeChange`: the diff base where it answers, else the
 * index) reached no file of another component. A file already efferent
 * never moves Ce again — five new imports from it move nothing; a missing
 * pre-change fact counts the file. Foundation targets count like any other:
 * Martin's I counts them, and only the hub reading excludes them (g77p3).
 * The edges are the subtraction's output (bd tea-rags-mcp-89k7k.14: a pair
 * the indexed graph already holds never moves anything); `evidence.edges`
 * lists every one of them, and k = 0 is no move (the epsilon below).
 *
 * FALLBACK (the 89k7k.14 absence rule, documented per spec): a catalog that
 * serves no fan counts keeps the +1 step — one full step per newly efferent
 * file (the same k) clamped at I=1 — because the fan counts are not reachable
 * through that port, and a missing fact is never read as "no edges". Abstractness A is held
 * constant at the +D solution of D = |A + I - 1| (A = 1 - I + D): which side
 * of the main sequence the component sits on is not exposed by the catalog
 * either, and on that solution the deltaD equals the I increment — the
 * worst case (distance grows), which is what a diff review wants flagged.
 *
 * FOUNDATION-TERMINAL ANNOTATION (bd tea-rags-mcp-r8hme.45): a finding
 * whose contributing edges ALL terminate inside the measured layering
 * foundation (`DiffDetectorCatalog#isLayeringFoundation`, bd
 * tea-rags-mcp-89k7k.35.11 — the same set the whole-repo layering reports as its
 * foundation, never a directory name) carries `foundationTerminal: true`
 * — the legal foundation direction (everything may depend on the lowest
 * layer). Contributing edges are the DIFF-ADDED ones (post-subtraction):
 * pre-existing imports do not dilute the annotation. The D still moved, so
 * the finding stands, annotated as data for triage; one diff-added edge
 * outside the foundation is enough to leave it unannotated.
 *
 * `preExisting` (bd tea-rags-mcp-89k7k.1.19.2, spec D9): the component's D
 * BEFORE the diff was already past the whole-repo distance threshold — the
 * diff moved a component that was already a violation. A diff that carries
 * D across the threshold (the D5 flap) is the diff's own finding; an unserved
 * threshold attributes nothing.
 */
export const mainSequenceDetector: DiffFamilyDetector = {
  family: "mainSequence",
  judge: ({
    scope,
    addedDependencyEdges,
    catalog,
    baseEdges,
    graph,
    minConnectionCount,
    mainSequenceDistanceThreshold,
  }) => {
    const touched = new Map<
      string,
      {
        instability: number;
        distanceFromMainSequence: number;
        afferentCount?: number;
        efferentCount?: number;
        abstractness: number;
        entryFacade?: true;
      }
    >();
    const judgedComponents = new Set<string>();
    let excludedLowConnectionCount = 0;
    const indexSurplus = readIndexAheadFanSurplus(
      scope.changedFiles,
      baseEdges,
      graph,
      (relPath) => catalog.componentOf(relPath)?.name,
    );
    for (const relPath of scope.changedFiles) {
      const component = catalog.componentOf(relPath);
      if (component === undefined || judgedComponents.has(component.name)) continue;
      judgedComponents.add(component.name);
      const baseFact = baseComponentFact(component, indexSurplus.get(component.name));
      if (baseFact === undefined || baseFact.connectionCount < minConnectionCount) {
        excludedLowConnectionCount++;
        continue;
      }
      touched.set(component.name, {
        instability: baseFact.instability,
        distanceFromMainSequence: baseFact.distanceFromMainSequence,
        afferentCount: baseFact.afferentCount,
        efferentCount: baseFact.efferentCount,
        abstractness: baseFact.abstractness,
        ...(component.entryFacade ? { entryFacade: true as const } : {}),
      });
    }
    const crossingEdges = new Map<string, CrossingEdges>();
    const efferentBefore = new Map<string, boolean>();
    const wasEfferentBefore = (source: string, sourceComponent: string): boolean => {
      let efferent = efferentBefore.get(source);
      if (efferent === undefined) {
        efferent = wasEfferentBeforeChange(
          source,
          sourceComponent,
          (relPath) => targetsBeforeChange(relPath, baseEdges, graph),
          (relPath) => catalog.componentOf(relPath)?.name,
        );
        efferentBefore.set(source, efferent);
      }
      return efferent;
    };
    for (const edge of addedDependencyEdges) {
      const sourceComponent = catalog.componentOf(edge.source);
      const targetComponent = catalog.componentOf(edge.target);
      if (sourceComponent === undefined || targetComponent === undefined) continue;
      if (sourceComponent.name === targetComponent.name || !touched.has(sourceComponent.name)) continue;
      let crossing = crossingEdges.get(sourceComponent.name);
      if (crossing === undefined) {
        crossing = { edges: [], newlyEfferentFiles: new Set() };
        crossingEdges.set(sourceComponent.name, crossing);
      }
      crossing.edges.push(edge);
      if (!wasEfferentBefore(edge.source, sourceComponent.name)) crossing.newlyEfferentFiles.add(edge.source);
    }

    const findings: DiffDetectorFinding[] = [];
    let excludedFlapCount = 0;
    for (const [name, fact] of touched) {
      const crossing = crossingEdges.get(name);
      if (crossing === undefined) continue;
      const { edges: edgesOut } = crossing;
      const newlyEfferentFileCount = crossing.newlyEfferentFiles.size;
      // Both counts or neither: one alone cannot feed the exact recompute, and
      // a half-served fan is the same absent fact as none (the 89k7k.14 rule).
      const fans =
        fact.afferentCount !== undefined && fact.efferentCount !== undefined
          ? { afferentCount: fact.afferentCount, efferentCount: fact.efferentCount }
          : undefined;
      const newInstability =
        fans !== undefined
          ? (fans.efferentCount + newlyEfferentFileCount) /
            (fans.afferentCount + fans.efferentCount + newlyEfferentFileCount)
          : Math.min(1, fact.instability + newlyEfferentFileCount);
      const instabilityDelta = newInstability - fact.instability;
      if (Math.abs(instabilityDelta) <= MAIN_SEQUENCE_EPSILON) continue;
      const newDistance = Math.abs(fact.abstractness + newInstability - 1);
      // A move ONTO the main sequence is no defect: only an index ahead of the
      // base reconstructs a before-distance farther out than the diff leaves.
      if (newDistance < fact.distanceFromMainSequence) continue;
      if (round3(Math.abs(newDistance - fact.distanceFromMainSequence)) <= MAIN_SEQUENCE_FLAP_TOLERANCE) {
        excludedFlapCount++;
        continue;
      }
      const foundationTerminal = edgesOut.every((edge) => catalog.isLayeringFoundation(edge.target));
      // The exact-recompute clause names the arithmetic only when its inputs were served.
      const recomputeClause = fans !== undefined ? ` — I' = (Ce+k)/(Ca+Ce+k) over the report's fan counts` : "";
      findings.push(
        withRenderedSubject({
          detector: "mainSequence",
          endpoints: { kind: "component", component: name },
          evidence: {
            distanceBefore: round3(fact.distanceFromMainSequence),
            distanceAfter: round3(newDistance),
            instabilityBefore: round3(fact.instability),
            instabilityAfter: round3(newInstability),
            ...(fans !== undefined ? { fanCounts: { ...fans, newlyEfferentFileCount } } : {}),
            edges: edgesOut.map((edge) => ({ sourceRelPath: edge.source, targetRelPath: edge.target })),
          },
          detail: `the diff moves ${name} off its main-sequence distance: ${newlyEfferentFileCount} newly efferent file(s) over ${edgesOut.length} cross-component outgoing edge(s) raise instability ${format3(fact.instability)} -> ${format3(newInstability)} with abstractness held${recomputeClause}`,
          ...(foundationTerminal ? { foundationTerminal: true as const } : {}),
          // The unstable end of the main sequence is where an entry component
          // belongs (the measured entry-facade component): annotated, still
          // reported.
          ...(fact.entryFacade ? { entryPoint: true as const } : {}),
          ...(mainSequenceDistanceThreshold !== undefined &&
          pastThresholdBefore(fact.distanceFromMainSequence, mainSequenceDistanceThreshold)
            ? { preExisting: true as const }
            : {}),
        }),
      );
    }
    const excluded = {
      ...(excludedLowConnectionCount > 0 ? { excludedLowConnectionCount } : {}),
      ...(excludedFlapCount > 0 ? { excludedFlapCount } : {}),
    };
    return {
      findings,
      status:
        Object.keys(excluded).length > 0
          ? Object.freeze({ ...detectorStatus("mainSequence", findings.length), ...excluded })
          : detectorStatus("mainSequence", findings.length),
    };
  },
};

/**
 * The changed files an index AHEAD of the merge-base counts in one
 * component's fan while the base did not (bd tea-rags-mcp-aht0q): the diff's
 * own contribution the catalog's index-derived Ca/Ce already hold.
 */
interface IndexAheadFanSurplus {
  /** The component's changed files efferent in the index and not at the base. */
  efferentFileCount: number;
  /** Changed files of OTHER components with an indexed edge into it and none at the base. */
  afferentFileCount: number;
}

/** A touched component's main-sequence facts at the diff base — the before side of the delta. */
interface MainSequenceBeforeFact {
  instability: number;
  distanceFromMainSequence: number;
  connectionCount: number;
  afferentCount?: number;
  efferentCount?: number;
  /** Held across the delta: the +D solution of D = |A + I - 1| over the catalog's facts. */
  abstractness: number;
}

/**
 * Per component, the {@link IndexAheadFanSurplus} of the changed files. Only
 * a file BOTH ports answer for contributes — the base's targets against the
 * indexed graph's — so an index at the base subtracts nothing, and an absent
 * port, or a base that does not answer for a file, keeps the index's count
 * (a missing fact is never read as "the index is ahead"). Subtraction only:
 * the base efferency an index BEHIND the base lacks is not added back.
 */
function readIndexAheadFanSurplus(
  changedFiles: readonly string[],
  baseEdges: DiffDetectorBaseEdgeReader | undefined,
  graph: DiffDetectorGraphReader | undefined,
  componentNameOf: (relPath: string) => string | undefined,
): Map<string, IndexAheadFanSurplus> {
  const surplus = new Map<string, IndexAheadFanSurplus>();
  if (baseEdges === undefined || graph === undefined) return surplus;
  const surplusOf = (component: string): IndexAheadFanSurplus => {
    let counts = surplus.get(component);
    if (counts === undefined) {
      counts = { efferentFileCount: 0, afferentFileCount: 0 };
      surplus.set(component, counts);
    }
    return counts;
  };
  for (const relPath of new Set(changedFiles)) {
    const sourceComponent = componentNameOf(relPath);
    const atBase = baseEdges.targetsAtBase(relPath);
    if (sourceComponent === undefined || atBase === undefined) continue;
    const reachedAtBase = componentsReached(atBase, sourceComponent, componentNameOf);
    const reachedInIndex = componentsReached(
      graph.edgesFrom(relPath).map((indexed) => indexed.target),
      sourceComponent,
      componentNameOf,
    );
    if (reachedInIndex.size > 0 && reachedAtBase.size === 0) surplusOf(sourceComponent).efferentFileCount++;
    for (const component of reachedInIndex) {
      if (!reachedAtBase.has(component)) surplusOf(component).afferentFileCount++;
    }
  }
  return surplus;
}

/** The components other than `sourceComponent` the targets fall in. */
function componentsReached(
  targets: Iterable<string>,
  sourceComponent: string,
  componentNameOf: (relPath: string) => string | undefined,
): Set<string> {
  const reached = new Set<string>();
  for (const target of targets) {
    const component = componentNameOf(target);
    if (component !== undefined && component !== sourceComponent) reached.add(component);
  }
  return reached;
}

/**
 * The component's facts at the diff base: the catalog's verbatim when no
 * surplus applies (or no fan counts are served — the +1 fallback has no fan
 * to correct), else the fan with the surplus subtracted and I, D recomputed
 * at the held abstractness. `undefined` when the base connected the
 * component to nothing — no before side, so no main-sequence move.
 */
function baseComponentFact(
  component: NonNullable<ReturnType<DiffDetectorCatalog["componentOf"]>>,
  surplus: IndexAheadFanSurplus | undefined,
): MainSequenceBeforeFact | undefined {
  const abstractness = 1 - component.instability + component.distanceFromMainSequence;
  const { afferentCount, efferentCount } = component;
  if (surplus === undefined || afferentCount === undefined || efferentCount === undefined) {
    return {
      instability: component.instability,
      distanceFromMainSequence: component.distanceFromMainSequence,
      connectionCount: component.connectionCount,
      afferentCount,
      efferentCount,
      abstractness,
    };
  }
  const baseAfferentCount = Math.max(0, afferentCount - surplus.afferentFileCount);
  const baseEfferentCount = Math.max(0, efferentCount - surplus.efferentFileCount);
  if (baseAfferentCount + baseEfferentCount === 0) return undefined;
  const instability = baseEfferentCount / (baseAfferentCount + baseEfferentCount);
  return {
    instability,
    distanceFromMainSequence: Math.abs(abstractness + instability - 1),
    connectionCount: Math.max(
      0,
      component.connectionCount - (afferentCount - baseAfferentCount) - (efferentCount - baseEfferentCount),
    ),
    afferentCount: baseAfferentCount,
    efferentCount: baseEfferentCount,
    abstractness,
  };
}
