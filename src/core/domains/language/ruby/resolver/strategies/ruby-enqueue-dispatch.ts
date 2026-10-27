import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef, SymbolResolutionTarget } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { catalogueFor } from "../../dsl/index.js";
import { resolveSelfDispatchHookTarget, resolveTypeInstanceMethod, type ResolverConfig } from "./shared.js";

/**
 * Background-job enqueue dispatch (bd tea-rags-mcp-of2sl). A framework
 * CLASS-method enqueue call — `Worker.perform_async(args)` (Sidekiq /
 * Sidekiq-Pro) or `Job.perform_later(args)` (ActiveJob) — routes at runtime to
 * the worker/job's INSTANCE entrypoint `#perform`. The enqueue verb itself is a
 * gem mixin method with no in-project `def`, so the plain `constant` pass that
 * follows can only land a file-edge (or drop); the real flow edge the caller
 * needs is `caller -> <Worker>#perform`.
 *
 * The member is rewritten to the catalogue's `enqueueDispatch` entrypoint
 * (`perform`) and resolved against the constant receiver's class via the shared
 * `resolveTypeInstanceMethod` MRO walk — so an INHERITED `#perform` (the common
 * `DistributionWorker < RawDistributionWorker` shape) still pins to the
 * ancestor's definition.
 *
 * **MUST run BEFORE `constant`:** otherwise `RubyConstantSymbolResolutionStrategy`
 * resolves `<Worker>.perform_async` as a (non-existent) class method / file edge
 * and the instance-entrypoint edge is lost. A miss CONTINUEs rather than DROPs:
 * a `.perform_async` on an unresolved / external constant should fall through to
 * the normal passes, not be swallowed.
 */
export class RubyEnqueueDispatchSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "enqueueDispatch";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver === null) return CONTINUE; // bare call — no worker class to route to
    // Gem-gated enqueue verb → `#perform` entrypoint, composed for this project.
    const dispatch = catalogueFor(ctx.declaredDependencies).enqueueDispatch;
    const entrypoint = enqueueEntrypoint(dispatch, call.member);
    if (entrypoint === undefined) return CONTINUE; // not an enqueue verb
    const target = resolveTypeInstanceMethod(call.receiver, entrypoint, ctx, this.cfg.mode);
    if (target === null) return CONTINUE;
    // A wrapper is a project method: a file-only entrypoint would replace the
    // method edge the `constant` pass lands on it, so only a pinned run wins.
    if (dispatch[call.member] === undefined && target.targetSymbolId === null) return CONTINUE;
    return resolved(this.narrowInheritedEntrypoint(target, call.receiver, ctx));
  }

  /**
   * An INHERITED entrypoint that is a self-dispatch template (`Base#perform`
   * calling an abstract `perform_operation`) narrows to the worker's own hook —
   * the KindOfService entry shape, applied to the job the verb enqueues (bd
   * tea-rags-mcp-q1g6s.10). The redirect after the chain cannot do it: it types
   * the receiver, and a bare constant carries no receiver type.
   */
  private narrowInheritedEntrypoint(
    target: SymbolResolutionTarget,
    worker: string,
    ctx: CallContext,
  ): SymbolResolutionTarget {
    const hook = target.targetSymbolId === null ? undefined : ctx.selfDispatchTemplates?.[target.targetSymbolId];
    if (hook === undefined) return target;
    return resolveSelfDispatchHookTarget(worker, hook, ctx, this.cfg.mode) ?? target;
  }
}

/**
 * The entrypoint an enqueue verb runs — the catalogue's own verb, or a project
 * WRAPPER named after one (`perform_async_operation` → `perform_async`'s
 * `perform`, bd tea-rags-mcp-q1g6s.10): such a wrapper hands the class to the
 * same queue, and the run it starts is the worker's entrypoint, which the
 * self-dispatch redirect then narrows (`#perform` → the concrete
 * `#perform_operation`).
 */
function enqueueEntrypoint(dispatch: Readonly<Record<string, string>>, member: string): string | undefined {
  const direct = dispatch[member];
  if (direct !== undefined) return direct;
  const verb = Object.keys(dispatch).find((candidate) => member.startsWith(`${candidate}_`));
  return verb === undefined ? undefined : dispatch[verb];
}
