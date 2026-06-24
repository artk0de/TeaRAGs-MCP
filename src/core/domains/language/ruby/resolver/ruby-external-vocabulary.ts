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

  isQualifiedReceiverExternal(receiver: string, ctx: CallContext): boolean {
    // Index-access receiver (`opts[k]`): element type untrackable → external.
    // Paired with the dynamic-dispatch suppression (mktkk increment A) so the
    // suppressed call leaves the inProjectEdgeRecall denominator as
    // callsExternalSkipped instead of becoming a recall hole.
    if (receiverIsIndexAccess(receiver)) return true;
    if (receiverChainTailIsExternal(receiver)) return true; // provably-external chain tail (B-suppress)
    if (receiver === SUPER_RECEIVER_SENTINEL) return superTargetsExternal(ctx);
    if (IVAR_RECEIVER.test(receiver)) return ivarTargetsExternal(receiver, ctx);
    return /^[A-Z]/.test(receiver) && resolveConstant(receiver, ctx) === null;
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
