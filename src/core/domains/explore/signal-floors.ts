/**
 * Industry floors under percentile thresholds — spec
 * `docs/superpowers/specs/2026-08-02-module-mass-signals-design.md`.
 *
 * A percentile is relative by construction. On a clean codebase p95 marks the
 * largest 5% whatever their absolute size, so a tidy project always nominates
 * something as its worst; on a legacy monolith p50 can sit above every
 * published limit and a 400-line file reads as "small". The percentile answers
 * "large FOR THIS PROJECT"; the floor answers "large, full stop", and
 * `max(percentile, floor)` keeps both.
 *
 * Applied at the Metrics layer, never to the cached Stats: floors are domain
 * knowledge, not distribution math, so the stored distribution stays raw and a
 * floor change takes effect on the next query with no recompute and no
 * reindex. Both consumers of `SignalStats.percentiles` — the reranker's overlay
 * path and `IndexMetricsQuery`'s labelMap — route through this one function.
 *
 * Source scope only. Test files are systematically longer than production code
 * and the industry excludes them (RuboCop ships `Metrics/ModuleLength` with
 * `Exclude: spec/**`, ESLint `max-lines` is routinely disabled for tests);
 * under a shared floor most test files would collapse into the top label and
 * ranking tests by size would stop working. Callers pass `undefined` floors for
 * test scope, which is the identity case below.
 */

import type { SignalFloors } from "../../contracts/types/trajectory.js";

/**
 * Raise each percentile whose label declares a floor. Pure — returns a fresh
 * record and never touches the input.
 *
 * Monotonicity survives without a repair pass: percentiles are monotone by
 * construction and the declared floors are monotone (a drift-guard test pins
 * that), so the element-wise max of two monotone sequences is monotone.
 *
 * @param percentiles percentile number → threshold, as computed for the collection
 * @param labels the signal descriptor's `stats.labels` — `p95` → `"god-module"`
 * @param floors this language's floors for THIS signal, label → minimum
 */
export function applySignalFloors(
  percentiles: Record<number, number>,
  labels: Record<string, string>,
  floors: Readonly<Record<string, number>> | undefined,
): Record<number, number> {
  if (!floors || Object.keys(floors).length === 0) return percentiles;

  const raised = { ...percentiles };
  for (const [percentileKey, label] of Object.entries(labels)) {
    const floor = floors[label];
    if (floor === undefined) continue;
    const percentile = Number(percentileKey.slice(1));
    const current = raised[percentile];
    // A label whose percentile was never computed has no threshold to raise —
    // inventing one from the floor alone would report a tier the collection
    // carries no evidence for.
    if (current === undefined) continue;
    raised[percentile] = Math.max(current, floor);
  }
  return raised;
}

/** The floors declared for one signal of one language, or `undefined`. */
export function floorsForSignal(
  floorsByLanguage: ReadonlyMap<string, SignalFloors> | undefined,
  language: string | undefined,
  signalKey: string,
): Readonly<Record<string, number>> | undefined {
  if (!floorsByLanguage || !language) return undefined;
  return floorsByLanguage.get(language)?.[signalKey];
}
