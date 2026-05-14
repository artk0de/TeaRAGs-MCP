/**
 * Git trajectory reranking constants.
 *
 * Provider-specific configuration for dampening and alpha-blending thresholds.
 * Generic algorithms (computeAlpha, blend, confidenceDampening) live in infra/signal-utils.
 */

import type { DampeningConfig } from "../../../../contracts/types/trajectory.js";

/**
 * Dampening config shared by all git file-level derived signals.
 *
 * @deprecated Migrate to the unified `stats.confidence` block on the raw
 * payload descriptor. Signals that still reference this constant
 * (VolatilitySignal, RecentActivityConcentrationSignal, DensitySignal,
 * RelativeChurnNormSignal, KnowledgeSiloSignal, OwnershipSignal) read
 * adaptive thresholds from `ctx.dampeningThreshold` resolved via this
 * config. BugFixSignal has been migrated and reads from
 * `ctx.confidence.score.threshold` instead. Follow-up tracked in beads
 * (created in Task 5 closure). See `.claude/rules/signal-confidence.md`.
 */
export const GIT_FILE_DAMPENING: DampeningConfig = { key: "git.file.commitCount", percentile: 25 };
