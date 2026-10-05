/**
 * The Ruby resolver's ONE short-name entry point, and the path predicate it
 * gates on (bd tea-rags-mcp-kumq2). Mirrors `lookupPythonSymbolsByShortName` +
 * `isPythonSourcePath` on the Python side.
 *
 * A LEAF module by construction — it imports the codegraph contracts, Ruby's
 * capability descriptor and the kernel's kind-role translation, all three
 * type-only or data-only, and nothing else. The walker's inline type sources reach into
 * `resolver/type-propagation.ts`, so `ruby-return-facts.ts` and
 * `ruby-unbound-receiver-types.ts` sit on that walker-facing side and must not
 * import anything that leads back into the walker. `strategies/shared.ts` (where
 * Python keeps its half) used to: it reached `walker/walker.js` for
 * `ZEITWERK_PREFIX` until that constant moved to the `ruby/zeitwerk-import-marker.ts`
 * leaf (bd tea-rags-mcp-xuywm). `shared.ts` re-exports both names, so every
 * existing `isRubyPath` import keeps its path.
 */

import type {
  CallContext,
  CallRef,
  SymbolDefinition,
  SymbolLookupRole,
} from "../../../../contracts/types/codegraph.js";
import type { DispatchFanoutPopulation } from "../../../../contracts/types/language.js";
import { symbolLookupOptionsFor, type CallRoleSymbolLookupOptions } from "../../kernel/index.js";
import { capability } from "../capability.js";

/** Ruby's kind roles — a bare `Money(x)` calls a method, never `class Money`. */
const RUBY_SYMBOL_KIND_ROLES = capability.codegraph.symbolKindRoles;

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
 * The population Ruby's dispatch fan-out cap is computed over (bd
 * tea-rags-mcp-nbf8q): exactly the files {@link lookupRubySymbolsByShortName}
 * draws candidates from, so the p99 describes the fans it caps. On taxdome the
 * polyglot corpus p99 is 16 and Ruby's own 19.
 */
export const RUBY_FANOUT_POPULATION: DispatchFanoutPopulation = {
  family: "ruby",
  ownsPath: isRubyPath,
  calleeKinds: RUBY_SYMBOL_KIND_ROLES.callee,
};

/**
 * The part of the call `call.member` plays in a Ruby lookup (bd
 * tea-rags-mcp-jqvbn). Normally the CALLEE; but the walker spells a constant
 * REFERENCE — an association's model, a registry value, a CanCanCan subject —
 * as `{ receiver: C, member: C }`, and there the member names the class
 * itself, which Ruby never calls and only ever receives on. Looked up as a
 * callee, `belongs_to :user` lost its class symbol and decayed to a file-only
 * edge (huginn 41 sites, mastodon 338).
 */
export function rubyMemberLookupRole(call: Pick<CallRef, "receiver" | "member">): SymbolLookupRole {
  return call.receiver === call.member ? "receiver" : "callee";
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
 *
 * A lookup for a part of a call names its `role` and is answered with Ruby's
 * kinds for it (bd tea-rags-mcp-jqvbn); no role is a type lookup.
 */
export function lookupRubySymbolsByShortName(
  ctx: CallContext,
  name: string,
  options?: CallRoleSymbolLookupOptions,
): SymbolDefinition[] {
  return ctx.symbolTable
    .lookupByShortName(name, symbolLookupOptionsFor(RUBY_SYMBOL_KIND_ROLES, options))
    .filter((def) => isRubyPath(def.relPath));
}
