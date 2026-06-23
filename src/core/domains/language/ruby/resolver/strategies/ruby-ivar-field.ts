import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { resolveTypeMethod, type ResolverConfig } from "./shared.js";

/** A single instance-variable receiver (`@client`); a chained `@a.b` is out of scope. */
const IVAR_RECEIVER = /^@\w+$/;

/**
 * `@ivar.X` resolution via the walker-inferred `classFieldTypes` channel (cai0
 * imass — the universal type-inference interface; Ruby is its 5th implementation
 * after TS/Java/Python/Rust). A single `@ivar` receiver whose type was recorded
 * from a constructor assignment (`@client = HttpClient.new`) resolves
 * `<type>#<member>` via the shared `resolveTypeMethod` (scope-tail + prepend +
 * ancestor MRO). The enclosing-class key is `callerScope.join("::")`, matching
 * `collectRubyClassAncestors` / `collectRubyIvarFieldTypes`.
 *
 * **Guard:** a `@ivar` access is an instance-field receiver, never an import /
 * global name — so an ivar with NO recorded type DROPS rather than falling
 * through to the ambiguous short-name path (which would attribute the call to
 * any unrelated class that happens to define `<member>`).
 *
 * **Divergence from PythonSelfFieldSymbolResolutionStrategy:** a gem type (no
 * project file) DROPS rather than emitting a best-effort external target. The
 * dropped gem-ivar reaches `targetsExternalImport`, where `RubyExternalVocabulary`
 * reclassifies it as external — so it leaves the resolveSuccessRate denominator
 * (honest denominator, cai0) instead of fabricating a `Net::HTTP#get` edge.
 */
export class RubyIvarFieldSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "ivarField";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const { receiver } = call;
    if (!receiver || !IVAR_RECEIVER.test(receiver) || ctx.callerScope.length === 0) return CONTINUE;
    const typeName = ctx.classFieldTypes?.[ctx.callerScope.join("::")]?.[receiver];
    if (!typeName) return DROP;
    const target = resolveTypeMethod(typeName, call.member, ctx, this.cfg.mode);
    return target ? resolved(target) : DROP;
  }
}
