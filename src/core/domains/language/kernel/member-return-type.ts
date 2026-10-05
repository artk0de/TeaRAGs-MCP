/**
 * K6 member return type (bd tea-rags-mcp-m99j1.1.12): what calling `member` on
 * a receiver of a known nominal type yields, as one precedence every dynamic
 * language walks.
 *
 *   1. the return declared on the owner itself;
 *   2. the return declared on each ancestor, in the language's linearized order
 *      (the owner excluded) — the NEAREST declaring ancestor answers;
 *   3. a framework hook, when the language has one;
 *   4. the flat owner-less fact, when the language has one. The port gates it:
 *      a by-name fact describes the receiver's method only when the corpus
 *      cannot disagree about which method that is.
 *
 * First non-null wins and the walk stops there. A miss is `null`, never a
 * guess — the caller owns what a miss means.
 *
 * The ancestor read is its own port, not the owner read applied to an
 * ancestor, because the languages read an ancestor differently from the owner
 * and both readings need the OWNER: Python substitutes `-> Self` with the
 * receiver's class, and Ruby keeps its owner-only Rails association accessors
 * off the inherited coordinates.
 *
 * Non-nominal receivers (union, container, tuple, nil) never reach here: how a
 * language folds over arms or unwraps elements is its own rule and runs before
 * the kernel call.
 */
import type { CallContext } from "../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../contracts/types/language.js";
import type { NominalTypeRef } from "./type-member-lookup.js";

/** The language-specific reads behind {@link MemberReturnTypeResolver}. */
export interface MemberReturnTypePorts {
  /** The return `member` declares on `owner` itself. */
  declaredReturnType: (owner: NominalTypeRef, member: string, ctx: CallContext) => TypeRef | null;
  /** `owner`'s ancestors in the language's linearized order, `owner` excluded. */
  ancestorsOf: (owner: NominalTypeRef, ctx: CallContext) => readonly string[];
  /** The return `member` declares on one `ancestor`, read for a call on `owner`. */
  ancestorReturnType: (ancestor: string, owner: NominalTypeRef, member: string, ctx: CallContext) => TypeRef | null;
  /** A framework's synthesized member return, consulted after every declaration. */
  frameworkReturnType?: (owner: NominalTypeRef, member: string, ctx: CallContext) => TypeRef | null;
  /** The owner-less by-name fact, consulted last; the port gates it. */
  flatReturnType?: (member: string, ctx: CallContext) => TypeRef | null;
}

/** See the module docblock for the precedence. */
export class MemberReturnTypeResolver {
  constructor(private readonly ports: MemberReturnTypePorts) {}

  returnTypeOf(owner: NominalTypeRef, member: string, ctx: CallContext): TypeRef | null {
    const declared = this.ports.declaredReturnType(owner, member, ctx);
    if (declared !== null) return declared;
    for (const ancestor of this.ports.ancestorsOf(owner, ctx)) {
      const inherited = this.ports.ancestorReturnType(ancestor, owner, member, ctx);
      if (inherited !== null) return inherited;
    }
    const framework = this.ports.frameworkReturnType?.(owner, member, ctx) ?? null;
    if (framework !== null) return framework;
    return this.ports.flatReturnType?.(member, ctx) ?? null;
  }
}
