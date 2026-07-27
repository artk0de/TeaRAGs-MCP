import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import type {
  AmbiguousResolveMode,
  CallContext,
  CallRef,
  SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { ivarTypeName } from "../type-propagation.js";
import { resolveTypeMethod, type ResolverConfig } from "./shared.js";

/** A single instance-variable receiver (`@client`); a chained `@a.b` is out of scope. */
const IVAR_RECEIVER = /^@\w+$/;

/**
 * The ONE authority for "what does `@ivar.member` resolve to" (bd
 * tea-rags-mcp-bvalc — same single-authority discipline as {@link ivarTypeName}
 * and `resolveBoundCallTarget`). Returns the exact target, or `null` when the
 * receiver is not a bare `@ivar`, carries no known type, or its type declares no
 * such member.
 *
 * Read by the strategy below AND by the dynamic-dispatch component, which must
 * know whether the exact path ACTUALLY answers before it decides to fan out. Two
 * separate lookups would drift: a receiver the fan-out believes untyped while
 * the strategy pins it produces N wrong-type edges that bury the right one.
 */
export function resolveIvarFieldTarget(
  call: CallRef,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
): SymbolResolutionTarget | null {
  const { receiver } = call;
  if (!receiver || !IVAR_RECEIVER.test(receiver) || ctx.callerScope.length === 0) return null;
  const typeName = ivarTypeName(receiver, ctx);
  if (!typeName) return null;
  return resolveTypeMethod(typeName, call.member, ctx, mode);
}

/**
 * `@ivar.X` resolution over the ivar type channels (cai0 imass — the universal
 * type-inference interface; Ruby is its 5th implementation after
 * TS/Java/Python/Rust). A single `@ivar` receiver whose type was recorded from a
 * constructor assignment (`@client = HttpClient.new`) resolves `<type>#<member>`
 * via the shared `resolveTypeMethod` (scope-tail + prepend + ancestor MRO).
 *
 * The lookup goes through {@link ivarTypeName} — the single authority shared with
 * `typeOfReceiver` and `RubyExternalVocabulary` (bd tea-rags-mcp-wr7ku), so a
 * precise-channel (`ctx.ivarTypes`) fact and a walker-channel
 * (`ctx.classFieldTypes`) fact are read in the same order by every reader. Read
 * it inline here and a Sorbet-annotated ivar would type a chain receiver while
 * DROPping on a bare `@ivar.member` site.
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
    const target = resolveIvarFieldTarget(call, ctx, this.cfg.mode);
    return target ? resolved(target) : DROP;
  }
}
