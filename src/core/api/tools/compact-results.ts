/**
 * Search-result compaction — the presentation step a search answer passes
 * through before it is tabulated (bd tea-rags-mcp-e6es3).
 *
 * Measured on the self-index, a file's import list was ~38% of a reranked
 * metaOnly answer, and raw floats carried 15+ digits nobody reads. Both are
 * reshaped HERE, after the App answered: ranking already ran on the full
 * payload (the `imports` derived signal reads the array at rerank time), so
 * nothing this step does can move an order or a score.
 *
 *   - `imports` (payload, and either overlay bucket) → its COUNT, unless the
 *     caller asked for the list. A labelled entry keeps its label; only
 *     `value` becomes the count. Import edges are served by get_callees /
 *     get_callers, so the list is rarely what a row is read for.
 *   - Every non-integer number → 2 significant digits, never 2 decimal places:
 *     a pageRank of 0.0000522 must stay 0.000052, not become 0.
 */

import type { SearchResult } from "../public/dto/explore.js";

export interface SearchResultCompaction {
  /** Keep every `imports` list as the array it is instead of its count. */
  includeImports: boolean;
}

const IMPORTS_KEY = "imports";
const SIGNIFICANT_DIGITS = 2;

/** Each result with imports counted (unless `includeImports`) and non-integer numbers rounded. */
export function compactSearchResults<T extends SearchResult>(
  results: readonly T[],
  compaction: SearchResultCompaction,
): T[] {
  return results.map((result) => {
    const counted = compaction.includeImports ? result : countResultImports(result);
    return roundNumbers(counted);
  });
}

function countResultImports<T extends SearchResult>(result: T): T {
  const { payload, rankingOverlay } = result;
  return {
    ...result,
    ...(payload && IMPORTS_KEY in payload ? { payload: countImportsIn(payload) } : {}),
    ...(rankingOverlay
      ? {
          rankingOverlay: {
            ...rankingOverlay,
            ...(rankingOverlay.file ? { file: countImportsIn(rankingOverlay.file) } : {}),
            ...(rankingOverlay.chunk ? { chunk: countImportsIn(rankingOverlay.chunk) } : {}),
          },
        }
      : {}),
  };
}

/** `imports` of one record → its count: a bare list, or the `value` of a `{value, label}` entry. */
function countImportsIn<R extends Record<string, unknown>>(record: R): R {
  const entry = record[IMPORTS_KEY];
  if (Array.isArray(entry)) return { ...record, [IMPORTS_KEY]: entry.length };
  if (isPlainRecord(entry) && Array.isArray(entry.value)) {
    return { ...record, [IMPORTS_KEY]: { ...entry, value: entry.value.length } };
  }
  return record;
}

/** Deep copy with every non-integer finite number at SIGNIFICANT_DIGITS; strings, integers, ids untouched. */
function roundNumbers<V>(value: V): V {
  if (typeof value === "number") return roundToSignificantDigits(value) as V;
  if (Array.isArray(value)) return value.map(roundNumbers) as V;
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, roundNumbers(inner)])) as V;
}

function roundToSignificantDigits(value: number): number {
  if (Number.isInteger(value) || !Number.isFinite(value)) return value;
  return Number(value.toPrecision(SIGNIFICANT_DIGITS));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
