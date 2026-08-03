import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import type {
  AmbiguousResolveMode,
  CallContext,
  CallRef,
  SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { conventionReceiverType, ivarTypeName } from "../type-propagation.js";
import { resolveTypeInstanceMethod, resolveTypeMethod, type ResolverConfig } from "./shared.js";

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
 * The LAST tier of `@ivar` typing: the naming convention, consulted only once
 * every fact channel has gone silent (bd tea-rags-mcp-r2gjj).
 *
 * `@user` is a `User` for exactly the reason `user` is — the Rails naming
 * discipline does not care about the sigil — and {@link conventionReceiverType}
 * already strips it. What kept this population out of reach was chain ORDER,
 * not typing: `conventionReceiver` sits at position 12 and `ivarField` DROPs at
 * position 4, so an `@ivar` call never reached the pass that would type it. On
 * taxdome that is 2586 misses, 17.4% of the whole recall hole.
 *
 * The tier reuses the wob7g helper rather than restating it, so its two gates —
 * the class must EXIST, and it must have NO declared subtypes — are stated
 * once. The subtype gate is the load-bearing one: `@actor` in an app whose
 * `Actor` is specialised by System / Guest / User / Employee carries a concrete
 * subtype, and it alone accounts for 589 of the misses this tier declines.
 *
 * **A DECLARED type is never overridden.** `ivarTypeName` answering means the
 * channels DID type this ivar and the terminal declined for a reason of its
 * own — most often a gem type with no project file, which
 * `RubyExternalVocabulary.ivarTargetsExternal` reclassifies as external. The
 * convention would both fabricate an edge against a declared foreign type and
 * drag the call back into the resolveSuccessRate denominator as a resolution.
 * So the tier fires only on an ivar NO channel recorded at all.
 *
 * **Method-level or nothing**, matching `conventionReceiver`'s gate 3: the
 * file-only degradation `resolveTypeInstanceMethod` returns when the class
 * resolves but declares no such member is declined, because such an edge is
 * invisible to `get_callers` and inflates file fan-in on the biggest models in
 * the app. That terminal is also the precision mechanism — a wrong guess dies
 * on member absence rather than emitting. Graded against the resolver's own
 * fact channels on the 997 taxdome ivar sites a real fact types, the convention
 * names a different class 58 times and emits a different target ZERO times:
 * edge accuracy 100%, all 58 wrong guesses silent at the terminal.
 */
function resolveIvarConventionTarget(
  receiver: string,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
): SymbolResolutionTarget | null {
  if (ivarTypeName(receiver, ctx) !== undefined) return null;
  const type = conventionReceiverType(receiver, ctx);
  // The convention only ever yields the `instance` form; the narrowing keeps
  // that a compile-time fact rather than a comment.
  if (type?.form !== "instance") return null;
  const target = resolveTypeInstanceMethod(type.name, member, ctx, mode);
  if (target === null) return null;
  // The file-only degradation is a decline, not a weaker answer — see above.
  return target.targetSymbolId === null ? null : target;
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
 * global name — so an ivar no channel typed and no convention names DROPS
 * rather than falling through to the ambiguous short-name path (which would
 * attribute the call to any unrelated class that happens to define `<member>`).
 * The naming convention is consulted first, as the last tier — see
 * {@link resolveIvarConventionTarget}.
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
    if (target) return resolved(target);
    const conventional = resolveIvarConventionTarget(receiver, call.member, ctx, this.cfg.mode);
    return conventional ? resolved(conventional) : DROP;
  }
}
