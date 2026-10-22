import { resolved } from "../../../../../contracts/resolution.js";
import {
  nearestCallResultBinding,
  resolveLocalBinding,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type LocalBinding,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome } from "../../../../../contracts/types/language.js";
import {
  LocalBindingSymbolResolutionStrategy,
  type NominalTypeRef,
  type ReceiverCallRef,
  type ReceiverTypingPorts,
  type TypeMemberLookup,
} from "../../../kernel/index.js";
import { rustStdPrimitiveTypes } from "../../vocabulary/std-prelude.js";
import { rustCallResultBindingOf, rustDeclaredCallResultType } from "../declared-call-result-type.js";
import { rustPatternBindingType } from "../pattern-binding-type.js";
import {
  createRustTypeMemberLookup,
  resolveRustTypedMissMember,
  rustTypedMissIsProven,
} from "../rust-type-member-lookup.js";
import { rustDeclaredTypeIsForeign } from "../std-type-hops.js";
import { rustExpressionType, rustMethodCallResultType } from "./rust-type-receiver.js";
import { lookupRustSymbolsByShortName, type ResolverConfig } from "./shared.js";

const RUST_LOCAL_BINDING_TYPING: ReceiverTypingPorts = {
  typeOfReceiver: (call, ctx) => {
    const binding = resolveLocalBinding(ctx.localBindings, call.receiver, call.startLine, call.startColumn);
    if (binding === undefined) {
      return (
        rustDeclaredCallResultType(call.receiver, call.startLine, ctx) ??
        rustMethodCallResultType(call.receiver, call.startLine, ctx) ??
        null
      );
    }
    // A pattern binding shadows the name: its fold answers, never the
    // call-result channel or an outer binding (bd tea-rags-mcp-s3i8m, Task 1a).
    // An unproven fold answers null, so the call CONTINUES down the chain
    // exactly as an unbound receiver does (Task 1c, additive invariant).
    if (binding.valueKind === "patternProjection") {
      return rustPatternBindingType(binding, ctx, rustExpressionType) ?? null;
    }
    if (binding.typeRef !== undefined) {
      return binding.typeRef.form === "instance" && binding.typeRef.name.length > 0 ? binding.typeRef : null;
    }
    if (binding.type.length > 0) return { form: "instance", name: binding.type };
    const callBinding = nearestCallResultBinding(ctx.callResultBindings, call.receiver, call.startLine);
    const returnType = callBinding === undefined ? undefined : ctx.functionReturnTypes?.[callBinding.callee];
    return returnType === undefined ? null : { form: "instance", name: returnType };
  },
};

/**
 * bd tea-rags-mcp-c5by — when `localBindings` type-binds the receiver to a
 * known type, resolve against THAT type's members first AND drop the global
 * short-name fallback when the type lacks the member. Prevents `obj.clone()`
 * (obj: Worker) silently routing to `Error#clone`. Mirrors Java 9t8z / Go e6xx
 * "drop unsafe short-name fallback when receiver type known but member
 * missing". Tries the `#` (instance) form first, then `.` (associated
 * function), preferring the same-file candidate when the type name collides
 * across files (bd tea-rags-mcp-p8wz).
 *
 * Guard pass: a known receiver type whose member is absent DROPS the edge —
 * falling through to short-name lookup would resolve to a method on an
 * unrelated type (the c5by garbage). A receiver with no bound type continues
 * to the import-match / short-name passes, and so does a call-result local
 * whose miss the member lookup cannot rule out (`rustTypedMissDrops`).
 *
 * A pattern-bound receiver's miss (bd tea-rags-mcp-s3i8m Task 1d) first asks
 * `resolveRustTypedMissMember` — a smart pointer's pointee, a trait's provided
 * method — and otherwise reads exactly as at the untyped baseline unless the
 * miss is proven.
 */
export class RustLocalBindingSymbolResolutionStrategy extends LocalBindingSymbolResolutionStrategy {
  private readonly mode: AmbiguousResolveMode;

