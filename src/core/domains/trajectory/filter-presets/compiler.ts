/**
 * Filter-preset compiler.
 *
 * Compiles a `FilterPresetDef.conditions` list into a concrete `QdrantFilter`:
 *   - translates ageDays conditions into now-relative lastModifiedAt conditions
 *     with INVERTED percentiles (age pN ⇔ stamp p(100−N), bd tea-rags-mcp-9ot33),
 *   - resolves adaptive percentile thresholds from collection Stats (with cold-start fallback),
 *   - maps LOGICAL payload keys to PHYSICAL Qdrant paths via `toPhysicalPayloadKey`,
 *   - groups conditions by `occur` (must / must_not / should),
 *   - compiles `occur:"should"` to a nested `must:[{ should:[...] }]` group (at-least-one-required).
 *
 * Lives in `domains/trajectory/` (which CAN import adapters) so it returns a real
 * `QdrantFilter` rather than the structural shape `FilterSpec` carries in contracts.
 */

import type { QdrantFilter, QdrantFilterCondition } from "../../../adapters/qdrant/types.js";
import { toPhysicalPayloadKey } from "../../../contracts/signal-utils.js";
import type {
  AdaptiveFilterCondition,
  FilterPresetDef,
  FilterThreshold,
} from "../../../contracts/types/filter-preset.js";
import type { FilterLevel } from "../../../contracts/types/provider.js";
import type { CollectionSignalStats } from "../../../contracts/types/trajectory.js";
import { invertPercentileKey, stampThresholdFromDays, stampToTimestampKey } from "../git/index.js";

/** Resolve a range threshold: literal number, or adaptive percentile from stats with cold-start fallback. */
function resolveThreshold(signal: string, value: FilterThreshold, stats: CollectionSignalStats | undefined): number {
  if (typeof value === "number") return value;
  // Percentile lookup uses the LOGICAL key — collection stats are keyed logically
  // (collection-stats sets perSignal by signal.key, mapping to physical only at payload-read time).
  const n = parseInt(value.percentile.slice(1), 10);
  const resolved = stats?.perSignal.get(signal)?.percentiles?.[n];
  return resolved ?? value.fallback;
}

/**
 * Compile one ageDays condition into its now-relative lastModifiedAt leaf.
 * Preset defs keep their domain language (`git.file.ageDays gte {p75}`); the
 * translation happens here so the inversion knowledge stays in one place (the
 * git derivation unit). `age ≥ N` ⟺ `lastModifiedAt ≤ now − N·day` — with
 * `gt: 0` to keep the chunk no-commit sentinel (`lastModifiedAt: 0`) out of
 * the "old" arm, matching the typed minAgeDays filter; `age ≤ N` ⟺
 * `lastModifiedAt ≥ now − N·day`. Percentile thresholds invert (p75 → p25)
 * and their cold-start fallbacks become now-relative stamps, so the compiled
 * filter drifts with the clock exactly like the typed age filters of 9mwny.
 */
function compileAgeCondition(
  c: AdaptiveFilterCondition,
  timestampKey: string,
  stats: CollectionSignalStats | undefined,
  nowSec: number,
): QdrantFilterCondition {
  const value = c.value as FilterThreshold;
  const threshold: FilterThreshold =
    typeof value === "number"
      ? stampThresholdFromDays(value, nowSec)
      : {
          percentile: invertPercentileKey(value.percentile),
          fallback: stampThresholdFromDays(value.fallback, nowSec),
        };
  const resolved = resolveThreshold(timestampKey, threshold, stats);
  if (c.op === "gte") return { key: timestampKey, range: { gt: 0, lte: resolved } };
  return { key: timestampKey, range: { gte: resolved } };
}

/** Compile one condition into a single Qdrant filter leaf. */
function compileCondition(
  c: AdaptiveFilterCondition,
  stats: CollectionSignalStats | undefined,
  nowSec: number,
): QdrantFilterCondition {
  if ((c.op === "gte" || c.op === "lte") && typeof c.value !== "boolean" && typeof c.value !== "string") {
    const timestampKey = stampToTimestampKey(c.signal);
    if (timestampKey) return compileAgeCondition(c, toPhysicalPayloadKey(timestampKey), stats, nowSec);
  }
  const key = toPhysicalPayloadKey(c.signal);

  switch (c.op) {
    case "eq":
      return Array.isArray(c.value) ? { key, match: { any: c.value } } : { key, match: { value: c.value } };
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
 * @param nowSec Query clock, unix seconds — the unit of the lastModifiedAt
 *   timestamps the ageDays translation emits. Defaults to the current time;
 *   tests pin it for determinism.
 */
export function compileFilterPreset(
  def: FilterPresetDef,
  stats: CollectionSignalStats | undefined,
  level: FilterLevel,
  nowSec: number = Math.floor(Date.now() / 1000),
): QdrantFilter {
  void level; // reserved: per-level threshold overrides not yet supported

  const must: QdrantFilterCondition[] = [];
  const mustNot: QdrantFilterCondition[] = [];
  const should: QdrantFilterCondition[] = [];

  for (const c of def.conditions) {
    const compiled = compileCondition(c, stats, nowSec);
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
