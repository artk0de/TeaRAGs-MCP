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

  // Expand braces (top-level or inline) into alternatives
  const expanded = expandBraces(pattern);
  if (expanded.length > 1) {
    const positive: { key: string; match: { text: string } | { value: string } }[] = [];
    const negative: { key: string; match: { text: string } }[] = [];

    for (const alt of expanded) {
      if (alt.startsWith("!")) {
        const q = extractTextQuery(alt.slice(1));
        if (q.length > 0) negative.push({ key: "relativePath", match: { text: q } });
      } else {
        const cond = buildMatchCondition(alt);
        if (cond) positive.push(cond);
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

  const resolved = expanded.length === 1 ? expanded[0] : pattern;
  const cond = buildMatchCondition(resolved);
  if (!cond) return {};

  return { must: [cond] };
}

/**
 * Check if a pattern is an exact file path (no glob wildcards, has file extension).
 */
function isExactFilePath(pattern: string): boolean {
  // Must not contain any glob special characters
  if (/[*?[\]{}!@#]/.test(pattern)) return false;
  // Must have a file extension (dot followed by alphanumeric chars at the end)
  return /\.\w+$/.test(pattern);
}

/**
 * Build a Qdrant match condition for a single pattern.
 * Exact file paths use `match: { value }` for precise matching.
 * Glob patterns use `match: { text }` for tokenized matching.
 */
function buildMatchCondition(pattern: string): { key: string; match: { text: string } | { value: string } } | null {
  if (isExactFilePath(pattern)) {
    // Exact file path — use value match for precise filtering
    const cleaned = pattern.replace(/^\//, "");
    if (cleaned.length === 0) return null;
    return { key: "relativePath", match: { value: cleaned } };
  }
  const textQuery = extractTextQuery(pattern);
  if (textQuery.length === 0) return null;
  return { key: "relativePath", match: { text: textQuery } };
}

/**
 * Strip glob wildcards from a pattern, keep literal path with slashes.
 * Word tokenizer splits on "/" natively — pass path segments as-is.
 * Preserves trailing "/" to avoid prefix false positives
 * (e.g. "domains/" won't match "domains_bad").
 */
function extractTextQuery(pattern: string): string {
  let result = pattern
    .replace(/\*+/g, "") // strip * and **
    .replace(/[?[\]{}!@#]/g, "") // strip glob special chars
    .replace(/\/+/g, "/") // collapse multiple slashes
    .replace(/^\//, "") // trim leading slash only, keep trailing
    .trim();

  // Strip orphaned filename fragments after wildcard removal.
  // e.g. "spec/services/workflow/_spec.rb" → "spec/services/workflow/"
  // A trailing segment with "." is a filename remnant, not a directory.
  // Only strip when there's a directory prefix (lastSlash > 0),
  // preserving extension-only patterns like ".ts".
  const lastSlash = result.lastIndexOf("/");
  if (lastSlash > 0) {
    const trailing = result.slice(lastSlash + 1);
    // Strip filename remnants (e.g. "_spec.rb") but keep pure extensions (".ts").
    // A segment starting with "." is an extension pattern, not a filename remnant.
    if (trailing.includes(".") && !trailing.startsWith(".")) {
      result = result.slice(0, lastSlash + 1);
    }
  }

  return result;
}

/**
 * Expand brace groups anywhere in a pattern into fully-formed alternatives.
 * "prefix/{a,b}/suffix" → ["prefix/a/suffix", "prefix/b/suffix"]
 * "{a,b}" → ["a", "b"]  (top-level)
 * "no/braces" → ["no/braces"]  (passthrough)
 */
function expandBraces(pattern: string): string[] {
  const openIdx = pattern.indexOf("{");
  if (openIdx === -1) return [pattern];

  // Find matching close brace (respecting nesting)
  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < pattern.length; i++) {
    if (pattern[i] === "{") depth++;
    else if (pattern[i] === "}") {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx === -1) return [pattern]; // unmatched brace, treat as literal

  const prefix = pattern.slice(0, openIdx);
  const inner = pattern.slice(openIdx + 1, closeIdx);
  const suffix = pattern.slice(closeIdx + 1);
  const alternatives = splitBraceAlternatives(inner);

  // Recursively expand in case of multiple brace groups in suffix
  const results: string[] = [];
  for (const alt of alternatives) {
    results.push(...expandBraces(`${prefix}${alt}${suffix}`));
  }
  return results;
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
