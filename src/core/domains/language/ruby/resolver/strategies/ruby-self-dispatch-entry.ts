import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import {
  enclosingTypeOf,
  resolveSelfDispatchHookTarget,
  resolveTypeInstanceMethod,
  resolveTypeStaticMethod,
  type ResolverConfig,
} from "./shared.js";

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
 *   2c. **v2 override — the instance method is overridden below the delegator.**
 *      `Const#member` resolves to a non-template method on another type than the
 *      delegating class method's (`Destroy#call` in a service that defines `call`
 *      itself instead of `perform`). `new(...).member` runs that override, so it
 *      IS the target — emitted unless it is an abstract stub. A mixin override
 *      that re-enters the template through `super` is a template of its own
 *      (discovery's super propagation), so it narrows through 2b instead.
 *   2d. **The hook NAME is an argument** (bd tea-rags-mcp-emazx). `M` reaches
 *      `send("can_#{ability}?")` with `ability` forwarded unchanged from one of
 *      its own parameters (`ctx.selfDispatchArgTemplates`). The call site's
 *      literal at that position composes the hook (`:manage_datev` →
 *      `can_manage_datev?`) and the constant narrows it as in 2a. Declines on a
 *      non-literal argument or when the constant overrides a hop of the chain.
 *   3. Every hop yields a single method-level target. The edge is entry-anchored
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
      const target = resolveSelfDispatchHookTarget(receiver, hook, ctx, this.cfg.mode);
      if (target !== null) return resolved(target);
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
          const target2 = resolveSelfDispatchHookTarget(receiver, hook2, ctx, this.cfg.mode);
          if (target2 !== null) return resolved(target2);
        } else if (enclosingTypeOf(mInst.targetSymbolId) !== enclosingTypeOf(mClass.targetSymbolId)) {
          // v2 override — the delegated instance method is NOT the delegator's
          // own: a type between the constant and the delegator overrides it
          // (`class Destroy; include KindOfService; def call … end`). Then
          // `new(...).call` runs that override and never reaches a hook, so the
          // override itself is the one target. The shared choke point keeps a
          // stub override out (a declaration is not a call target).
          const override = resolveSelfDispatchHookTarget(receiver, call.member, ctx, this.cfg.mode);
          if (override !== null) return resolved(override);
        }
      }
    }

    // 2d — the hook NAME is an argument (bd tea-rags-mcp-emazx).
    const composed = this.resolveArgTemplateEntry(call, receiver, mClass.targetSymbolId, ctx);
    if (composed !== null) return composed;

    return CONTINUE; // not an entry we own — normal passes handle it
  }

  /**
   * Step 2d: `M` dispatches on self to `prefix + <argument> + suffix`
   * (`AbstractPolicy.authorize!` → `send("can_#{ability}?")`, bd
   * tea-rags-mcp-emazx). The call site's literal at the template's position
   * composes the hook, and the concrete constant narrows it exactly as v1 does.
   *
   * Two guards keep it a narrowing and never a guess:
   *   - the argument must be a literal name — an identifier or anything
   *     computed leaves the hook unknown;
   *   - every hop of the template's chain must still resolve, on the concrete
   *     constant, to the symbol the chain was built from. A receiver that
   *     overrides a hop (its own `#result`) runs that override, which need not
   *     reach the `send` at all.
   * Runs only after v1/v2 declined, so no edge they produced moves.
   */
  private resolveArgTemplateEntry(
    call: CallRef,
    receiver: string,
    templateSymbolId: string,
    ctx: CallContext,
  ): SymbolResolutionOutcome | null {
    const template = ctx.selfDispatchArgTemplates?.[templateSymbolId];
    if (template === undefined) return null;
    const atom = call.positionalArgAtoms?.[template.param];
    if (atom === undefined || atom === null || !("literal" in atom)) return null;
    for (const hop of template.via) {
      if (this.resolveHop(receiver, hop, ctx)?.targetSymbolId !== hop) return null;
    }
    const hook = `${template.prefix}${atom.literal}${template.suffix}`;
    const target = resolveSelfDispatchHookTarget(receiver, hook, ctx, this.cfg.mode);
    return target === null ? null : resolved(target);
  }

  /** Resolve one recorded hop (`Type#m` / `Type.m`) on the concrete constant, in the hop's own form. */
  private resolveHop(receiver: string, hop: string, ctx: CallContext) {
    const hash = hop.lastIndexOf("#");
    if (hash > 0) return resolveTypeInstanceMethod(receiver, hop.slice(hash + 1), ctx, this.cfg.mode);
    return resolveTypeStaticMethod(receiver, hop.slice(hop.lastIndexOf(".") + 1), ctx, this.cfg.mode);
  }
}
