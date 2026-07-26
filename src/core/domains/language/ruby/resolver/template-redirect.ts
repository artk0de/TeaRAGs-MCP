/**
 * Instance-rooted self-dispatch template redirect (bd tea-rags-mcp — DEFECT 2
 * G4). Spec: docs/superpowers/specs/2026-07-10-instance-template-redirect-design.md.
 *
 * v1/v2 (`RubySelfDispatchEntrySymbolResolutionStrategy`) anchor CONSTANT entries
 * (`Const.member` → `Const#H`). G4 closes the dominant taxdome shape they do NOT
 * reach: a TYPED-INSTANCE receiver whose static type inherits a shared template.
 *
 *   service = Create.new   # localBindings types `service` as Create
 *   service.call           # strategy chain resolves to the INHERITED template
 *                          #   node `KindOfService#call`
 *
 * `KindOfService#call` self-calls the abstract `perform` hook that only the
 * concrete subtype `Create` defines. The strategy chain, seeing an instance
 * receiver typed `Create`, resolves `call` up the MRO to the template node — the
 * recall hole (`get_callers(Create#perform) = []`).
 *
 * ONE central post-resolution redirect fixes it, applied in `ruby-resolver.ts`
 * `resolve()` AFTER the strategy chain returns a resolved target — NOT threaded
 * through the 12 strategies. When the resolved target's symbolId is a key of
 * `ctx.selfDispatchTemplates` (O(1)) and the call's receiver has a CONCRETE
 * static type (drawn from the exact sources the strategies already consult —
 * `localBindings`, `ivarTypes`, chain propagation — via {@link typeOfReceiver}),
 * the abstract hook narrows to that concrete type's `Type#hook` via
 * {@link resolveTypeInstanceMethod}. The edge stays entry-anchored
 * (`enclosing(service.call) → Create#perform`).
 *
 * Strictly ADDITIVE refinement — zero recall risk. ANY miss keeps the ORIGINAL
 * resolved target: feature off, file-only target, non-template target, null /
 * untyped / non-concrete receiver, the receiver's type IS the template's own
 * (abstract) enclosing type (no concrete subtype to narrow to), or the hook is
 * not method-level-defined on the concrete type. Never drop an existing edge,
 * never fabricate a file-only edge. Constant-entry narrowing (v1/v2) is
 * untouched — a constant entry already resolves to `Const#H`, which is not a
 * `selfDispatchTemplates` key, so this redirect is inert for it.
 */

import type {
  AmbiguousResolveMode,
  CallContext,
  CallRef,
  SymbolResolutionTarget,
} from "../../../../contracts/types/codegraph.js";
import { resolveTypeInstanceMethod } from "./strategies/shared.js";
import { typeOfReceiver } from "./type-propagation.js";

/**
 * Refine a resolved call target: when it points at a self-dispatch template node
 * and the call's receiver has a concrete static type, narrow the abstract hook to
 * that type's concrete `Type#hook`. Returns the ORIGINAL `target` unchanged on any
 * miss (the additive-refinement invariant). Pure — no side effects.
 */
export function redirectSelfDispatchTemplate(
  target: SymbolResolutionTarget,
  call: CallRef,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
): SymbolResolutionTarget {
  const templates = ctx.selfDispatchTemplates;
  if (templates === undefined) return target; // feature off / non-Ruby run
  if (target.targetSymbolId === null) return target; // file-only — no template node to redirect

  const hook = templates[target.targetSymbolId];
  if (hook === undefined) return target; // not a self-dispatch template node

  const { receiver } = call;
  if (receiver === null) return target; // no receiver to type

  // Receiver's concrete static type via the EXACT sources the strategies consult
  // (localBindings / ivarTypes / chain propagation) — no re-implemented inference.
  const typeRef = typeOfReceiver(receiver, call.startLine, ctx);
  if (typeRef === undefined) return target; // untyped receiver → keep original
  if (typeRef.form !== "class" && typeRef.form !== "instance") return target; // union/container → keep

  const receiverType = typeRef.name;

  // The receiver IS the template's own (abstract) enclosing type — no concrete
  // subtype to narrow to, so the abstract template edge stays.
  if (receiverType === enclosingTypeOf(target.targetSymbolId)) return target;

  // Narrow the abstract hook to the concrete type's method-level `Type#hook`.
  const redirected = resolveTypeInstanceMethod(receiverType, hook, ctx, mode);
  if (redirected === null) return target; // concrete type / hook unresolved → keep original
  if (redirected.targetSymbolId === null) return target; // never downgrade to a file-only edge
  return redirected;
}

/**
 * The enclosing type of a method symbolId — the segment before the class↔method
 * separator: `KindOfService#call` → `KindOfService`, `KindOfService.call` →
 * `KindOfService`, `Mod::Svc#m` → `Mod::Svc` (`::` is the namespace separator, not
 * the method separator). `null` for a separatorless top-level function symbolId
 * (never a template). Instance (`#`) and class (`.`) forms are both handled.
 */
function enclosingTypeOf(symbolId: string): string | null {
  const hash = symbolId.lastIndexOf("#");
  if (hash !== -1) return symbolId.slice(0, hash);
  const dot = symbolId.lastIndexOf(".");
  if (dot !== -1) return symbolId.slice(0, dot);
  return null;
}
