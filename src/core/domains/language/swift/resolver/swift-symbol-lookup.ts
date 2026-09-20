/**
 * Symbol lookups restricted to SWIFT declarations — the ONLY table entry points
 * the Swift resolver may use (`.claude/rules/resolver-architecture.md` §2).
 *
 * One symbol table is built per run over every `CODEGRAPH_LANGUAGES` extension
 * and `SymbolDefinition` carries no `language` field, so a bare
 * `lookup("Store#save")` answers with any file that declares that id. Swift
 * makes this sharper than most: an iOS repository ordinarily ships a
 * TypeScript or Ruby backend beside it, and Swift's member vocabulary —
 * `init`, `run`, `format`, `value`, `description` — collides with those
 * languages constantly. It goes wrong both ways: a PICK SITE selects the
 * foreign method outright, and a CARDINALITY GATE reads a foreign namesake as
 * ambiguity and drops a real Swift edge.
 *
 * Wrapping the table rather than filtering per site is what keeps the guard
 * from being forgotten at the next one. The extension is the axis for the same
 * reason as Go's, Python's and Ruby's helpers: it is all a definition carries.
 */

import type { CallContext, SymbolDefinition, SymbolLookupOptions } from "../../../../contracts/types/codegraph.js";

const SWIFT_SOURCE_EXTENSION = ".swift";

/** Whether a definition's file is Swift source. */
export function isSwiftSourcePath(relPath: string): boolean {
  return relPath.endsWith(SWIFT_SOURCE_EXTENSION);
}

/** Exact-id lookup (`Store`, `Store#save`, `Store.make`) over Swift declarations only. */
export function lookupSwiftSymbols(ctx: CallContext, symbolId: string): SymbolDefinition[] {
  return ctx.symbolTable.lookup(symbolId).filter((def) => isSwiftSourcePath(def.relPath));
}

/** Short-name lookup over Swift declarations only. */
export function lookupSwiftSymbolsByShortName(
  ctx: CallContext,
  name: string,
  options?: SymbolLookupOptions,
): SymbolDefinition[] {
  return ctx.symbolTable.lookupByShortName(name, options).filter((def) => isSwiftSourcePath(def.relPath));
}
