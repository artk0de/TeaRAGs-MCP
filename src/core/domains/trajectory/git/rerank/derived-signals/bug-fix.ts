import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { blendNormalized, confidenceDampening, fileNum, GIT_FILE_DAMPENING } from "./helpers.js";

/**
 * Measures the proportion of commits that were bug fixes.
 *
 * Purpose: identify code areas with high defect history.
 * Detects: error-prone modules, fragile logic, areas needing hardening or rewrite.
 * Scoring: higher bugFixRate → higher score. Confidence-dampened by commitCount
 *   (low-commit files produce unreliable fix ratios).
 * Used in: hotspots, bugHunt presets.
 * Raw source: bugFixRate — percentage of commits matching fix/bug patterns in messages.
 */
export class BugFixSignal implements DerivedSignalDescriptor {
  readonly name = "bugFix";
  readonly description = "Bug fix rate: code with more fix commits scores higher. L3 blends chunk+file bugFixRate.";
  readonly sources = ["file.bugFixRate", "chunk.bugFixRate"];
  readonly defaultBound = 100;
  readonly dampeningSource = GIT_FILE_DAMPENING;
  private static readonly FALLBACK_THRESHOLD = 8;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const fb = ctx?.bounds?.["file.bugFixRate"] ?? this.defaultBound;
    const cb = ctx?.bounds?.["chunk.bugFixRate"] ?? this.defaultBound;
    let value = blendNormalized(rawSignals, "bugFixRate", fb, cb, ctx?.signalLevel);
    const k = ctx?.dampeningThreshold ?? BugFixSignal.FALLBACK_THRESHOLD;
    value *= confidenceDampening(fileNum(rawSignals, "commitCount"), k);
    return value;
  }
}