  constructor(cfg: ResolverConfig) {
    const lookup = createRustTypeMemberLookup(cfg.mode);
    super("localBinding", RUST_LOCAL_BINDING_TYPING, lookup, { dropOnTypedMiss: rustTypedMissDrops(lookup) });
    this.mode = cfg.mode;
  }

  override attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const outcome = super.attempt(call, ctx);
    const { receiver } = call;
    if (outcome.kind === "resolved" || outcome.kind === "deferred" || !receiver) return outcome;
    const binding = resolveLocalBinding(ctx.localBindings, receiver, call.startLine, call.startColumn);
    if (!isRustPatternIntroduced(binding)) return outcome;
    const type = RUST_LOCAL_BINDING_TYPING.typeOfReceiver({ ...call, receiver }, ctx);
    if (type?.form !== "instance") return outcome;
    const target = resolveRustTypedMissMember(type, call.member, ctx, this.mode);
    return target === null ? outcome : resolved(target);
  }
}

/**
 * A binding a pattern site introduced (bd tea-rags-mcp-s3i8m Task 1a): a
 * projection-folded name, or a typed closure parameter. Both carry the
 * `visibleSpan` of their arm / body; Rust's line-scoped bindings (`let`, fn
 * parameters) never do.
 */
function isRustPatternIntroduced(binding: LocalBinding | undefined): boolean {
  return binding?.valueKind === "patternProjection" || binding?.visibleSpan !== undefined;
}

/**
 * A pattern receiver's miss is proven only when the walk saw every place the
 * member could live (`rustTypedMissIsProven`) AND an unplaced type is provably
 * foreign — a primitive, std, or bound by an external `use`. An unplaced
 * project spelling (a `type FontRef = Arc<Font>` alias the fold cannot follow,
 * a crate-local `type Result<T>`) proves nothing.
 */
function rustPatternMissIsProven(type: NominalTypeRef, member: string, ctx: CallContext): boolean {
  if (!type.name.includes(".rs::") && !rustStdPrimitiveTypes.has(type.name)) {
    const argumentNames = type.args?.map((arg) => (arg.form === "instance" ? arg.name : null));
    if (!rustDeclaredTypeIsForeign(type.name, argumentNames, ctx)) return false;
  }
  return rustTypedMissIsProven(type, member, ctx);
}

/**
 * Whether a typed miss DROPS (bd tea-rags-mcp-2g2og.24). A receiver typed from
 * the call-result channel or a pattern site CONTINUES instead when its member
 * may live where the lookup does not reach: a project trait declares it (a
 * default method the type does not override), or the type has a `deref`. A
 * pattern-introduced binding drops only on top of a PROVEN miss
 * (`rustPatternMissIsProven`, s3i8m Task 1d): its typing is additive over the
 * untyped baseline. Every other typed miss still drops.
 */
function rustTypedMissDrops(
  lookup: TypeMemberLookup,
): (type: NominalTypeRef, call: ReceiverCallRef, ctx: CallContext) => boolean {
  const mayLiveElsewhere = (type: NominalTypeRef, call: ReceiverCallRef, ctx: CallContext): boolean =>
    rustProjectTraitDeclares(call.member, ctx) || lookup.findMember(type, "deref", ctx) !== null;
  return (type, call, ctx) => {
    const binding = resolveLocalBinding(ctx.localBindings, call.receiver, call.startLine, call.startColumn);
    if (isRustPatternIntroduced(binding)) {
      return rustPatternMissIsProven(type, call.member, ctx) && !mayLiveElsewhere(type, call, ctx);
    }
    if (binding !== undefined) return true;
    if (rustCallResultBindingOf(call.receiver, call.startLine, ctx) === undefined) return true;
    return !mayLiveElsewhere(type, call, ctx);
  };
}

function rustProjectTraitDeclares(member: string, ctx: CallContext): boolean {
  return lookupRustSymbolsByShortName(ctx, member).some((definition) => {
    const ownerId = definition.symbolId.slice(0, -(member.length + 1));
    return (
      ownerId.length > 0 &&
      ctx.symbolTable
        .lookup(ownerId)
        .some((owner) => owner.relPath === definition.relPath && owner.symbolKind === "interface")
    );
  });
}
