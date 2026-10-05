/**
 * The Python resolver's ONE short-name entry point (bd tea-rags-mcp-0qaht.35).
 * Mirrors `lookupRubySymbolsByShortName` in Ruby's
 * `ruby/resolver/short-name-lookup.ts` (bd tea-rags-mcp-kumq2).
 *
 * A LEAF module by construction — it imports the codegraph contracts, the
 * kernel's kind-role translation, Python's capability descriptor and the
 * source-extension predicate, all type-only or data-only, and nothing else.
 * It exists because `python-import-file-mapper.ts` — a resolver-root module
 * the strategies reach back into for the mapper TYPE — also needs this lookup,
 * and defining it in `strategies/shared.ts` closed the vertical's only import
 * cycle (`python-import-file-mapper.ts` ⇄ `strategies/shared.ts`). Parent
 * resolver files must not reach into child `strategies/`; child strategies
 * consuming parent resolver helpers is the established direction.
 *
 * `strategies/shared.ts` re-exports both names, so every existing import path
 * keeps working.
 */

import type { CallContext, SymbolDefinition } from "../../../../contracts/types/codegraph.js";
import { symbolLookupOptionsFor, type CallRoleSymbolLookupOptions } from "../../kernel/index.js";
import { capability } from "../capability.js";
import { isPythonSourcePath } from "../vocabulary/source-extensions.js";

/**
 * Short-name lookup restricted to PYTHON candidates — the ONLY short-name entry
 * point the Python resolver may use (bd tea-rags-mcp-w205u).
 *
 * The symbol table is built once per run over every `CODEGRAPH_LANGUAGES`
 * extension and carries no `language` field, so `lookupByShortName` alone
 * answers with any file that spells the name. It is not a hypothetical: polar's
 * `range(...)` landed on `Paginator.tsx#range` and `GitHub()` on
 * `Icons.tsx#GitHub`, 46 phantoms across two strategies. Wrapping the call
 * rather than filtering per site is what keeps the guard from being forgotten
 * at the next one; see {@link isPythonSourcePath} for why the extension, and
 * not a `language` field, is the axis.
 */
export function lookupPythonSymbolsByShortName(
  ctx: CallContext,
  name: string,
  options?: CallRoleSymbolLookupOptions,
): SymbolDefinition[] {
  return ctx.symbolTable
    .lookupByShortName(name, symbolLookupOptionsFor(PYTHON_SYMBOL_KIND_ROLES, options))
    .filter((def) => isPythonSourcePath(def.relPath));
}

/**
 * Python's kind roles (bd tea-rags-mcp-jqvbn): `Color(1)` calls an Enum and
 * `UserId(5)` a `NewType`, so both are callees here. A lookup for a part of a
 * call passes its `role` to {@link lookupPythonSymbolsByShortName}; no role is
 * a type lookup.
 */
export const PYTHON_SYMBOL_KIND_ROLES = capability.codegraph.symbolKindRoles;

/**
 * Fully-qualified lookup restricted to PYTHON candidates — the lookup the
 * Python resolver hands `reexportOriginFile` (bd tea-rags-mcp-nbf8q). The
 * fq key is no safer than the short name: a top-level class's fqName is its
 * bare name in every language, so a TypeScript `Flask` beside the package's
 * own made the barrel hop read two declarations and decline, or land a Python
 * import on a `.ts` file. Mirrors `lookupEcmascriptSymbols` on the TypeScript
 * side.
 */
export function lookupPythonSymbols(ctx: CallContext, fqName: string): SymbolDefinition[] {
  return ctx.symbolTable.lookup(fqName).filter((def) => isPythonSourcePath(def.relPath));
}
