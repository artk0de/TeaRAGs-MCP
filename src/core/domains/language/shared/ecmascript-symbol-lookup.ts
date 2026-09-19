/**
 * The ECMAScript family's ONE way into the symbol table (bd tea-rags-mcp-t5cji)
 * — every lookup the TypeScript and JavaScript resolvers make goes through
 * here, never through `ctx.symbolTable` directly. Mirrors
 * `lookupRubySymbolsByShortName` / `lookupPythonSymbolsByShortName`.
 *
 * One symbol table is built per run over every codegraph extension, and
 * `SymbolDefinition` carries no `language` field, so an unfiltered lookup
 * answers with whatever file in the repo spells the name. On a Rails + React or
 * Django + React repo that is a Ruby or Python namesake, and it went wrong three
 * ways: a PICK site landed a bare `perform()` on Ruby's `Worker#perform`; a
 * CARDINALITY gate read the namesake as ambiguity (`super.save()` against a Ruby
 * `Base#save`) or as existence (a type-level operator the project "declares");
 * and the CHA cone's type locator could not place a TypeScript `Circle` beside a
 * Ruby one, so the fan-out lost every implementer.
 *
 * FAMILY, not language: TypeScript and JavaScript resolve into each other for
 * real — `allowJs`, a `.d.ts` beside its `.js`, a JavaScript entry point loading
 * TypeScript source through tsx — so both resolvers share this one filter.
 *
 * A LITERAL rather than a read of the registry, for the reason
 * `PYTHON_SOURCE_EXTENSIONS` gives: `CODEGRAPH_LANGUAGES` lives in
 * `domains/trajectory/`, and `language` may not import a sibling domain. It is
 * a superset of that registry's TypeScript and JavaScript rows — `.mts` / `.cts`
 * are ECMAScript sources no walk emits today, and admitting them costs nothing.
 * `.d.ts` / `.d.mts` / `.d.cts` are covered by their last segment.
 */

import type { CallContext, SymbolDefinition, SymbolLookupOptions } from "../../../contracts/types/codegraph.js";

export const ECMASCRIPT_SOURCE_EXTENSIONS: readonly string[] = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

/** Whether a symbol-table `relPath` is a TypeScript / JavaScript file a TS or JS edge may point at. */
export function isEcmascriptSourcePath(relPath: string): boolean {
  return ECMASCRIPT_SOURCE_EXTENSIONS.some((ext) => relPath.endsWith(ext));
}

/** `ctx.symbolTable.lookupByShortName`, restricted to the ECMAScript family. */
export function lookupEcmascriptSymbolsByShortName(
  ctx: CallContext,
  name: string,
  options?: SymbolLookupOptions,
): SymbolDefinition[] {
  return ctx.symbolTable.lookupByShortName(name, options).filter((def) => isEcmascriptSourcePath(def.relPath));
}

/**
 * `ctx.symbolTable.lookup`, restricted to the ECMAScript family. The
 * fully-qualified key is no safer than the short name: Ruby spells an instance
 * method `Report#render` exactly as TypeScript does, and a top-level class's
 * fqName is its bare name in every language.
 */
export function lookupEcmascriptSymbols(ctx: CallContext, fqName: string): SymbolDefinition[] {
  return ctx.symbolTable.lookup(fqName).filter((def) => isEcmascriptSourcePath(def.relPath));
}
