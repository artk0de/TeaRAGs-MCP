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
 *      to the inherited method `M` it dispatches to — the template candidate.
 *   2. `M` is a self-dispatch template iff its symbolId is a key of
 *      `ctx.selfDispatchTemplates` (built structurally by the pass-1→pass-2
 *      discovery pre-pass, hook `H` the value). Not a key ⇒ CONTINUE, the normal
 *      passes own it.
 *   3. The concrete constant narrows `H` to `Const#H` via
 *      `resolveTypeInstanceMethod` — a single method-level target. Emit it. The
 *      edge is entry-anchored (`enclosing(Const.member) → Const#H`), never piled
 *      at the shared template node.
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
    // inherited method it dispatches to — the self-dispatch template candidate.
    const template = resolveTypeStaticMethod(receiver, call.member, ctx, this.cfg.mode);
    if (template === null) return CONTINUE; // member does not resolve on the constant
    if (template.targetSymbolId === null) return CONTINUE; // file-only — no template candidate

    const hook = templates[template.targetSymbolId];
    if (hook === undefined) return CONTINUE; // not a template — normal passes own it

    // Concrete constant receiver ⇒ the abstract hook narrows to exactly one:
    // `Const#H`, pinned method-level. A file-only miss must NOT fabricate an edge
    // (the recall fix needs the method target), so CONTINUE and let the normal
    // constant/bare passes handle it.
    const target = resolveTypeInstanceMethod(receiver, hook, ctx, this.cfg.mode);
    if (target === null) return CONTINUE; // hook does not resolve on the concrete constant
    if (target.targetSymbolId === null) return CONTINUE; // file-only miss must NOT fabricate an edge
    return resolved(target);
  }
}
