/**
 * A Qdrant filter evaluated against a payload Qdrant never stored
 * (bd tea-rags-mcp-xi2r9.4): the working tree's delta rows join a hybrid page
 * only when the request filter would have admitted their indexed twins.
 *
 * Semantics follow Qdrant: a key path walks nested objects and fans out over
 * arrays, a condition holds when ANY reached value satisfies it, a missing key
 * satisfies nothing but `is_empty`, `match.text` is the `word`-tokenizer
 * conjunction ({@link matchesTextIndexed}).
 *
 * Three-valued: a condition this module does not know (`has_id`, `geo_*`,
 * `values_count`, …) is UNKNOWN, and a filter whose verdict depends on it never
 * admits the row — not even through `must_not`. A delta row lost to an exotic
 * filter is the safe failure; a row the caller filtered out reappearing is not.
 */

import { matchesTextIndexed } from "./symbolid-text-token.js";

type Verdict = boolean | "unknown";

const FILTER_CLAUSES = ["must", "should", "must_not"] as const;

/** Does `payload` satisfy `filter` as Qdrant would decide it? Unknown conditions → false. */
export function payloadMatchesFilter(payload: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return evaluateFilter(payload, normalizeFilter(filter)) === true;
}

/** Qdrant's flat `{ key: value }` request form, as the search executor expands it. */
function normalizeFilter(filter: Record<string, unknown>): Record<string, unknown> {
  if (FILTER_CLAUSES.some((clause) => clause in filter)) return filter;
  return { must: Object.entries(filter).map(([key, value]) => ({ key, match: { value } })) };
}

function evaluateFilter(payload: Record<string, unknown>, filter: Record<string, unknown>): Verdict {
  const verdicts: Verdict[] = [];
  const must = asConditions(filter.must);
  const should = asConditions(filter.should);
  const mustNot = asConditions(filter.must_not);
  if (must) verdicts.push(all(must.map((c) => evaluateCondition(payload, c))));
  if (should && should.length > 0) verdicts.push(any(should.map((c) => evaluateCondition(payload, c))));
  if (mustNot) verdicts.push(all(mustNot.map((c) => negate(evaluateCondition(payload, c)))));
  for (const key of Object.keys(filter)) {
    if (!(FILTER_CLAUSES as readonly string[]).includes(key)) verdicts.push("unknown");
  }
  return all(verdicts);
}

function evaluateCondition(payload: Record<string, unknown>, condition: unknown): Verdict {
  if (!isRecord(condition)) return "unknown";
  if (FILTER_CLAUSES.some((clause) => clause in condition)) return evaluateFilter(payload, condition);
  if (isRecord(condition.is_empty) && typeof condition.is_empty.key === "string") {
    return valuesAt(payload, condition.is_empty.key).length === 0;
  }
  if (typeof condition.key !== "string") return "unknown";
  const values = valuesAt(payload, condition.key);
  if (isRecord(condition.match)) return evaluateMatch(values, condition.match);
  if (isRecord(condition.range)) return values.some((value) => inRange(value, condition.range as RangeBounds));
  return "unknown";
}

function evaluateMatch(values: unknown[], match: Record<string, unknown>): Verdict {
  if ("value" in match) return values.some((value) => value === match.value);
  if (Array.isArray(match.any)) {
    const wanted = match.any;
    return values.some((value) => wanted.includes(value));
  }
  if (Array.isArray(match.except)) {
    const excluded = match.except;
    return values.length > 0 && values.some((value) => !excluded.includes(value));
  }
  if (typeof match.text === "string") {
    const { text } = match;
    return values.some((value) => matchesTextIndexed(value, text));
  }
  return "unknown";
}

interface RangeBounds {
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
}

function inRange(value: unknown, { gt, gte, lt, lte }: RangeBounds): boolean {
  if (typeof value !== "number") return false;
  return (
    (gt === undefined || value > gt) &&
    (gte === undefined || value >= gte) &&
    (lt === undefined || value < lt) &&
    (lte === undefined || value <= lte)
  );
}

/** Every non-null value the key path reaches; arrays fan out (`a.b` and `a[].b` alike). */
function valuesAt(payload: Record<string, unknown>, key: string): unknown[] {
  let current: unknown[] = [payload];
  for (const segment of key.split(".")) {
    const name = segment.replace(/\[\]$/, "");
    current = current.flatMap((node) => (isRecord(node) ? flatten(node[name]) : []));
  }
  return current;
}

function flatten(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value.filter((v) => v !== undefined && v !== null) : [value];
}

function all(verdicts: Verdict[]): Verdict {
  if (verdicts.includes(false)) return false;
  return verdicts.includes("unknown") ? "unknown" : true;
}

function any(verdicts: Verdict[]): Verdict {
  if (verdicts.includes(true)) return true;
  return verdicts.includes("unknown") ? "unknown" : false;
}

function negate(verdict: Verdict): Verdict {
  return verdict === "unknown" ? "unknown" : !verdict;
}

function asConditions(value: unknown): unknown[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? (value as unknown[]) : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
