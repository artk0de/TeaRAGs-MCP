/**
 * Factory for composite scorers.
 *
 * Creates all composite scorer instances that can be bound to
 * leaf scorers and used for derived signal computation.
 */

import { HotspotScorer } from "../search/scorers/hotspot.js";
import { TechDebtScorer } from "../search/scorers/tech-debt.js";
import type { CompositeScorer } from "./scorer.js";

/**
 * Create all composite scorer instances.
 * Returns new instances on each call (not singletons).
 */
export function createCompositeScorers(): CompositeScorer[] {
  return [new TechDebtScorer(), new HotspotScorer()];
}
