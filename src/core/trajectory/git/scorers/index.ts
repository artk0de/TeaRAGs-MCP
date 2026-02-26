/**
 * Git scorer registry — all 14 leaf scorers as class instances.
 *
 * Each scorer extracts a single normalized (0-1) signal from a search
 * result payload. The array order matches ScoringWeights key order.
 */

import type { Scorer } from "../../../api/scorer.js";
import { AgeScorer } from "./age.js";
import { BlockPenaltyScorer } from "./block-penalty.js";
import { BugFixScorer } from "./bug-fix.js";
import { BurstActivityScorer } from "./burst-activity.js";
import { ChunkChurnScorer } from "./chunk-churn.js";
import { ChunkRelativeChurnScorer } from "./chunk-relative-churn.js";
import { ChurnScorer } from "./churn.js";
import { DensityScorer } from "./density.js";
import { KnowledgeSiloScorer } from "./knowledge-silo.js";
import { OwnershipScorer } from "./ownership.js";
import { RecencyScorer } from "./recency.js";
import { RelativeChurnScorer } from "./relative-churn.js";
import { StabilityScorer } from "./stability.js";
import { VolatilityScorer } from "./volatility.js";

export { AgeScorer } from "./age.js";
export { BlockPenaltyScorer } from "./block-penalty.js";
export { BugFixScorer } from "./bug-fix.js";
export { BurstActivityScorer } from "./burst-activity.js";
export { ChunkChurnScorer } from "./chunk-churn.js";
export { ChunkRelativeChurnScorer } from "./chunk-relative-churn.js";
export { ChurnScorer } from "./churn.js";
export { DensityScorer } from "./density.js";
export { KnowledgeSiloScorer } from "./knowledge-silo.js";
export { OwnershipScorer } from "./ownership.js";
export { RecencyScorer } from "./recency.js";
export { RelativeChurnScorer } from "./relative-churn.js";
export { StabilityScorer } from "./stability.js";
export { VolatilityScorer } from "./volatility.js";

/**
 * All 14 git leaf scorers as instantiated class objects.
 */
export const gitScorers: Scorer[] = [
  new RecencyScorer(),
  new StabilityScorer(),
  new ChurnScorer(),
  new AgeScorer(),
  new OwnershipScorer(),
  new BugFixScorer(),
  new VolatilityScorer(),
  new DensityScorer(),
  new ChunkChurnScorer(),
  new RelativeChurnScorer(),
  new BurstActivityScorer(),
  new KnowledgeSiloScorer(),
  new ChunkRelativeChurnScorer(),
  new BlockPenaltyScorer(),
];
