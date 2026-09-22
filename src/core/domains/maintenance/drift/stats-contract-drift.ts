/**
 * Does a collection's stats file still answer the question this build asks?
 *
 * Percentiles are not display-only. Filter presets compile to Qdrant
 * pre-filters that compare against them, and the reranker's adaptive bounds are
 * floored with them, so a stats file computed under a different sampling
 * procedure moves RANKING, not just labels — silently, because the numbers look
 * perfectly ordinary.
 *
 * ONE judgement, two consumers: `StatsContractDriftMonitor` reports it and the
 * stats migration repairs it. Split them and prime starts reporting a drift the
 * reindex never clears, or clearing one it never reported.
 *
 * Two kinds of evidence, in order of strength:
 *
 *   • The STAMP. Files written since the sampling contract was introduced carry
 *     it, and comparing strings answers the question exactly.
 *   • The SHAPE. Every file written before that carries nothing — which is
 *     every index in existence at the time this was added, including the one
 *     whose skew prompted it. For the one property with a shape signature, the
 *     numbers give themselves away: a signal that contributes at most one
 *     observation per file cannot hold more observations than the collection
 *     has files.
 *
 * The shape test runs one way only. A small corpus can be chunk-weighted and
 * still stay under the file total, and that false "current" is the cheap
 * mistake — percentiles that were barely skewed. The opposite would have the
 * migration rescroll the collection on every reindex for a rebuild that cannot
 * change the evidence it is judged by.
 */

import { describeStatsSamplingContract } from "../../../contracts/signal-utils.js";
import type { CollectionSignalStats, PayloadSignalDescriptor } from "../../../contracts/types/trajectory.js";

export interface StatsContractFinding {
  /** Signal key whose sample no longer matches what the build declares. */
  key: string;
  indexed: string;
  current: string;
}

export interface StatsContractJudgement {
  stale: StatsContractFinding[];
  /** Which evidence decided it — `shape` means the file predates the stamp. */
  evidence: "stamp" | "shape";
}

/**
 * `null` when there is nothing to judge: no stats file at all. An EMPTY `stale`
 * list is the opposite answer — judged, and current.
 */
export function judgeStatsContract(
  stats: CollectionSignalStats | null,
  signals: readonly PayloadSignalDescriptor[],
): StatsContractJudgement | null {
  if (!stats) return null;
  return stats.samplingContract
    ? { stale: compareStamp(stats.samplingContract, signals), evidence: "stamp" }
    : { stale: inferFromShape(stats, signals), evidence: "shape" };
}

function compareStamp(
  indexed: Record<string, string>,
  signals: readonly PayloadSignalDescriptor[],
): StatsContractFinding[] {
  const current = describeStatsSamplingContract(signals);
  const findings: StatsContractFinding[] = [];
  for (const [key, declared] of Object.entries(current)) {
    const recorded = indexed[key];
    if (recorded === declared) continue;
    findings.push({ key, indexed: recorded ?? "not sampled", current: declared });
  }
  // A key the stamp carries and the build no longer declares is left alone:
  // nothing reads a signal this build does not have, so recomputing to drop it
  // buys nothing. The payload-key axis makes the same call for removed keys.
  return findings;
}

function inferFromShape(
  stats: CollectionSignalStats,
  signals: readonly PayloadSignalDescriptor[],
): StatsContractFinding[] {
  const totalFiles = stats.distributions?.totalFiles ?? 0;
  if (totalFiles <= 0) return [];

  const findings: StatsContractFinding[] = [];
  for (const signal of signals) {
    if (!signal.stats?.dedupeByFile) continue;
    const persisted = stats.perSignal.get(signal.key);
    if (!persisted || persisted.count <= totalFiles) continue;
    findings.push({
      key: signal.key,
      indexed: `${persisted.count} observations over ${totalFiles} files`,
      current: "one observation per file",
    });
  }
  return findings;
}
