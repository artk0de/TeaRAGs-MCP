/**
 * The single owner of "age means now − lastModifiedAt" (bd tea-rags-mcp-9ot33).
 *
 * The enrichment-time `git.{file,chunk}.ageDays` stamp freezes at enrichment
 * and never moves on points that are not re-enriched (validator C measured
 * 8,666 self-index chunks stamped ≤ 7 days while only 3,980 had a real
 * lastModifiedAt within 8 days), so every READ path derives age from the
 * lastModifiedAt timestamp instead:
 *
 *   - `AgeSignal` / `RecencySignal` extract from `lastModifiedAt` with a
 *     query-time clock (`ExtractContext.now`),
 *   - the Reranker's adaptive-bounds age branch floors the batch p95 with
 *     `now − p5(lastModifiedAt)` (percentilesToCompute [5, 25, 50] on the
 *     timestamp descriptors),
 *   - the overlay resolves an `ageDays` mask entry to the computed age and a
 *     now-relative label band,
 *   - the filter-preset compiler translates `ageDays` conditions into
 *     now-relative `lastModifiedAt` conditions with inverted percentiles.
 *
 * The percentile family inverts because age grows as the stamp shrinks:
 * age pN ⇔ lastModifiedAt p(100−N); the median is symmetric. The stamp stays
 * in the payload for prime threshold rows, analytics and the raw-filter escape
 * hatch — it just left the hot read path.
 *
 * Units: lastModifiedAt is unix SECONDS (as stored, and as the typed
 * min/maxAgeDays filters of 9mwny already compare it); ages are whole DAYS,
 * floored exactly like the enrichment stamp so the two eras are numerically
 * comparable.
 */

import { blend, normalize } from "../../../contracts/signal-utils.js";
import type { FilterPercentile } from "../../../contracts/types/filter-preset.js";
import type { AgeDerivationCapability, SignalLevel } from "../../../contracts/types/reranker.js";
import { chunkField, fileField, payloadAlpha } from "./rerank/derived-signals/helpers.js";

/** Seconds per day — the stamp and the query clock share the unix-seconds unit. */
export const DAY_SECONDS = 86_400;

/** Raw payload field holding the enrichment-time age stamp. */
export const AGE_STAMP_FIELD = "ageDays";

/** Raw payload field holding the last-commit timestamp age derives from. */
export const LAST_MODIFIED_FIELD = "lastModifiedAt";

/**
 * Age in whole days at `nowSec` from a lastModifiedAt stamp. Undefined when
 * there is no stamp: the key is absent (a file with no history) or it carries
 * the chunk 0 sentinel (`lastModifiedAt: 0` — no commit touched the chunk).
 * Future stamps clamp to 0 instead of going negative.
 */
export function ageDaysFromStamp(lastModifiedAt: unknown, nowSec: number): number | undefined {
  if (typeof lastModifiedAt !== "number" || lastModifiedAt <= 0) return undefined;
  return Math.max(0, Math.floor((nowSec - lastModifiedAt) / DAY_SECONDS));
}

/** Mirror a percentile across the median: age pN ⇔ stamp p(100−N). */
export function invertPercentile(p: number): number {
  return 100 - p;
}

/** Percentile-key form of {@link invertPercentile} for threshold definitions. */
export function invertPercentileKey(key: FilterPercentile): FilterPercentile {
  return `p${invertPercentile(Number(key.slice(1)))}` as FilterPercentile;
}

/** A fallback of N days becomes the now-relative stamp threshold it filters on. */
export function stampThresholdFromDays(days: number, nowSec: number): number {
  return nowSec - days * DAY_SECONDS;
}

/** The default query clock — unix seconds, matching the stamp unit. */
export function nowEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * `git.<level>.ageDays` → `git.<level>.lastModifiedAt`, for the filter-preset
 * compiler. Only level-qualified keys translate — a bare `ageDays` names no
 * level, and no preset in the repo writes one. Non-stamp signals return
 * undefined and compile unchanged.
 */
