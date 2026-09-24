import { identifierEntry } from "../../../../contracts/identifier-record.js";
import type { CallContext } from "../../../../contracts/types/codegraph.js";
import type { AncestorLinearizationPolicy } from "../../kernel/ancestor-walk.js";
import { swiftSdkVocabulary, type SwiftSdkType } from "../vocabulary/sdk-vocabulary.js";
import { swiftConformances, swiftDeclaringFiles, swiftSugarAliases } from "./swift-type-declarations.js";

/**
 * Swift's answer to the kernel's linearization question, and it is the SHORTEST
 * of the three because the language gives away more than Ruby or Python do.
 *
 * An inheritance clause mixes a superclass with protocols and marks neither —
 * `class Session: URLSessionDelegate` and `class Session: Base` parse
 * identically — but Swift REQUIRES the superclass to come first when there is
 * one. So the single base `classExtends` already records is the whole of what
 * `super` can mean, and there is no merge to perform: the order is the class,
 * then its base's order, and nothing interleaves.
 *
 * That is why this policy exists rather than a `classAncestors` channel copied
 * from Python. C3 merges multiple bases because Python HAS multiple bases;
 * Swift has one, and spending a run-global multi-base channel on it would buy
 * protocol entries that `super` must never dispatch to — a protocol's default
 * implementation lives in an extension and is reached by ordinary dispatch, not
 * by `super`.
 *
 * A class KEY here is the type's short name. In Python that would be unsound —
 * two files may each declare a `Base` — but Swift forbids two types of one name
 * in a module, so the short name already identifies the type. Cross-MODULE
 * namesakes remain possible and are the known limit of this key; a project
 * indexed as one tree has no way to tell them apart either way.
 *
 * No `boundaryOf`. The closure flavour exists so a consumer can tell "the
 * hierarchy left the project" from "the hierarchy ended", and Swift's one
 * consumer — `super` — DROPs on a miss either way: a class rooted in `NSObject`
 * or `UIViewController` simply stops at the last project class, and reporting
 * that as `external` would change no decision.
 */
export const SWIFT_ANCESTOR_POLICY: AncestorLinearizationPolicy<CallContext> = {
  order(classKey, ctx, recurse) {
    const base = identifierEntry(ctx.classExtends, classKey);
    // A self-referential record cannot come from compilable Swift, but it can
    // come from an index built over a half-rewritten tree. The kernel's
    // per-path guard already stops a longer cycle; this stops the tightest one
    // before it allocates.
    if (base === undefined || base === classKey) return [classKey];
    return [classKey, ...recurse(base)];
  },
};

/**
 * The order an ORDINARY member lookup walks — `SWIFT_ANCESTOR_POLICY`'s
 * superclass chain, then every protocol the type conforms to, each followed by
 * the protocols it refines (bd tea-rags-mcp-y99pg.4).
 *
 * A protocol requirement, and the default a protocol extension provides, are
 * reachable from every conforming type; `super` reaches neither, which is why
 * this is a second policy and not a widening of the first. Swift declares
 * conformances in extensions as often as on the type — `extension SecTrust:
 * AlamofireExtended {}` is the whole reason `trust.af` exists — so they are
 * read from the run-global `typeDeclarations` channel, which lists them for
 * every declaration of a type, re-openings included.
 *
 * Classes come first: a class's own members and its superclass chain are
 * found before any protocol default, which is how Swift itself prefers a
 * concrete implementation over an extension's. An SDK type's superclass and
 * conformances come from the generated SDK substrate (bd tea-rags-mcp-y99pg.19,
 * .24): the index holds no declaration of `Array` or `OutputStream`, so
 * nothing else says an `[T]` reaches `extension Collection` or an
 * `OutputStream` reaches `extension Stream`.
 */
export const SWIFT_MEMBER_LOOKUP_POLICY: AncestorLinearizationPolicy<CallContext> = {
  order(classKey, ctx, recurse, insertable) {
    const sdk = sdkSupertypes(classKey, ctx);
    const base = identifierEntry(ctx.classExtends, classKey) ?? sdk?.superclass;
    const order = base === undefined || base === classKey ? [classKey] : [classKey, ...recurse(base)];
    // `extension [HTTPHeader]` re-opens Array under its sugar spelling, and
    // its members compose under that spelling (bd tea-rags-mcp-y99pg.14).
    for (const alias of swiftSugarAliases(classKey, ctx)) if (!order.includes(alias)) order.push(alias);
    for (const protocol of [...swiftConformances(classKey, ctx), ...(sdk?.conformances ?? [])]) {
      if (protocol === classKey) continue;
      order.push(...insertable(protocol, [order]));
    }
    return order;
  },
};

/**
 * The SDK's superclass and conformances of `classKey`, from the generated
 * substrate (bd tea-rags-mcp-y99pg.24) — none for a type the project declares
 * itself, whose own clause is the whole truth.
 */
function sdkSupertypes(classKey: string, ctx: CallContext): SwiftSdkType | undefined {
  const declared = swiftDeclaringFiles(classKey, ctx);
  if (declared !== undefined && declared.size > 0) return undefined;
  return swiftSdkVocabulary().type(classKey);
}
