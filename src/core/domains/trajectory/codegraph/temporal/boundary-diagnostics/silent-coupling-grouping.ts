/**
 * Presentation grouping of admitted silent-coupling pairs (bd
 * tea-rags-mcp-89k7k.1.14): one file co-changing significantly with many
 * partners — a key-addressed locale file beside every component that reads it
 * — used to fill the section with one row per pair. The pairs are real (the
 * significance gate admitted each one); the grouping only changes how they are
 * listed, never which are reported.
 *
 * Greedy partition: repeatedly take the endpoint holding the most still-
 * ungrouped pairs (ties by code-point order of the path); when it holds at
 * least {@link SILENT_COUPLING_GROUP_MIN_PAIRS}, every one of its ungrouped
 * pairs becomes its group. A pair belongs to exactly one group or stays a
 * singleton, so no pair is lost and none is listed twice.
 */

import type { RelPath } from "../../../../../contracts/types/codegraph.js";

/** A shared endpoint needs at least this many admitted pairs to be listed as one group. */
export const SILENT_COUPLING_GROUP_MIN_PAIRS = 2;

/** The pair shape grouping reads — both detectors' pairs satisfy it. */
export interface SilentCouplingGroupablePair {
  relPathA: RelPath;
  relPathB: RelPath;
}

/** One endpoint and the pairs grouped under it, in input order. */
export interface SilentCouplingPairGroup<P extends SilentCouplingGroupablePair> {
  relPath: RelPath;
  pairs: P[];
}

export interface SilentCouplingPairGrouping<P extends SilentCouplingGroupablePair> {
  /** Groups in the order the greedy pass took them: most pairs first, ties by path. */
  groups: SilentCouplingPairGroup<P>[];
  /** Pairs no group took, in input order. */
  singletons: P[];
}

/** The other endpoint of `pair`, seen from `relPath`. */
export function silentCouplingPartnerOf(pair: SilentCouplingGroupablePair, relPath: RelPath): RelPath {
  return pair.relPathA === relPath ? pair.relPathB : pair.relPathA;
}

/** Partition `pairs` into shared-endpoint groups and singletons (see the module docblock). */
export function groupSilentCouplingPairs<P extends SilentCouplingGroupablePair>(
  pairs: readonly P[],
): SilentCouplingPairGrouping<P> {
  const remaining = new Set<number>(pairs.keys());
  const groups: SilentCouplingPairGroup<P>[] = [];
  for (;;) {
    const counts = new Map<RelPath, number>();
    for (const i of remaining) {
      const { relPathA, relPathB } = pairs[i];
      counts.set(relPathA, (counts.get(relPathA) ?? 0) + 1);
      if (relPathB !== relPathA) counts.set(relPathB, (counts.get(relPathB) ?? 0) + 1);
    }
    let best: { relPath: RelPath; count: number } | undefined;
    for (const [relPath, count] of counts) {
      if (!best || count > best.count || (count === best.count && relPath < best.relPath)) best = { relPath, count };
    }
    if (!best || best.count < SILENT_COUPLING_GROUP_MIN_PAIRS) break;
    const taken: P[] = [];
    for (const i of [...remaining]) {
      const pair = pairs[i];
      if (pair.relPathA !== best.relPath && pair.relPathB !== best.relPath) continue;
      taken.push(pair);
      remaining.delete(i);
    }
    groups.push({ relPath: best.relPath, pairs: taken });
  }
  return { groups, singletons: [...remaining].map((i) => pairs[i]) };
}