export function stampToTimestampKey(signalKey: string): string | undefined {
  const m = new RegExp(`^(.*)\\.${AGE_STAMP_FIELD}$`).exec(signalKey);
  return m ? `${m[1]}.${LAST_MODIFIED_FIELD}` : undefined;
}

/**
 * Collection floor for an age source, in days: `now − stamp`. The stamp is a
 * lastModifiedAt percentile threshold — p5 for the batch-p95 bound, so the
 * floor of "age in days" is derived from the freshest 5% of the collection
 * and both sides move with now.
 */
export function ageFloorDaysFromStamp(stampSeconds: number, nowSec: number): number {
  return Math.max(0, (nowSec - stampSeconds) / DAY_SECONDS);
}

/**
 * Now-relative label bands: the ageDays label at percentile `pN` fires once
 * the computed age reaches `ageDays(stamp p(100−N))`. With
 * `percentilesToCompute: [5, 25, 50]` on the timestamp descriptors the stamps
 * cover the ageDays label set {p25, p50, p75, p95}: p25 stays the default
 * floor band, p50 inverts to the stamp median, p75 → stamp p25, p95 → stamp
 * p5. A stamp percentile that was never computed yields no band.
 */
export function labelThresholdsFromStamps(
  stampPercentiles: Record<number, number>,
  nowSec: number,
): Record<number, number> {
  const bands: Record<number, number> = {};
  for (const [key, stamp] of Object.entries(stampPercentiles)) {
    const age = ageDaysFromStamp(stamp, nowSec);
    if (age === undefined) continue;
    bands[invertPercentile(Number(key))] = age;
  }
  return bands;
}

/**
 * Age of one payload level in whole days, or undefined when that level has no
 * stamp. File reads fall back to the flat `git.<field>` shape (helpers'
 * `fileField`); chunk reads are nested-only (a flat stamp is a file stamp).
 */
function levelAgeDays(payload: Record<string, unknown>, level: "file" | "chunk", nowSec: number): number | undefined {
  const stamp = level === "file" ? fileField(payload, LAST_MODIFIED_FIELD) : chunkField(payload, LAST_MODIFIED_FIELD);
  return ageDaysFromStamp(stamp, nowSec);
}

/**
 * Normalize the per-level ages against their (age-days) bounds and alpha-blend
 * — the age twin of `blendNormalized`. A missing chunk stamp falls back to the
 * file's normalized age exactly like the legacy path's undefined chunk value;
 * a missing stamp at the alpha-chosen level contributes age 0, same as the
 * legacy missing-`ageDays` read.
 */
export function blendAgeDaysNormalized(
  payload: Record<string, unknown>,
  nowSec: number,
  fileBound: number,
  chunkBound: number,
  signalLevel?: SignalLevel,
): number {
  const fileAge = levelAgeDays(payload, "file", nowSec) ?? 0;
  const fileNorm = normalize(fileAge, fileBound);
  const alpha = payloadAlpha(payload, signalLevel);
  if (alpha === 0) return fileNorm;
  const chunkAge = levelAgeDays(payload, "chunk", nowSec);
  const chunkNorm = chunkAge !== undefined ? normalize(chunkAge, chunkBound) : fileNorm;
  return blend(chunkNorm, fileNorm, alpha);
}

/**
 * The Reranker-facing capability carried by `AgeSignal` / `RecencySignal`.
 * Delegation only — every function above is the real implementation, so
 * explore consumes the age math without importing trajectory code.
 */
export const AGE_DERIVATION: AgeDerivationCapability = {
  stampField: AGE_STAMP_FIELD,
  timestampField: LAST_MODIFIED_FIELD,
  ageDaysFrom: (payload, level, nowSec) => levelAgeDays(payload, level, nowSec),
  ageFloorDaysFromStamp,
  labelThresholdsFromStamps,
};
