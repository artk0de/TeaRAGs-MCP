/**
 * Hotspot composite scorer.
 *
 * Combines churn, bug fix rate, and burst activity to identify
 * code hotspots — areas that change frequently, have bugs, and
 * show recent activity bursts.
 *
 * Formula: churn * 0.4 + bugFix * 0.3 + burstActivity * 0.3
 */

import type { CompositeScorer, Scorer } from "../../api/scorer.js";

export class HotspotScorer implements CompositeScorer {
  readonly name = "hotspot";
  readonly description = "Code hotspot indicator — high churn, bugs, and recent activity";
  readonly dependencies = ["churn", "bugFix", "burstActivity"];

  private sources = new Map<string, Scorer>();

  bind(scorers: Map<string, Scorer>): void {
    this.sources = scorers;
  }

  extract(payload: Record<string, unknown>): number {
    const churn = this.sources.get("churn");
    const bugFix = this.sources.get("bugFix");
    const burst = this.sources.get("burstActivity");
    if (!churn || !bugFix || !burst) return 0;
    return churn.extract(payload) * 0.4 + bugFix.extract(payload) * 0.3 + burst.extract(payload) * 0.3;
  }
}
