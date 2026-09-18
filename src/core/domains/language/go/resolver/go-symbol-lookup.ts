/**
 * Symbol lookups restricted to GO declarations — the ONLY table entry points
 * the Go resolver may use (`.claude/rules/resolver-architecture.md` §2).
 *
 * One symbol table is built per run over every `CODEGRAPH_LANGUAGES`
 * extension, and `SymbolDefinition` carries no `language` field, so a bare
 * `lookup("Client#fetch")` answers with any file that declares that id. A Go
 * repository with a TypeScript front end is the ordinary case, and it goes
 * wrong both ways: a PICK SITE selects the foreign method outright (a Go
 * `c.fetch()` on a Go `Client` landing on `web/client.ts`), and a CARDINALITY
 * GATE reads the namesake as ambiguity or as existence (a Go `Client#fetch`
 * dropped because TypeScript declares the same id; a TypeScript `Widget`
 * admitting a Go return-type binding).
 *
 * Wrapping the table rather than filtering per site is what keeps the guard
 * from being forgotten at the next one. The extension is the axis for the
 * same reason as Python's and Ruby's helpers: it is all a definition carries.
 */

import type { CallContext, SymbolDefinition, SymbolLookupOptions } from "../../../../contracts/types/codegraph.js";

const GO_SOURCE_EXTENSION = ".go";

/** Whether a definition's file is Go source. */
export function isGoSourcePath(relPath: string): boolean {
  return relPath.endsWith(GO_SOURCE_EXTENSION);
}

/** Exact-id lookup (`Client`, `Client#fetch`) over Go declarations only. */
export function lookupGoSymbols(ctx: CallContext, symbolId: string): SymbolDefinition[] {
  return ctx.symbolTable.lookup(symbolId).filter((def) => isGoSourcePath(def.relPath));
}

/** Short-name lookup over Go declarations only. */
export function lookupGoSymbolsByShortName(
  ctx: CallContext,
  name: string,
  options?: SymbolLookupOptions,
): SymbolDefinition[] {
  return ctx.symbolTable.lookupByShortName(name, options).filter((def) => isGoSourcePath(def.relPath));
}
