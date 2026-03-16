/**
 * Resolves a human-readable label for a numeric value based on
 * percentile thresholds declared in signal descriptor stats.labels.
 *
 * Algorithm: Walk thresholds ascending. Each label covers [threshold, nextThreshold).
 * First label covers everything below its threshold too.
 * Last label covers everything at or above its threshold.
 *
 * Internal to the reranker — not exported from domain barrel.
 */
export function resolveLabel(
  value: number,
  labels: Record<string, string>,
  percentiles: Record<number, number>,
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
  return resolved;
}
