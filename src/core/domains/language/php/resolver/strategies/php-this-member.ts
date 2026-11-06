import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef, SymbolResolutionTarget } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { enclosingOwner, type ResolverConfig } from "./shared.js";

/**
 * `$this->format()` → the enclosing scope's member in the caller's file.
 *
 * Instance form `Greeter#format` first, then static form `Greeter.format`.
 * The scope chain joins with `\`, so a method whose chunk scope is
 * `["Outer", "Inner"]` looks up `Outer\Inner#format`. PHP does not nest
 * classes; the chain is one class name for every method this walker emits.
 *
 * Owns every `$this` call. A miss DROPs. Falling through would let
 * `globalShortName` bind `$this->format()` to a function named `format`.
 * A `$this` call with an empty scope DROPs too: it is not a global function.
 * Any other receiver is `qualifiedReceiver`'s case.
 */
export class PhpThisMemberSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "thisMember";
  constructor(_cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== "$this") return CONTINUE;
    const hit = lookupEnclosingMember(call.member, ctx);
    return hit ? resolved(hit) : DROP;
  }
}

function lookupEnclosingMember(member: string, ctx: CallContext): SymbolResolutionTarget | null {
  const owner = enclosingOwner(ctx.callerScope);
  if (owner === null) return null;
  for (const symbolId of [`${owner}#${member}`, `${owner}.${member}`]) {
    const hit = ctx.symbolTable.lookup(symbolId).find((def) => def.relPath === ctx.callerFile);
    if (hit) return { targetRelPath: hit.relPath, targetSymbolId: hit.symbolId };
  }
  return null;
}
