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
  const heldByChangedSource =
    baseEdges !== undefined &&
    componentPairHeldBeforeChange(
      pair,
      (sourceRelPath) => baseEdges.targetsAtBase(sourceRelPath),
      componentOf,
      sourceFilesOf,
    );
  if (heldByChangedSource) return true;
  if (unchanged?.graph === undefined) return false;
  const { graph } = unchanged;
  return componentPairHeldBeforeChange(
    pair,
    (sourceRelPath) => new Set(graph.edgesFrom(sourceRelPath).map((edge) => edge.target)),
    componentOf,
    unchanged.filesOf,
  );
}

/**
 * The pair check every pair family's `preExisting` runs: whether some file of
 * `pair.sourceComponent` (as `sourceFilesOf` names them) imported a file of
 * `pair.targetComponent` before the change, by whatever evidence
 * `targetsBefore` reads — the base alone ({@link componentPairViolatedAtBase})
 * or the base-else-index order of {@link targetsBeforeChange}. A file it
 * answers `undefined` for contributes nothing; a target that maps to no
 * component never matches.
 */
export function componentPairHeldBeforeChange(
  pair: { sourceComponent: string; targetComponent: string },
  targetsBefore: (relPath: string) => ReadonlySet<string> | undefined,
  componentOf: (relPath: string) => string | undefined,
  sourceFilesOf: (component: string) => readonly string[],
): boolean {
  return sourceFilesOf(pair.sourceComponent).some((sourceRelPath) => {
    const targets = targetsBefore(sourceRelPath);
    if (targets === undefined) return false;
    for (const target of targets) {
      if (componentOf(target) === pair.targetComponent) return true;
    }
    return false;
  });
}

/**
 * Whether `relPath` already carried an edge out of `sourceComponent` before
 * the change — whether the component's file-counted Ce (the report's
 * `buildComponentGraph`) already held it, so a diff-added crossing edge from
 * it moves Ce by nothing. `targetsBefore` is the evidence order the family
 * reads ({@link targetsBeforeChange}); a file it answers `undefined` for was
 * not efferent (a missing fact counts the file). A target mapping to no
 * component never counts. `excludesTargetComponent` drops target components
 * the reading does not count — the hub reading's measured foundation (bd
 * tea-rags-mcp-g77p3); main-sequence counts every component, as Martin's I
 * does (bd tea-rags-mcp-zuwvv). `excludesTargetFile` drops single target
 * files the same way — the hub reading's inheritance edges (bd
 * tea-rags-mcp-r8hme.52.18).
 */
export function wasEfferentBeforeChange(
  relPath: string,
  sourceComponent: string,
  targetsBefore: (relPath: string) => ReadonlySet<string> | undefined,
  componentOf: (relPath: string) => string | undefined,
  options: {
    excludesTargetComponent?: (component: string) => boolean;
    excludesTargetFile?: (targetRelPath: string) => boolean;
  } = {},
): boolean {
  const targets = targetsBefore(relPath);
  if (targets === undefined) return false;
  for (const target of targets) {
    const targetComponent = componentOf(target);
    if (targetComponent === undefined || targetComponent === sourceComponent) continue;
    if (options.excludesTargetComponent?.(targetComponent) === true) continue;
    if (options.excludesTargetFile?.(target) === true) continue;
    return true;
  }
  return false;
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
