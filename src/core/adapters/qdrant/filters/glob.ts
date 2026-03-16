/**
 * Glob-based Qdrant pre-filter.
 *
 * Converts glob patterns to Qdrant full-text `match: { text }` filter conditions.
 * Requires `relativePath` indexed as "text" with "word" tokenizer
 * (splits on `/`, `.`, `-` → path segments become searchable tokens).
 */

import type { FilterConditionResult } from "../../../contracts/types/provider.js";

/**
 * Convert a glob pattern to Qdrant full-text filter conditions on `relativePath`.
 *
 * Extracts literal path segments from the glob:
 * Examples: see tests/qdrant/filters/glob.test.ts
 */
export function globToTextFilter(pattern: string): FilterConditionResult {
  // Handle negation: !pattern → must_not
  if (pattern.startsWith("!")) {
    const inner = pattern.slice(1);
    const textQuery = extractTextQuery(inner);
    if (textQuery.length === 0) return {};
    return { must_not: [{ key: "relativePath", match: { text: textQuery } }] };
  }

  // Handle brace expansion: {a,b,!c} → positive as should (OR), negative as must_not
  const braceMatch = pattern.match(/^\{(.+)\}$/);
  if (braceMatch) {
    const alternatives = splitBraceAlternatives(braceMatch[1]);
    const positive: { key: string; match: { text: string } }[] = [];
    const negative: { key: string; match: { text: string } }[] = [];

    for (const alt of alternatives) {
      if (alt.startsWith("!")) {
        const q = extractTextQuery(alt.slice(1));
        if (q.length > 0) negative.push({ key: "relativePath", match: { text: q } });
      } else {
        const q = extractTextQuery(alt);
        if (q.length > 0) positive.push({ key: "relativePath", match: { text: q } });
      }
    }

    if (positive.length === 0 && negative.length === 0) return {};

    const result: FilterConditionResult = {};
    if (positive.length === 1) {
      result.must = positive;
    } else if (positive.length > 1) {
      result.must = [{ should: positive } as unknown as FilterConditionResult["must"] extends (infer T)[] ? T : never];
    }
    if (negative.length > 0) {
      result.must_not = negative;
    }
    return result;
  }

  const textQuery = extractTextQuery(pattern);
  if (textQuery.length === 0) return {};

  return { must: [{ key: "relativePath", match: { text: textQuery } }] };
}

/**
 * Strip glob wildcards from a pattern, keep literal path with slashes.
 * Word tokenizer splits on "/" natively — pass path segments as-is.
 * Preserves trailing "/" to avoid prefix false positives
 * (e.g. "domains/" won't match "domains_bad").
 */
function extractTextQuery(pattern: string): string {
  return pattern
    .replace(/\*+/g, "") // strip * and **
    .replace(/[?[\]{}!@#]/g, "") // strip glob special chars
    .replace(/\/+/g, "/") // collapse multiple slashes
    .replace(/^\//, "") // trim leading slash only, keep trailing
    .trim();
}

/** Split brace alternatives respecting nested braces. */
function splitBraceAlternatives(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";

  for (const ch of inner) {
    if (ch === "{") {
      depth++;
      current += ch;
    } else if (ch === "}") {
      depth--;
      current += ch;
    } else if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }

  if (current) parts.push(current);
  return parts;
}
