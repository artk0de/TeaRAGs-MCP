/**
 * What a PROPERTY of a Swift type denotes — the one place the declared type of
 * `<typeName>.<member>` is looked up, for every pass that needs it.
 *
 * One collaborator rather than a helper per pass, because two passes ask the
 * same question and must get the same answer: the chain fold's ports
 * (`./swift-receiver-type-ports.ts`) for every link of a dotted receiver, and
 * `storedPropertyType` for a single-hop one. Were they to read different
 * channels, the chain pass that sits one slot AHEAD of `storedPropertyType`
 * would stop being the strict superset its placement argument rests on.
 *
 * ## The caller's own file first, the run second
 *
 *   1. `ctx.classFieldTypes` — the CALLER's own file. It is the source text the
 *      call sits in rather than anything folded across the run, so reading it
 *      first is what keeps a wider search from ever moving an edge that
 *      resolves today.
 *   2. {@link SwiftTypeFieldIndex} — every other Swift file of the run, unioned
 *      per type name out of `classFieldTypesByClassKey`. Without it a chain
 *      dies at hop 2 on any real corpus (hop 1's type is declared in its own
 *      file, not the caller's), and an implicit-self property an `extension`
 *      declares elsewhere is invisible.
 *
 * ## And then the superclass chain
 *
 * Swift declares stored properties on a base class and uses them from
 * subclasses constantly — `self.eventMonitor` is declared on `Request` and
 * called from `DataRequest`. The walk reuses the driver and the policy `super`
 * already walks (`kernel/ancestor-walk.ts`, {@link SWIFT_ANCESTOR_POLICY})
 * rather than re-deriving the order, so the passes can never disagree about
 * what a class's superclass is. A class with no `classExtends` entry linearizes
 * to itself alone, which is exactly the own-type read this generalises.
 *
 * Built ONCE per resolver and handed to every pass that needs it: the
 * linearizer memo and the field union are per-run state, and a second instance
 * would rebuild both for the same run. The memos are scoped through
 * {@link RunScopedMemo} rather than a bare `WeakMap`, for the reason
 * `swift-super.ts` states — `LanguageFactory.create` caches a resolver for the
 * factory's lifetime, so a memo keyed on context identity alone would serve one
 * run's hierarchy to the next (bd tea-rags-mcp-z99hp).
 */

import type { CallContext } from "../../../../contracts/types/codegraph.js";
import {
  createAncestorLinearizer,
  findMemberInAncestorChain,
  type AncestorLinearizer,
} from "../../kernel/ancestor-walk.js";
import { RunScopedMemo } from "../../kernel/run-scoped-memo.js";
import { SWIFT_ANCESTOR_POLICY } from "./swift-ancestor-policy.js";
import { SwiftTypeFieldIndex } from "./swift-type-field-index.js";

export class SwiftMemberTypeLookup {
  private readonly linearizers = new RunScopedMemo<CallContext, AncestorLinearizer<CallContext>>();
  private readonly fields = new SwiftTypeFieldIndex();

  /** The declared type of the property `member` on `typeName` or a superclass. */
  typeOfProperty(typeName: string, member: string, ctx: CallContext): string | undefined {
    const scan = findMemberInAncestorChain(typeName, this.linearizerFor(ctx), (candidate) =>
      this.propertyTypeOn(candidate, member, ctx),
    );
    return scan.target ?? undefined;
  }

  private propertyTypeOn(typeName: string, member: string, ctx: CallContext): string | null {
    return ctx.classFieldTypes?.[typeName]?.[member] ?? this.fields.fieldsOf(typeName, ctx)?.[member] ?? null;
  }

  private linearizerFor(ctx: CallContext): AncestorLinearizer<CallContext> {
    const hit = this.linearizers.get(ctx.runScope, ctx);
    if (hit !== undefined) return hit;
    const fresh = createAncestorLinearizer(ctx, SWIFT_ANCESTOR_POLICY);
    this.linearizers.set(ctx.runScope, ctx, fresh);
    return fresh;
  }
}
