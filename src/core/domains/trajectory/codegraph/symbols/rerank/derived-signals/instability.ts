import type { DerivedSignalDescriptor } from "../../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../../contracts/types/trajectory.js";
import { confidenceDampening } from "../../../../../../contracts/signal-utils.js";
import { codegraphFileNum } from "./helpers.js";

/**
 * Martin instability ratio = fanOut / (fanIn + fanOut), already in [0,1].
 *
 * Confidence dampening (tea-rags-mcp-0am0): the ratio swings 0↔1 from a
 * single edge when connectionCount=1. The btl8 payload-signals descriptor
 * declares `confidence.support = "connectionCount"` plus a static
 * `score.threshold` and adaptive `adaptivePercentile`. Reranker resolves
 * the adaptive k via collection stats and passes it as
 * `ctx.dampeningThreshold`; this signal multiplies its normalised value
 * by `confidenceDampening(connectionCount, k)` so small-N points are
 * attenuated in the ranking. The label-side clamp is handled by the
 * reranker's `applyLabelResolution` reading the same descriptor.
 */
export class InstabilitySignal implements DerivedSignalDescriptor {
  readonly name = "instability";
  readonly description = "Martin instability ratio (already normalised to [0,1])";
  readonly sources = ["codegraph.file.instability"];
  readonly defaultBound = 1;
  private static readonly FALLBACK_K = 5;
  extract(raw: Record<string, unknown>, ctx?: ExtractContext): number {
    let v = codegraphFileNum(raw, "instability");
    if (v < 0) v = 0;
    else if (v > 1) v = 1;
    const k = ctx?.dampeningThreshold ?? ctx?.confidence?.score?.threshold ?? InstabilitySignal.FALLBACK_K;
    const supportName = ctx?.confidence?.support ?? "connectionCount";
    v *= confidenceDampening(codegraphFileNum(raw, supportName), k);
    return v;
  }
}
