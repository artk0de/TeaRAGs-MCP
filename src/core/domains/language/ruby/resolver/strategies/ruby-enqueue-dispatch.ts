import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { enqueueEntrypoint } from "../../dsl/index.js";
import { resolveTypeInstanceMethod, type ResolverConfig } from "./shared.js";

/**
 * Background-job enqueue dispatch (bd tea-rags-mcp-of2sl). A framework
 * CLASS-method enqueue call — `Worker.perform_async(args)` (Sidekiq /
 * Sidekiq-Pro) or `Job.perform_later(args)` (ActiveJob) — routes at runtime to
 * the worker/job's INSTANCE entrypoint `#perform`. The enqueue verb itself is a
 * gem mixin method with no in-project `def`, so the plain `constant` pass that
 * follows can only land a file-edge (or drop); the real flow edge the caller
 * needs is `caller -> <Worker>#perform`.
 *
 * The member is rewritten to the {@link enqueueEntrypoint} (`perform`) and
 * resolved against the constant receiver's class via the shared
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
    const entrypoint = enqueueEntrypoint(call.member);
    if (entrypoint === undefined) return CONTINUE; // not an enqueue verb
    const target = resolveTypeInstanceMethod(call.receiver, entrypoint, ctx, this.cfg.mode);
    return target ? resolved(target) : CONTINUE;
  }
}
