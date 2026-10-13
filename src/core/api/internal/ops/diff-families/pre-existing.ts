/**
 * `preExisting` for the pair/component families (bd tea-rags-mcp-89k7k.1.19.2,
 * spec D9). The run judges only DIFF-ADDED edges, so for these families
 * `preExisting` cannot mean "this edge was already there" (it never was) — it
 * means the violation already held at the diff base through ANOTHER edge:
 * the component pair already leaned the same way, or the component already sat
 * past the main-sequence threshold before the diff moved it. Same evidence
 * contract as `heldBeforeChange`: a missing fact is never "already held".
 */

import type { DiffDetectorBaseEdgeReader } from "./diff-family-detector.js";

/**
 * Whether the diff BASE already held an edge from `pair.sourceComponent` into
 * `pair.targetComponent`. Only the base reader is asked — the files it reads
 * are the diff's changed sources, so `sourceFilesOf` names the source
 * component's files the reader can answer for; a file it answers `undefined`
 * for (base unknown) and an absent reader contribute nothing. A target that
 * maps to no component never matches.
 */
export function componentPairViolatedAtBase(
  pair: { sourceComponent: string; targetComponent: string },
  baseEdges: DiffDetectorBaseEdgeReader | undefined,
  componentOf: (relPath: string) => string | undefined,
  sourceFilesOf: (component: string) => readonly string[],
): boolean {
  if (baseEdges === undefined) return false;
  return sourceFilesOf(pair.sourceComponent).some((sourceRelPath) => {
    const targets = baseEdges.targetsAtBase(sourceRelPath);
    if (targets === undefined) return false;
    for (const target of targets) {
      if (componentOf(target) === pair.targetComponent) return true;
    }
    return false;
  });
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
