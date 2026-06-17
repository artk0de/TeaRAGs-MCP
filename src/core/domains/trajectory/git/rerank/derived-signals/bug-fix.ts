import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { blendNormalizedDamped, chunkNum, confidenceDampening, fileNum } from "./helpers.js";

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
    // Per-scope confidence: dampen each side by its OWN support sample size.
    // Precedence per scope: ADAPTIVE (reranker collection-stats percentile) >
    // descriptor FLOOR (confidence.score.threshold) > FALLBACK_K.
    const floor = ctx?.confidence?.score?.threshold ?? BugFixSignal.FALLBACK_K;
    const kf = ctx?.dampeningThreshold ?? floor;
    const kc = ctx?.dampeningThresholdChunk ?? floor;
    const supportName = ctx?.confidence?.support ?? "commitCount";
    const dampFile = confidenceDampening(fileNum(rawSignals, supportName), kf);
    const dampChunk = confidenceDampening(chunkNum(rawSignals, supportName), kc);
    return blendNormalizedDamped(rawSignals, "bugFixRate", fb, cb, ctx?.signalLevel, dampFile, dampChunk);
  }
}
