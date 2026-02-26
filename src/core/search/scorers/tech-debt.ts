/**
 * TechDebt composite scorer.
 *
 * Combines age and churn signals to identify technical debt:
 * old code that changes frequently is a strong debt indicator.
 *
 * Formula: age * 0.4 + churn * 0.6
 */

import type { CompositeScorer, Scorer } from "../../api/scorer.js";

export class TechDebtScorer implements CompositeScorer {
  readonly name = "techDebt";
  readonly description = "Technical debt indicator — old code with high churn";
  readonly dependencies = ["age", "churn"];

  private sources = new Map<string, Scorer>();

  bind(scorers: Map<string, Scorer>): void {
    this.sources = scorers;
  }

  extract(payload: Record<string, unknown>): number {
    const age = this.sources.get("age");
    const churn = this.sources.get("churn");
    if (!age || !churn) return 0;
    return age.extract(payload) * 0.4 + churn.extract(payload) * 0.6;
  }
}
