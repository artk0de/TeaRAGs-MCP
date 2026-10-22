import { CONTINUE, DROP } from "../../../../../contracts/resolution.js";
import {
  nearestCallResultBinding,
  resolveLocalBinding,
  type CallContext,
  type CallRef,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome } from "../../../../../contracts/types/language.js";
import {
  LocalBindingSymbolResolutionStrategy,
  type NominalTypeRef,
  type ReceiverCallRef,
  type ReceiverTypingPorts,
  type TypeMemberLookup,
} from "../../../kernel/index.js";
import { rustCallResultBindingOf, rustDeclaredCallResultType } from "../declared-call-result-type.js";
import { rustPatternBindingType } from "../pattern-binding-type.js";
import { createRustTypeMemberLookup } from "../rust-type-member-lookup.js";
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
 * whose miss the member lookup cannot rule out (`rustCallResultMissDrops`).
 */
export class RustLocalBindingSymbolResolutionStrategy extends LocalBindingSymbolResolutionStrategy {
  constructor(cfg: ResolverConfig) {
    const lookup = createRustTypeMemberLookup(cfg.mode);
    super("localBinding", RUST_LOCAL_BINDING_TYPING, lookup, { dropOnTypedMiss: rustCallResultMissDrops(lookup) });
  }

  /**
   * A receiver a pattern binding shadows, whose type the fold cannot prove,
   * DROPs (bd tea-rags-mcp-s3i8m, Task 1a): the name denotes a value we know
   * nothing about, so no later name-only pass (import match, global short
   * name) may guess a namesake for it — `Cow::Owned(ref path) => path.clone()`
   * must not land on a project `Error#clone`.
   */
  override attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const outcome = super.attempt(call, ctx);
    if (outcome !== CONTINUE || call.receiver === null) return outcome;
    const binding = resolveLocalBinding(ctx.localBindings, call.receiver, call.startLine, call.startColumn);
    if (binding?.valueKind !== "patternProjection") return outcome;
    return rustPatternBindingType(binding, ctx, rustExpressionType) === undefined ? DROP : outcome;
  }
}

/**
 * Whether a typed miss DROPS (bd tea-rags-mcp-2g2og.24). A receiver typed from
 * the call-result channel CONTINUES instead when its member may live where the
 * lookup does not reach: a project trait declares it (a default method the
 * type does not override), or the type has a `deref`. Every other typed miss
 * still drops.
 */
function rustCallResultMissDrops(
  lookup: TypeMemberLookup,
): (type: NominalTypeRef, call: ReceiverCallRef, ctx: CallContext) => boolean {
  return (type, call, ctx) => {
    if (resolveLocalBinding(ctx.localBindings, call.receiver, call.startLine, call.startColumn) !== undefined) {
      return true;
    }
    if (rustCallResultBindingOf(call.receiver, call.startLine, ctx) === undefined) return true;
    return !rustProjectTraitDeclares(call.member, ctx) && lookup.findMember(type, "deref", ctx) === null;
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
