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
 * `domains/trajectory/`, and `language` may not import a sibling domain. It
 * lists exactly that registry's TypeScript and JavaScript rows — `.mts` / `.cts`
 * among them since bd tea-rags-mcp-1y13c walks the ESM / CJS module formats —
 * so a new ECMAScript extension there needs a matching line here.
 * `.d.ts` / `.d.mts` / `.d.cts` are covered by their last segment.
 *
 * Every lookup of a name a CALL spells passes a `role` (bd tea-rags-mcp-jqvbn):
 * `"callee"` for the invoked member, `"receiver"` for the value it is invoked
 * on. `interface` / `enum` / `type` declarations are codegraph symbols, and
 * without the role a type sharing a function's or a class's name reads as a
 * second candidate. A lookup of a TYPE name (an annotation, a CHA locator, an
 * `extends` target) passes none and sees every kind.
 *
 * The role is answered by the CALLING resolver's language — the
 * `codegraph.symbolKindRoles` row its vertical attaches to the ctx at its
 * resolver entry (0qaht.13) — so a TypeScript caller applies the TypeScript
 * row and a JavaScript caller the JavaScript one, whichever family member the
 * candidates come from. The rows differ (JavaScript's is the constructible
 * subset), which is why the descriptor is injected rather than assumed: this
 * module may reach no vertical, only the kernel below it. A ctx no vertical
 * built (a harness driving one strategy directly) carries no row, and a role
 * narrows nothing there.
 */

import type { CallContext, SymbolDefinition, SymbolKindRoles } from "../../../contracts/types/codegraph.js";
import { symbolLookupOptionsFor, type CallRoleSymbolLookupOptions } from "../kernel/symbol-kind-roles.js";

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

/**
 * The ctx the resolving vertical hands down, carrying its own
 * `codegraph.symbolKindRoles` row — the DI seam (0qaht.13) that lets this
 * module answer a role without importing either vertical's capability. Each
 * family resolver calls it once at its entry; the row is the CALLING
 * language's, not the candidate's.
 */
export function withEcmascriptSymbolKindRoles(ctx: CallContext, roles: SymbolKindRoles): CallContext {
  // Idempotent on the vertical's own row (the capability's stable Set), so a
  // nested entry re-wrapping an already-wrapped ctx allocates nothing.
  if (ctx.symbolKindRoles === roles) return ctx;
  return { ...ctx, symbolKindRoles: roles };
}

/** The kind roles the calling vertical injected — `undefined` off its entry paths. */
function ecmascriptKindRolesOf(ctx: CallContext): SymbolKindRoles | undefined {
  return ctx.symbolKindRoles;
}

/** `ctx.symbolTable.lookupByShortName`, restricted to the ECMAScript family. */
export function lookupEcmascriptSymbolsByShortName(
  ctx: CallContext,
  name: string,
  options?: CallRoleSymbolLookupOptions,
): SymbolDefinition[] {
  return ctx.symbolTable
    .lookupByShortName(name, symbolLookupOptionsFor(ecmascriptKindRolesOf(ctx), options))
    .filter((def) => isEcmascriptSourcePath(def.relPath));
}

/**
 * `ctx.symbolTable.lookup`, restricted to the ECMAScript family. The
 * fully-qualified key is no safer than the short name: Ruby spells an instance
 * method `Report#render` exactly as TypeScript does, and a top-level class's
 * fqName is its bare name in every language.
 */
export function lookupEcmascriptSymbols(
  ctx: CallContext,
  fqName: string,
  options?: Pick<CallRoleSymbolLookupOptions, "role">,
): SymbolDefinition[] {
  return ctx.symbolTable
    .lookup(fqName, symbolLookupOptionsFor(ecmascriptKindRolesOf(ctx), options))
    .filter((def) => isEcmascriptSourcePath(def.relPath));
}
