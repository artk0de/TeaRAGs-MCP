import type { CallContext } from "../../../../contracts/types/codegraph.js";
import type { ExternalVocabulary } from "../../../../contracts/types/language.js";
import { isExternalBareCall, isExternalQualifiedMember } from "../dsl/index.js";
import { SUPER_RECEIVER_SENTINEL } from "../walker/walker.js";
import {
  collectAncestorChain,
  receiverChainTailIsExternal,
  receiverIsIndexAccess,
  resolveConstant,
} from "./strategies/index.js";
import { typeOfReceiver } from "./type-propagation.js";

/**
 * Ruby implementation of `ExternalVocabulary`, bridging the `dsl/` framework
 * registry (bare-call names) with the resolver's `resolveConstant` (qualified
 * receivers). A no-receiver member is external iff it is a registered framework
 * macro / runtime / kernel name (`isExternalBareCall`). A constant receiver
 * (`Net::HTTP`, `Base64`) is external iff `resolveConstant` cannot map it to a
 * project / Zeitwerk file — a gem or stdlib constant. A lowercase receiver
 * (local var / `self`) cannot be told apart from a project method, so it stays
 * non-external (conservative). A project method shadowing a framework name
 * resolves first via the chain and never reaches this hook (tea-rags-mcp-5os8y).
 */
export class RubyExternalVocabulary implements ExternalVocabulary {
  isBareCallExternal(member: string): boolean {
    return isExternalBareCall(member);
  }

  isQualifiedMemberExternal(member: string): boolean {
    return isExternalQualifiedMember(member);
  }

  isQualifiedReceiverExternal(receiver: string, ctx: CallContext, atLine?: number): boolean {
    // Index-access receiver (`opts[k]`): element type untrackable → external.
    // Paired with the dynamic-dispatch suppression (mktkk increment A) so the
    // suppressed call leaves the inProjectEdgeRecall denominator as
    // callsExternalSkipped instead of becoming a recall hole.
    if (receiverIsIndexAccess(receiver)) return true;
    if (receiverChainTailIsExternal(receiver)) return true; // provably-external chain tail (B-suppress)
    if (receiver === SUPER_RECEIVER_SENTINEL) return superTargetsExternal(ctx);
    if (IVAR_RECEIVER.test(receiver)) return ivarTargetsExternal(receiver, ctx);
    if (/^[A-Z]/.test(receiver)) return resolveConstant(receiver, ctx) === null;
    // Lowercase receiver: check if it's a locally-typed core/gem variable (dnd9s).
    // Only when atLine is provided (threaded from CallRef.startLine by ExternalCallClassifier).
    if (atLine !== undefined) return localBindingTypedReceiverIsExternal(receiver, atLine, ctx);
    return false;
  }
}

/** A single instance-variable receiver (`@client`); a chained `@a.b` is out of scope. */
const IVAR_RECEIVER = /^@\w+$/;

/**
 * An `@ivar` receiver whose walker-inferred type (`classFieldTypes`) resolves to
 * NO project file is a gem / stdlib instance (`@http = Net::HTTP.new`): the ivar
 * strategy DROPs it, so it reaches this classifier unresolved and is honestly
 * external — excluded from the resolveSuccessRate denominator, not an internal
 * miss (cai0 imass). An in-project type → false (the strategy resolved it). An
 * unrecorded ivar → false (genuinely attempted-unresolved; we don't know it's a
 * gem, so we never over-shrink the denominator).
 */
function ivarTargetsExternal(receiver: string, ctx: CallContext): boolean {
  if (ctx.callerScope.length === 0) return false;
  const typeName = ctx.classFieldTypes?.[ctx.callerScope.join("::")]?.[receiver];
  return typeName !== undefined && resolveConstant(typeName, ctx) === null;
}

/**
 * A `super` call (receiver `<super>`) whose enclosing class's FULL ancestor chain
 * resolves to ZERO in-project files targets a gem / runtime ancestor method
 * (`class Agent < ActiveRecord::Base` → `super` is `ActiveRecord::Base#…`, bd
 * cai0). The super pass correctly DROPs it (no in-project file to pin), so it
 * reaches this hook unresolved; it is honestly EXTERNAL, not an internal resolver
 * miss, and must be excluded from the resolveSuccessRate denominator like any gem
 * call. Conservative: a class with no declared ancestor chain is NOT flagged —
 * `every` over an empty chain would be vacuously true, so guard `length > 0`. A
 * super with even ONE in-project ancestor resolves (file-only) and never reaches
 * here.
 */
function superTargetsExternal(ctx: CallContext): boolean {
  if (ctx.callerScope.length === 0) return false;
  const enclosingClass = ctx.callerScope.join("::");
  const chain = collectAncestorChain(enclosingClass, ctx);
  return chain.length > 0 && chain.every((ancestor) => resolveConstant(ancestor, ctx) === null);
}

/**
 * A LOWERCASE receiver (local variable / method parameter) is external when its
 * static type is KNOWN via the type-propagation engine AND that type does NOT
 * resolve to any in-project file (Ruby core `Hash`/`String`/`Integer` or a gem
 * type like `Sawyer::Resource`). This gate fires ONLY when the resolver already
 * DROPs the call (strategies exhausted with no edge); it re-classifies the drop
 * from "in-project miss" to "external skip" so `inProjectEdgeRecall` is honest.
 *
 * PRECISION gate — over-classification is the real risk:
 * - Unknown receiver (`typeOfReceiver → undefined`) → FALSE: we don't know it's
 *   external, so we don't shrink the miss denominator.
 * - Known type resolveConstant → non-null → FALSE: in-project class; a drop
 *   there IS a real miss and must remain in the denominator.
 * - Known type resolveConstant → null → TRUE: external class (core/gem); the
 *   drop is a CORRECT external skip. (bd tea-rags-mcp-dnd9s)
 *
 * Union form: a union with ALL members resolveConstant→null is external (all
 * branches are external). A single in-project member → false (drop is real miss).
 * Container: the container itself (Array/Hash) is always external; the element
 * type does not affect classification of the container's own methods.
 */
function localBindingTypedReceiverIsExternal(receiver: string, atLine: number, ctx: CallContext): boolean {
  const typeRef = typeOfReceiver(receiver, atLine, ctx);
  if (typeRef === undefined) return false;

  if (typeRef.form === "class" || typeRef.form === "instance") {
    return resolveConstant(typeRef.name, ctx) === null;
  }

  if (typeRef.form === "union") {
    // External only when EVERY member of the union is external.
    // A single in-project member means there is a possible in-project target.
    return (
      typeRef.members.length > 0 &&
      typeRef.members.every(
        (m) => (m.form === "class" || m.form === "instance") && resolveConstant(m.name, ctx) === null,
      )
    );
  }

  // container form: the container itself (Array, Hash, Relation…) is external — its
  // own structural methods (size, count, each…) are not in-project. Calls that DO
  // reach a typed element are handled by the chain strategy before hitting this
  // classifier, so a container receiver arriving here is genuinely an external drop.
  if (typeRef.form === "container") return true;

  return false;
}
