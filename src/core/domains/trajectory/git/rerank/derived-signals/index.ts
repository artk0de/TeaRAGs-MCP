/**
 * Git derived signal descriptors — barrel export.
 *
 * Each signal is a class implementing DerivedSignalDescriptor with L3
 * alpha-blending where applicable. Shared helpers live in helpers.ts.
 */

import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import { AgeSignal } from "./age.js";
import { BlockPenaltySignal } from "./block-penalty.js";
import { BugFixSignal } from "./bug-fix.js";
import { BurstActivitySignal } from "./burst-activity.js";
import { ChunkChurnSignal } from "./chunk-churn.js";
import { ChunkRelativeChurnSignal } from "./chunk-relative-churn.js";
import { ChurnSignal } from "./churn.js";
import { DensitySignal } from "./density.js";
import { KnowledgeSiloSignal } from "./knowledge-silo.js";
import { OwnershipSignal } from "./ownership.js";
import { RecencySignal } from "./recency.js";
import { RelativeChurnNormSignal } from "./relative-churn-norm.js";
import { StabilitySignal } from "./stability.js";
import { VolatilitySignal } from "./volatility.js";

export { AgeSignal } from "./age.js";
export { BlockPenaltySignal } from "./block-penalty.js";
export { BugFixSignal } from "./bug-fix.js";
export { BurstActivitySignal } from "./burst-activity.js";
export { ChunkChurnSignal } from "./chunk-churn.js";
export { ChunkRelativeChurnSignal } from "./chunk-relative-churn.js";
export { ChurnSignal } from "./churn.js";
export { DensitySignal } from "./density.js";
export { KnowledgeSiloSignal } from "./knowledge-silo.js";
export { OwnershipSignal } from "./ownership.js";
export { RecencySignal } from "./recency.js";
export { RelativeChurnNormSignal } from "./relative-churn-norm.js";
export { StabilitySignal } from "./stability.js";
export { VolatilitySignal } from "./volatility.js";

export const gitDerivedSignals: DerivedSignalDescriptor[] = [
  new RecencySignal(),
  new StabilitySignal(),
  new ChurnSignal(),
  new AgeSignal(),
  new OwnershipSignal(),
  new BugFixSignal(),
  new VolatilitySignal(),
  new DensitySignal(),
  new ChunkChurnSignal(),
  new RelativeChurnNormSignal(),
  new BurstActivitySignal(),
  new KnowledgeSiloSignal(),
  new ChunkRelativeChurnSignal(),
  new BlockPenaltySignal(),
];
