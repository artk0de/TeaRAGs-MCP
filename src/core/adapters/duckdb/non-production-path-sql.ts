/**
 * The non-production path classification as a DuckDB predicate (bd
 * tea-rags-mcp-4p3sb.25): the same declared masks `buildNonProductionPathFilter`
 * matches in JS — the tooling directories plus the test shapes, split into
 * case-insensitive and case-sensitive sets by `nonProductionPathPatterns`
 * (`infra/file-classification`) — compiled into constant SQL: no per-file bind
 * list, no extra read.
 *
 * The masks are an ARGUMENT. The per-language test shapes are owned by
 * `domains/language` (bd tea-rags-mcp-vjz6s), which an adapter may not import,
 * so the caller hands the split lists in — the ontology report's query carries
 * them — and nothing here holds a language's pattern.
 *
 * Why regular expressions and not `GLOB`: DuckDB's `GLOB` lets `*` cross `/`
 * (`'a/b/c.ts' GLOB '*.ts'` is true), so it cannot say "one path segment".
 * A gitignore pattern without a slash matches ONE component — `test_*.py` must
 * not match `src/test_x/foo.py` — and only `[^/]*` expresses that. Each
 * pattern becomes a segment-bounded RE2 alternative, `(?i)` for the
 * case-insensitive set.
 *
 * Supported gitignore forms (everything the declared masks use):
 *   - `name` / `**\/name`   — a component at any depth, file or directory;
 *   - `name/` / `**\/name/**` — a directory at any depth (its contents);
 *   - `*` and `?` inside the one segment.
 * Anything else — negation, a character class, braces, an escape, a
 * root-anchored or multi-segment path — throws: a mask the SQL cannot express
 * must fail loudly, never be dropped from the predicate.
 */

import type { CaseSplitPathPatterns } from "../../contracts/types/file-classification.js";

const REGEX_SPECIAL = /[.+^$()|\\]/g;

/** One supported gitignore pattern → a segment-bounded RE2 alternative. */
function segmentPatternRegex(pattern: string): string {
  const unsupported = (why: string) => new Error(`non-production path SQL: unsupported pattern "${pattern}" (${why})`);
  if (pattern.startsWith("!")) throw unsupported("negation");
  if (/[[\]{}\\]/.test(pattern)) throw unsupported("character class, brace list or escape");
  if (pattern.startsWith("/")) throw unsupported("root-anchored path");
  let body = pattern.startsWith("**/") ? pattern.slice(3) : pattern;
  let directory = false;
  if (body.endsWith("/**")) [body, directory] = [body.slice(0, -3), true];
  else if (body.endsWith("/")) [body, directory] = [body.slice(0, -1), true];
  if (body === "" || body.includes("/") || body.includes("**")) throw unsupported("multi-segment or mid-path wildcard");
  const segment = body.replace(REGEX_SPECIAL, "\\$&").replaceAll("*", "[^/]*").replaceAll("?", "[^/]");
  return directory ? `(^|/)${segment}/` : `(^|/)${segment}(/|$)`;
}

/** A SQL string literal (the regexes are code constants; quotes doubled anyway). */
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Compiled predicates per pattern object: a report compiles its masks once, not per query. */
const compiled = new WeakMap<CaseSplitPathPatterns, (column: string) => string>();

/**
 * Compiles `patterns` into a predicate over a path column: true for a
 * non-production path. Throws on a pattern form it cannot express.
 */
export function compileNonProductionPathPredicate(patterns: CaseSplitPathPatterns): (column: string) => string {
  const cached = compiled.get(patterns);
  if (cached) return cached;
  const clauses: ((column: string) => string)[] = [];
  if (patterns.caseInsensitive.length > 0) {
    const regex = `(?i)(${patterns.caseInsensitive.map(segmentPatternRegex).join("|")})`;
    clauses.push((column) => `regexp_matches(${column}, ${literal(regex)})`);
  }
  if (patterns.caseSensitive.length > 0) {
    const regex = `(${patterns.caseSensitive.map(segmentPatternRegex).join("|")})`;
    clauses.push((column) => `regexp_matches(${column}, ${literal(regex)})`);
  }
  const predicate =
    clauses.length === 0
      ? () => "FALSE"
      : (column: string) => `(${clauses.map((clause) => clause(column)).join(" OR ")})`;
  compiled.set(patterns, predicate);
  return predicate;
}
