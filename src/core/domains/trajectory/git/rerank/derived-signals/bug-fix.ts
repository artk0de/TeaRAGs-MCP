import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { blendNormalized, confidenceDampening, fileNum } from "./helpers.js";

/**
 * Measures the proportion of commits that were bug fixes.
 *
 * Purpose: identify code areas with high defect history.
 * Detects: error-prone modules, fragile logic, areas needing hardening or rewrite.
 * Scoring: higher bugFixRate → higher score. Confidence-dampened by the support
 *   sibling (default `commitCount`) per the unified `stats.confidence` block on
 *   the raw `git.file.bugFixRate` / `git.chunk.bugFixRate` descriptors.
 * Used in: hotspots, bugHunt presets.
 * Raw source: bugFixRate — percentage of commits matching fix/bug patterns in messages.
 *
 * Migration note: this signal previously declared `dampeningSource =
 * GIT_FILE_DAMPENING` and a private static `FALLBACK_THRESHOLD = 10`. Both
 * are removed — the threshold now comes from the raw descriptor's
 * `stats.confidence.score.threshold` (10 by default), routed via
 * `ExtractContext.confidence` by the Reranker. See `.claude/rules/signal-confidence.md`.
 */
export class BugFixSignal implements DerivedSignalDescriptor {
  readonly name = "bugFix";
  readonly description = "Bug fix rate: code with more fix commits scores higher. L3 blends chunk+file bugFixRate.";
  readonly sources = ["file.bugFixRate", "chunk.bugFixRate"];
  readonly defaultBound = 100;
  /** Final-resort threshold used only when no confidence block and no
   * adaptive dampeningThreshold are available. Kept defensive — the
   * descriptor SHOULD always declare confidence.score.threshold. */
  private static readonly FALLBACK_K = 10;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const fb = ctx?.bounds?.["file.bugFixRate"] ?? this.defaultBound;
    const cb = ctx?.bounds?.["chunk.bugFixRate"] ?? this.defaultBound;
    let value = blendNormalized(rawSignals, "bugFixRate", fb, cb, ctx?.signalLevel);
    // Precedence: ADAPTIVE (from collection stats via reranker.resolveDampeningThreshold)
    // > descriptor FLOOR (confidence.score.threshold) > FALLBACK_K (defensive constant).
    // The static threshold on the descriptor is the floor, not the primary —
    // adaptive scales with the codebase's commit distribution.
    const k = ctx?.dampeningThreshold ?? ctx?.confidence?.score?.threshold ?? BugFixSignal.FALLBACK_K;
    const supportName = ctx?.confidence?.support ?? "commitCount";
    value *= confidenceDampening(fileNum(rawSignals, supportName), k);
    return value;
  }
}
