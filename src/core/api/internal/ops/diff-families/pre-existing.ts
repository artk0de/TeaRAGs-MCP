/**
 * `preExisting` for the pair/component families (bd tea-rags-mcp-89k7k.1.19.2,
 * spec D9). The run judges only DIFF-ADDED edges, so for these families
 * `preExisting` cannot mean "this edge was already there" (it never was) — it
 * means the violation already held at the diff base through ANOTHER edge:
 * the component pair already leaned the same way, or the component already sat
 * past the main-sequence threshold before the diff moved it. Same evidence
 * contract as `heldBeforeChange`: a missing fact is never "already held".
 */

import type { DiffDetectorBaseEdgeReader, DiffDetectorGraphReader } from "./diff-family-detector.js";

/**
 * The source component's files the diff did NOT touch, read from the INDEXED
 * graph: for an unchanged file the index equals the base. Same split as
 * `DiffDetectorRun#heldBeforeChange` - base reader for changed sources, index
 * for the rest.
 */
export interface UnchangedSourceFiles {
  /** The component's UNCHANGED files (the diff's own files excluded by the caller). */
  filesOf: (component: string) => readonly string[];
  /** The indexed graph; an absent port is an empty graph, never "already held". */
  graph: DiffDetectorGraphReader | undefined;
}

/**
 * Whether the diff BASE already held an edge from `pair.sourceComponent` into
 * `pair.targetComponent`. The base reader is asked for the diff's changed
 * sources (`sourceFilesOf`); a file it answers `undefined` for (base unknown)
 * and an absent reader contribute nothing. The source component's UNCHANGED
 * files (`unchanged`) are read from the indexed graph. A target that maps to
 * no component never matches.
 */
export function componentPairViolatedAtBase(
  pair: { sourceComponent: string; targetComponent: string },
  baseEdges: DiffDetectorBaseEdgeReader | undefined,
  componentOf: (relPath: string) => string | undefined,
  sourceFilesOf: (component: string) => readonly string[],
  unchanged?: UnchangedSourceFiles,
): boolean {
  const leansOnTarget = (targets: Iterable<string>): boolean => {
    for (const target of targets) {
      if (componentOf(target) === pair.targetComponent) return true;
    }
    return false;
  };
  const heldByChangedSource =
    baseEdges !== undefined &&
    sourceFilesOf(pair.sourceComponent).some((relPath) => {
      const targets = baseEdges.targetsAtBase(relPath);
      return targets !== undefined && leansOnTarget(targets);
    });
  if (heldByChangedSource) return true;
  if (unchanged?.graph === undefined) return false;
  const { graph } = unchanged;
  return unchanged
    .filesOf(pair.sourceComponent)
    .some((relPath) => leansOnTarget(graph.edgesFrom(relPath).map((edge) => edge.target)));
}

/**
 * Whether the component's distance from the main sequence was ALREADY past
 * the threshold before the diff — strictly greater: a distance AT the
 * threshold is on it, not past it, so a diff that lifts it over the line
 * (the D5 flap) is the diff's own finding.
 */
export function pastThresholdBefore(distanceBefore: number, tolerance: number): boolean {
  return distanceBefore > tolerance;
}

/**
 * The targets `relPath` imported BEFORE the change, by the evidence order of
 * the run's `heldBeforeChange`: the diff base whenever it answers for the
 * file, else the indexed graph; `undefined` when neither port is wired — a
 * missing fact, never "imported nothing".
 */
export function targetsBeforeChange(
  relPath: string,
  baseEdges: DiffDetectorBaseEdgeReader | undefined,
  graph: DiffDetectorGraphReader | undefined,
): ReadonlySet<string> | undefined {
  const atBase = baseEdges?.targetsAtBase(relPath);
  if (atBase !== undefined) return atBase;
  return graph === undefined ? undefined : new Set(graph.edgesFrom(relPath).map((indexed) => indexed.target));
}
