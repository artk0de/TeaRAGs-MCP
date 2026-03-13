/**
 * Git trajectory reranking constants.
 *
 * Provider-specific configuration for dampening and alpha-blending thresholds.
 * Generic algorithms (computeAlpha, blend, confidenceDampening) live in contracts/signal-utils.
 */

import type { DampeningConfig } from "../../../../contracts/types/trajectory.js";

/** Dampening config shared by all git file-level derived signals. */
export const GIT_FILE_DAMPENING: DampeningConfig = { key: "git.file.commitCount", percentile: 25 };
