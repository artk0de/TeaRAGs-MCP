import type { SignalConfidence } from "../../contracts/types/trajectory.js";

/**
 * Optional context for confidence-aware label resolution.
 *
 * `siblingValues` is a numeric map of same-scope raw signals (file-scope
 * resolver gets file-scope siblings, chunk-scope resolver gets chunk-scope).
 * `confidence` is the descriptor's `stats.confidence` block declaring how
 * the support sibling drives label clamping.
 */
export interface LabelContext {
  siblingValues?: Record<string, number>;
  confidence?: SignalConfidence;
}

/**
 * Resolves a human-readable label for a numeric value based on
 * percentile thresholds declared in signal descriptor stats.labels.
 *
 * Algorithm: Walk thresholds ascending. Each label covers [threshold, nextThreshold).
 * First label covers everything below its threshold too.
 * Last label covers everything at or above its threshold.
 *
 * When `ctx.confidence.label` is present and `ctx.siblingValues` contains the
 * support sibling, the resolved label is capped by the first matching clamp
 * rule (ascending by `whenSupportBelow`). The ceiling never RAISES severity —
 * if the base label is already less severe than the rule's ceiling, the base
 * stays. If the ceiling references a label not in `labels`, the resolver
 * throws — this is a misconfiguration in the descriptor.
 *
 * Internal to the reranker — not exported from domain barrel.
 */
export function resolveLabel(
  value: number,
  labels: Record<string, string>,
  percentiles: Record<number, number>,
  ctx?: LabelContext,
): string {
  const entries = Object.entries(labels)
    .map(([pKey, label]) => ({ p: Number(pKey.slice(1)), label }))
    .sort((a, b) => a.p - b.p);

  if (entries.length === 0) return "";

  let resolved = entries[0].label;
  for (const { p, label } of entries) {
    const threshold = percentiles[p];
    if (threshold !== undefined && value >= threshold) {
      resolved = label;
    }
  }

  return applyConfidenceClamp(resolved, entries, ctx);
}

/**
 * The subset of bands `resolveLabel` can actually return, given their
 * thresholds. Input MUST already be ordered ascending by percentile — the same
 * order the resolver walks.
 *
 * The resolver seeds the result with the first band and then keeps the LAST
 * band whose threshold the value has reached. A band is therefore reachable
 * only when the NEXT band starts strictly higher: two bands sharing a threshold
 * make the earlier one unreturnable, because any value reaching it reaches its
 * successor too. The first band survives regardless (it owns everything below
 * the second) and so does the last (it owns everything from its threshold up).
 *
 * Percentiles are non-decreasing by construction, so a tie is the only way a
 * band gets shadowed — and ties are common on atomic distributions. Live case
 * on this index: `git.file.blameDominantAuthorPct` declares four bands and the
 * percentiles put all four at 100, so the vocabulary the resolver can emit is
 * `shared` and `deep-silo` — `concentrated` and `silo` are dead names.
 *
 * Callers publishing a label vocabulary (`SignalMetrics.labelMap`) must filter
 * through this, or they advertise bands no result can ever carry.
 */
export function resolvableLabelBands<T extends { threshold: number }>(ascendingBands: readonly T[]): T[] {
  return ascendingBands.filter(
    (band, index) =>
      index === 0 || index === ascendingBands.length - 1 || ascendingBands[index + 1].threshold > band.threshold,
  );
}

function applyConfidenceClamp(baseLabel: string, entries: { p: number; label: string }[], ctx?: LabelContext): string {
  const confidence = ctx?.confidence;
  const clamp = confidence?.label;
  if (!clamp || !confidence) return baseLabel;
  const support = ctx?.siblingValues?.[confidence.support];
  if (support === undefined) return baseLabel;

  // Rules pass through Reranker.preResolveConfidenceClamp before reaching here,
  // so whenSupportBelow values should be numbers. Defensive filter drops any
  // leftover strings (would indicate a bug in pre-resolution OR a caller that
  // bypassed the reranker — clamp would silently misfire if we let strings
  // through, so we treat them as unresolved/non-firing).
  const numericRules = clamp.rules.filter(
    (r): r is { whenSupportBelow: number; ceiling: string; fallback?: number } =>
      typeof r.whenSupportBelow === "number",
  );
  const sortedRules = [...numericRules].sort((a, b) => a.whenSupportBelow - b.whenSupportBelow);
  for (const rule of sortedRules) {
    if (support < rule.whenSupportBelow) {
      const ceilingIndex = entries.findIndex((e) => e.label === rule.ceiling);
      if (ceilingIndex === -1) {
        throw new Error(
          `confidence clamp ceiling '${rule.ceiling}' is not a label value in this descriptor's labels map`,
        );
      }
      const baseIndex = entries.findIndex((e) => e.label === baseLabel);
      return baseIndex < ceilingIndex ? baseLabel : rule.ceiling;
    }
  }
  return baseLabel;
}
