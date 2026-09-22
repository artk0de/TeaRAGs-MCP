/**
 * StatsContractDriftMonitor — the collection's percentiles were measured under
 * a sampling procedure this build no longer uses.
 *
 * The axis exists because the stats cache had no stamp of any kind, so a change
 * to what a signal samples was invisible: `.claude/rules/migrations.md` says as
 * much, and the consequence was a file-scope skew that sat in the index
 * unreported while filter presets and adaptive bounds read from it.
 *
 * The remedy is `incremental` — the lowest rung that fixes it — because the
 * values are already in the payload and the stats migration recomputes them
 * during a plain `index-codebase` run, ahead of change detection. Nothing is
 * re-embedded and no enrichment is recomputed, so asking for `--force` here, or
 * even `--force-enrichments`, would charge minutes-to-hours for work the cheap
 * command already does.
 */

import type { PayloadSignalDescriptor } from "../../../contracts/types/trajectory.js";
import type { StatsCache } from "../../../infra/stats-cache.js";
import type { IndexDriftFinding, IndexDriftMonitor } from "./monitor.js";
import { judgeStatsContract } from "./stats-contract-drift.js";

export class StatsContractDriftMonitor implements IndexDriftMonitor {
  readonly axis = "statsContract" as const;

  constructor(
    private readonly statsCache: StatsCache,
    private readonly currentSignals: readonly PayloadSignalDescriptor[],
  ) {}

  check(collectionName: string): IndexDriftFinding[] {
    const judgement = judgeStatsContract(this.statsCache.load(collectionName), this.currentSignals);
    if (!judgement) return [];

    return judgement.stale.map((finding) => ({
      axis: this.axis,
      subject: finding.key,
      indexed: finding.indexed,
      current: finding.current,
      remedy: { kind: "incremental" } as const,
      // Worth saying out loud on both paths. A reader who sees a percentile
      // complaint reaches for `--force` by reflex, and a shape-inferred finding
      // additionally has to explain itself: the file carries no stamp to quote.
      note:
        judgement.evidence === "shape"
          ? "inferred from the sample's shape — this index predates the sampling stamp; an incremental run recomputes it from stored payload"
          : "an incremental run recomputes it from stored payload",
    }));
  }
}
