/**
 * The Ruby resolver's ONE short-name entry point, and the path predicate it
 * gates on (bd tea-rags-mcp-kumq2). Mirrors `lookupPythonSymbolsByShortName` +
 * `isPythonSourcePath` on the Python side.
 *
 * A LEAF module by construction — it imports the codegraph contracts and
 * nothing else. The walker's inline type sources reach into
 * `resolver/type-propagation.ts`, so `ruby-return-facts.ts` and
 * `ruby-unbound-receiver-types.ts` sit on that walker-facing side and must not
 * import anything that leads back into the walker. `strategies/shared.ts` (where
 * Python keeps its half) used to: it reached `walker/walker.js` for
 * `ZEITWERK_PREFIX` until that constant moved to the `ruby/zeitwerk-import-marker.ts`
 * leaf (bd tea-rags-mcp-xuywm). `shared.ts` re-exports both names, so every
 * existing `isRubyPath` import keeps its path.
 */

import type { CallContext, SymbolDefinition, SymbolLookupOptions } from "../../../../contracts/types/codegraph.js";

/**
 * Whether a symbol-table relPath is a Ruby file the resolver may attribute a
 * call edge to. The symbol table is language-agnostic (no `language` field on
 * `SymbolDefinition`), so a Ruby resolver gates on the file extension to avoid
 * attributing an edge to a vendored JS / Java / etc. definition (bug pl7k:
 * `agents.map(&:id)` → `d3.js#map`). Consulted through
 * {@link lookupRubySymbolsByShortName}.
 */
export function isRubyPath(relPath: string): boolean {
  return relPath.endsWith(".rb") || relPath.endsWith(".rake") || relPath.endsWith(".gemspec");
}

/**
 * Short-name lookup restricted to RUBY candidates — the ONLY short-name entry
 * point the Ruby resolver may use.
 *
 * One symbol table is built per run over every `CODEGRAPH_LANGUAGES` extension,
 * production and both harnesses alike, and `SymbolDefinition` carries no
 * `language` field, so a bare `lookupByShortName` answers with any file in the
 * repo that spells the name. On a Rails + React repo (taxdome, mastodon's
 * `app/javascript`) that is a `.ts`/`.tsx`/`.js` namesake, and it goes wrong two
 * ways: a CARDINALITY GATE (`length <= 1`, `length > 0`) reads the namesake as
 * ambiguity or as existence and so suppresses or fabricates a Ruby answer, while
 * a PICK SITE can select the foreign symbol outright — `resolveConstant` pins
 * the candidate list to a file, but it reaches that file through the equally
 * language-blind `symbolTable.lookup(fq)`.
 *
 * Wrapping the call rather than filtering per site is what keeps the guard from
 * being forgotten at the next one; see {@link isRubyPath} for why the extension,
 * and not a `language` field, is the axis.
 */
export function lookupRubySymbolsByShortName(
  ctx: CallContext,
  name: string,
  options?: SymbolLookupOptions,
): SymbolDefinition[] {
  return ctx.symbolTable.lookupByShortName(name, options).filter((def) => isRubyPath(def.relPath));
}
