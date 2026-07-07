import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { resolveTypeInstanceMethod, resolveTypeStaticMethod, type ResolverConfig } from "./shared.js";

/** Ruby constants begin uppercase; `::`-joined segments form a scope chain. */
const CONSTANT_RE = /^[A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*$/;

/**
 * Entry-anchored self-dispatch resolution (bd tea-rags-mcp — DEFECT 2,
 * self-receiver abstract-hook dispatch). Spec:
 * docs/superpowers/specs/2026-07-06-ruby-self-receiver-dispatch-design.md.
 *
 * A shared template `M` (e.g. `KindOfService.call` / `BaseProcessor#process`)
 * dispatches to a hook `H` on `self` (bare `H`, `self.H`, `self.new.H`) that the
 * template's own type does NOT define — a concrete subtype/includer/prepender/
 * extender does. Resolving that self-call AT the template is context-insensitive:
 * `self` is abstract, so it either drops (recall hole — `get_callers(Sub#H) = []`)
 * or fans out to every concrete definer (a representation error — no single
 * execution dispatches to all of them).
 *
 * The real trace is per-entry and singular. At an entry call `Const.member` the
 * receiver is a **concrete constant**, so the abstract hook narrows to exactly
 * ONE target by construction:
 *
 *   Create.call   → Create#perform      (receiver Create concrete → 1)
 *   Refresh.call  → Refresh#perform     (receiver Refresh concrete → 1)
 *
 * Mechanism, per entry call-site `Const.member`:
 *   1. `member` resolves via the class-method MRO walk (`resolveTypeStaticMethod`)
 *      to the inherited CLASS method `M` it dispatches to — the template candidate.
 *   2a. **v1 — `M` is itself a template.** `M` is a self-dispatch template iff its
 *      symbolId is a key of `ctx.selfDispatchTemplates` (built structurally by the
 *      pass-1→pass-2 discovery pre-pass, hook `H` the value). Then the concrete
 *      constant narrows `H` to `Const#H` via `resolveTypeInstanceMethod` — a single
 *      method-level target. Emit it.
 *   2b. **v2 — `M` self-INSTANTIATES and delegates to the SAME-named instance
 *      template.** The real KindOfService entry is two hops: a CLASS method
 *      `self.call` that does `instance = new(*args); instance.call` and delegates
 *      to the INSTANCE method `#call`, where THAT instance method (not the class
 *      method) is the self-dispatch template (hook `perform`). The class method's
 *      only self-hook is `new` (the `instance.call` delegation is on a local var,
 *      not captured), so v1 misses it. When `M ∈ ctx.selfInstantiatingClassMethods`
 *      we re-resolve `Const#member` (INSTANCE form, same member); if THAT is a
 *      `selfDispatchTemplates` key (hook `H`), the constant narrows `H` to `Const#H`.
 *      Emit it.
 *   3. Either hop yields a single method-level target. The edge is entry-anchored
 *      (`enclosing(Const.member) → Const#H`), never piled at the shared template node.
 *
 * **MUST run BEFORE `constant`:** otherwise `RubyConstantSymbolResolutionStrategy`
 * resolves `Const.member` to the template class-method / file edge and the
 * concrete hook edge is lost (mirrors the enqueue-dispatch precedence). A miss at
 * any step CONTINUEs (never DROPs) so a non-entry `Const.member` falls through to
 * the normal passes untouched.
 */
export class RubySelfDispatchEntrySymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "selfDispatchEntry";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const templates = ctx.selfDispatchTemplates;
    if (templates === undefined) return CONTINUE; // feature off / non-Ruby run
    const { receiver } = call;
    if (receiver === null || !CONSTANT_RE.test(receiver)) return CONTINUE; // need a concrete constant entry

    // Resolve the entry member (a class-method call on the constant) to the
    // inherited CLASS method it dispatches to — the template candidate.
    const mClass = resolveTypeStaticMethod(receiver, call.member, ctx, this.cfg.mode);
    if (mClass === null) return CONTINUE; // member does not resolve on the constant
    if (mClass.targetSymbolId === null) return CONTINUE; // file-only — no method candidate

    // v1 — the class method itself is a self-dispatch template. Concrete constant
    // receiver ⇒ the abstract hook narrows to exactly `Const#H`, pinned
    // method-level. A file-only miss must NOT fabricate an edge, so fall through.
    const hook = templates[mClass.targetSymbolId];
    if (hook !== undefined) {
      const target = resolveTypeInstanceMethod(receiver, hook, ctx, this.cfg.mode);
      if (target !== null && target.targetSymbolId !== null) return resolved(target);
    }

    // v2 — the class method self-instantiates and delegates to the SAME-named
    // INSTANCE method (`instance = new; instance.member`); it is that instance
    // method that is the template. Bridge: `Const.member` (class) → `Const#member`
    // (instance template, hook `H`) → `Const#H`, all narrowed by the concrete
    // constant. Only method-level targets emit an edge; anything file-only or
    // absent falls through to the normal passes.
    if (ctx.selfInstantiatingClassMethods?.includes(mClass.targetSymbolId) === true) {
      const mInst = resolveTypeInstanceMethod(receiver, call.member, ctx, this.cfg.mode);
      if (mInst !== null && mInst.targetSymbolId !== null) {
        const hook2 = templates[mInst.targetSymbolId];
        if (hook2 !== undefined) {
          const target2 = resolveTypeInstanceMethod(receiver, hook2, ctx, this.cfg.mode);
          if (target2 !== null && target2.targetSymbolId !== null) return resolved(target2);
        }
      }
    }

    return CONTINUE; // not an entry we own — normal passes handle it
  }
}
