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
  const isMatch = picomatch(body, { dot: true });
  return negated ? (relativePath) => !isMatch(relativePath) : (relativePath) => isMatch(relativePath);
}
