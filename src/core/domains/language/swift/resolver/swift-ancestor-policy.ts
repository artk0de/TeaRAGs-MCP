import type { CallContext } from "../../../../contracts/types/codegraph.js";
import type { AncestorLinearizationPolicy } from "../../kernel/ancestor-walk.js";

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
    const base = ctx.classExtends?.[classKey];
    // A self-referential record cannot come from compilable Swift, but it can
    // come from an index built over a half-rewritten tree. The kernel's
    // per-path guard already stops a longer cycle; this stops the tightest one
    // before it allocates.
    if (base === undefined || base === classKey) return [classKey];
    return [classKey, ...recurse(base)];
  },
};
