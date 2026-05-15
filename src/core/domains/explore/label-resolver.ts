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
