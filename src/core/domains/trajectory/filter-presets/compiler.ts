/**
 * Filter-preset compiler.
 *
 * Compiles a `FilterPresetDef.conditions` list into a concrete `QdrantFilter`:
 *   - resolves adaptive percentile thresholds from collection Stats (with cold-start fallback),
 *   - maps LOGICAL payload keys to PHYSICAL Qdrant paths via `toPhysicalPayloadKey`,
 *   - groups conditions by `occur` (must / must_not / should),
 *   - compiles `occur:"should"` to a nested `must:[{ should:[...] }]` group (at-least-one-required).
 *
 * Lives in `domains/trajectory/` (which CAN import adapters) so it returns a real
 * `QdrantFilter` rather than the structural shape `FilterSpec` carries in contracts.
 */

import type { QdrantFilter, QdrantFilterCondition } from "../../../adapters/qdrant/types.js";
import type { FilterLevel } from "../../../contracts/types/provider.js";
import type { AdaptiveFilterCondition, FilterPresetDef, FilterThreshold } from "../../../contracts/types/filter-preset.js";
import type { CollectionSignalStats } from "../../../contracts/types/trajectory.js";
import { toPhysicalPayloadKey } from "../../../contracts/signal-utils.js";

/** Resolve a range threshold: literal number, or adaptive percentile from stats with cold-start fallback. */
function resolveThreshold(
  signal: string,
  value: FilterThreshold,
  stats: CollectionSignalStats | undefined,
): number {
  if (typeof value === "number") return value;
  // Percentile lookup uses the LOGICAL key — collection stats are keyed logically
  // (collection-stats sets perSignal by signal.key, mapping to physical only at payload-read time).
  const n = parseInt(value.percentile.slice(1), 10);
  const resolved = stats?.perSignal.get(signal)?.percentiles?.[n];
  return resolved ?? value.fallback;
}

/** Compile one condition into a single Qdrant filter leaf. */
function compileCondition(
  c: AdaptiveFilterCondition,
  stats: CollectionSignalStats | undefined,
): QdrantFilterCondition {
  const key = toPhysicalPayloadKey(c.signal);

  switch (c.op) {
    case "eq":
      return Array.isArray(c.value)
        ? { key, match: { any: c.value } }
        : { key, match: { value: c.value } };
    case "contains":
      return { key, match: { text: c.value as string } };
    case "gte":
      return { key, range: { gte: resolveThreshold(c.signal, c.value as FilterThreshold, stats) } };
    case "lte":
      return { key, range: { lte: resolveThreshold(c.signal, c.value as FilterThreshold, stats) } };
  }
}

/**
 * Compile a filter preset's conditions to a Qdrant filter object.
 *
 * @param level Reserved — thresholds are global today (no per-level override yet).
 */
export function compileFilterPreset(
  def: FilterPresetDef,
  stats: CollectionSignalStats | undefined,
  level: FilterLevel,
): QdrantFilter {
  void level; // reserved: per-level threshold overrides not yet supported

  const must: QdrantFilterCondition[] = [];
  const mustNot: QdrantFilterCondition[] = [];
  const should: QdrantFilterCondition[] = [];

  for (const c of def.conditions) {
    const compiled = compileCondition(c, stats);
    switch (c.occur ?? "must") {
      case "should":
        should.push(compiled);
        break;
      case "must_not":
        mustNot.push(compiled);
        break;
      case "must":
        must.push(compiled);
        break;
    }
  }

  // should-group compiles to a nested `{ should:[...] }` clause inside must[]
  // (AND with at-least-one-of), preserving AND-semantics across other must conditions.
  if (should.length > 0) must.push({ should });

  const filter: QdrantFilter = {};
  if (must.length > 0) filter.must = must;
  if (mustNot.length > 0) filter.must_not = mustNot;
  return filter;
}
