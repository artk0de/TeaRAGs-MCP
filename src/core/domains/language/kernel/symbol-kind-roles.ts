/**
 * How a language's resolver asks the symbol table for the part of a call it is
 * resolving (bd tea-rags-mcp-jqvbn, spec §1a).
 *
 * The table knows no language: it takes a SET of kinds
 * (`SymbolLookupOptions.kinds`). A resolver thinks in the part a name plays —
 * the callee, the receiver — and which kinds can play it is its own
 * language's answer, declared once as `LanguageCapability.codegraph.symbolKindRoles`.
 * Each language's filtered lookup helper (`lookupRubySymbolsByShortName`,
 * `lookupEcmascriptSymbolsByShortName`, …) takes the role and hands the table
 * its language's set through {@link symbolLookupOptionsFor}, so no call site
 * names a kind and none can pass another language's set.
 *
 * A LEAF by construction — type imports only — because the Ruby lookup helper
 * that uses it must not reach back into the walker.
 */

import type { SymbolKindRoles, SymbolLookupOptions, SymbolLookupRole } from "../../../contracts/types/codegraph.js";

/**
 * Options a language's lookup helper accepts: the table's options with the
 * kind set replaced by the part of the call the name plays. No role = a TYPE
 * lookup, which keeps every kind.
 */
export interface CallRoleSymbolLookupOptions {
  includeSchemaColumns?: boolean;
  role?: SymbolLookupRole;
}

/** The table options for a lookup made in the language whose roles are `roles`. */
export function symbolLookupOptionsFor(
  roles: SymbolKindRoles,
  options: CallRoleSymbolLookupOptions | undefined,
): SymbolLookupOptions | undefined {
  if (options === undefined) return undefined;
  const { role, ...rest } = options;
  return role === undefined ? rest : { ...rest, kinds: roles[role] };
}
