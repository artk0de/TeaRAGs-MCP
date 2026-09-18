import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { goLocalAt } from "../../local-scope.js";
import { resolveByLocalType, type ResolverConfig } from "./shared.js";

/**
 * Step 0 (bd tea-rags-mcp-e6xx) — walker-inferred local type wins over
 * heuristic resolution. When the receiver maps to a known type via `(r *Type)`
 * receiver, `(p Type)` value param, or `func f(p *Type)` parameter, resolution
 * is constrained to that type; edges to unrelated symbols with the same
 * short-name are never fabricated.
 *
 * This is a **guard** strategy: once `localBindings[receiver]` names a type, the
 * call is owned here — it either resolves (`Type#member` / `Type.member`) or
 * **drops**. It must NOT fall through to a global short-name lookup, which would
 * fabricate a false-positive edge to an unrelated same-named symbol.
 *
 * A binding in effect with the EMPTY type is a local no pass can type — a
 * function-literal parameter of an unbindable type shadowing its name, or any
 * local or parameter named like an import (`config, err := loadTwo()`,
 * `func f(render io.Writer)`; bd tea-rags-mcp-e6xx). It DROPS too: the call
 * binding (`c := New()`) and the import it shadows would both speak for the
 * wrong variable. "In effect" is Go's scope rule (`goLocalAt`): a local a
 * statement declares is not yet in scope on that statement's own lines, and
 * of the locals in scope the one declared last wins — a call binding declared
 * after this one (`e := New()` in a nested block) is `returnTypeBinding`'s.
 */
export class GoLocalBindingSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "localBinding";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver) return CONTINUE;
    const local = goLocalAt(ctx, call.receiver, call.startLine);
    if (local?.kind !== "value") return CONTINUE;
    if (!local.binding.type) return DROP;
    const target = resolveByLocalType(this.cfg, local.binding.type, call.member, ctx);
    return target ? resolved(target) : DROP;
  }
}
