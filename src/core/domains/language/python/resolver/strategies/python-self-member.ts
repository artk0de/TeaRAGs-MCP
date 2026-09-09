import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import type { PythonAncestorLinearizerCache } from "../python-ancestor-policy.js";
import {
  pythonEnclosingClass,
  resolvePythonInheritedMember,
  walkClassExtendsForMethod,
  type ResolverConfig,
} from "./shared.js";

/**
 * Intra-class `self.<member>()` — resolution is CONSTRAINED to the enclosing
 * class and its IN-PROJECT ancestors. A `self` receiver is an instance call on
 * the enclosing class, never a module / import name.
 *
 * The walk is the full MRO the walker's `classAncestors` channel describes, not
 * the single-base `classExtends` chain it used to be (bd tea-rags-mcp-9fgdi).
 * That chain kept only the FIRST base of a multi-base class and skipped
 * `subscript` bases entirely, so netbox's
 * `ProviderView(GetRelatedModelsMixin, generic.ObjectView)` lost its mixin and
 * polar's `AccountRepository(RepositorySoftDeletionIDMixin[…], …)` recorded no
 * base at all — 672 of netbox's and 866 of polar's missed `selfMember` rows.
 *
 * **Guard, now three-way.** `self` stays terminal (bd tea-rags-mcp-yrs0): a
 * miss must not fall through to the ambiguous global short-name path, which is
 * where a call to an inherited DJANGO method becomes an edge to whatever
 * unrelated project class declares the same short name. What changed is that a
 * miss now carries evidence of how completely the hierarchy could be READ:
 *
 *   - `closed`   — every branch ended on a project class. The member really is
 *                  absent. DROP.
 *   - `external` — a branch left the project. A miss proves nothing, and a
 *                  fabricated target is the phantom family the 540 netbox /
 *                  193 polar `agreeExternal` rows are green because of. DROP.
 *   - `unknown`  — a branch could not be classified at all. The one NEW
 *                  fall-through this pass opens: a hierarchy we could not
 *                  finish reading is not evidence the member is absent.
 */
export class PythonSelfMemberSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "selfMember";

  constructor(
    private readonly cfg: ResolverConfig,
    private readonly linearizers?: PythonAncestorLinearizerCache,
  ) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== "self") return CONTINUE;
    // The enclosing class, addressed the way the run keys classes — NOT the
    // whole of `callerScope`, which carries the enclosing `def` for a call made
    // from a nested one (bd tea-rags-mcp-graiw).
    const enclosing = pythonEnclosingClass(ctx);
    if (enclosing === null) return CONTINUE;
    // An index written by walker v2 carries no `classAncestors` at all. Keep
    // the pre-seam single-base walk for it rather than answering from an empty
    // map, and keep its flat DROP with it.
    const linearizer = this.linearizers?.for(ctx);
    if (linearizer === undefined) {
      const legacy = walkClassExtendsForMethod(enclosing.name, call.member, ctx, this.cfg.mode);
      return legacy ? resolved(legacy) : DROP;
    }
    const { target, closure } = resolvePythonInheritedMember(
      enclosing.key,
      call.member,
      ctx,
      this.cfg.mode,
      linearizer,
    );
    if (target) return resolved(target);
    return closure === "unknown" ? CONTINUE : DROP;
  }
}
