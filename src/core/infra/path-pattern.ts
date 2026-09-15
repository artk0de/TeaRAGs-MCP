/**
 * The exact meaning of a `pathPattern` — the one predicate every tool that takes
 * one answers by.
 *
 * Two layers enforce it: the explore strategies, narrowing the superset the
 * Qdrant text pre-filter returns (bd tea-rags-mcp-xf01b), and the DuckDB graph
 * adapter, scoping `find_cycles`. An adapter may not import a domain, so the
 * foundation is the only home both can reach; sharing one matcher is what keeps
 * the tools from disagreeing on what a pattern selects.
 *
 * Semantics — picomatch, as the MCP schema promises, with two choices on top:
 * - `dot: true`. Indexed files live under dot directories (`.claude/`,
 *   `.github/`); a glob that silently skipped them would hide real results.
 * - A leading `!` negates the WHOLE pattern and a leading `/` is dropped, which
 *   is how `globToTextFilter` (`adapters/qdrant/filters/glob.ts`) lowers the same
 *   pattern into its pre-filter.
 */

import picomatch from "picomatch";

/** True iff a project-relative path is selected by the compiled `pathPattern`. */
export type PathPatternMatcher = (relativePath: string) => boolean;

/**
 * Compile a `pathPattern` into its matcher. No pattern — absent, empty, or a bare
 * `!` — constrains nothing, and returns `undefined` so callers can skip the
 * filter entirely.
 */
export function compilePathPatternMatcher(pathPattern: string | undefined): PathPatternMatcher | undefined {
  if (!pathPattern) return undefined;
  const negated = pathPattern.startsWith("!");
  const body = (negated ? pathPattern.slice(1) : pathPattern).replace(/^\/+/, "");
  if (body.trim().length === 0) return undefined;
  const isMatch = picomatch(unwrapSingleAlternativeBraces(body), { dot: true });
  return negated ? (relativePath) => !isMatch(relativePath) : (relativePath) => isMatch(relativePath);
}

/** A brace group holding one alternative: no nested brace, no comma, not a `a..b` range. */
const SINGLE_ALTERNATIVE_BRACE = /(^|[^\\])\{((?:(?!\.\.)[^{},])*)\}/;

/**
 * Replace every `{x}` with `x`, innermost first. picomatch reads a one-alternative
 * group as literal text, while `globToTextFilter` expands it to its alternative —
 * and a brace list built over a set of paths collapses to `{path}` when the set
 * has one member. Unwrapping keeps the exact filter inside the pre-filter's
 * superset instead of answering such a pattern with nothing.
 */
function unwrapSingleAlternativeBraces(pattern: string): string {
  let current = pattern;
  for (let next = current.replace(SINGLE_ALTERNATIVE_BRACE, "$1$2"); next !== current; ) {
    current = next;
    next = current.replace(SINGLE_ALTERNATIVE_BRACE, "$1$2");
  }
  return current;
}
