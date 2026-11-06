import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef, SymbolResolutionTarget } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { DefaultSymbolIdComposer } from "../../../kernel/index.js";

/**
 * Same-class instance message. `[self foo]` and `[self foo:x]` inside an
 * `@implementation` resolve to that class's instance method (`Class#foo`,
 * `Class#foo:`), and only when that method is defined in the caller's file.
 *
 * Precedence: this is the only pass.
 *   1. Receiver text is exactly `self`, and `callerScope` is non-empty. The
 *      enclosing class is the last scope segment — `nameOf` puts the class on
 *      the method's scope and does not put the method's own selector there.
 *      The candidate id is `compose(class, selector, { methodKind: "instance" })`,
 *      which is `Class#selector`. A definition of that id in `callerFile` wins.
 *   2. Any other shape continues. The chain ends, so a miss emits no edge.
 *      There is no global short-name pass: a selector is shared by every class.
 *
 * Not resolved here, on purpose: `[other foo]`, `[[self maker] run]` (the outer
 * send's receiver is not `self`), `[super foo]`, and `[self alloc]` when
 * `alloc` is a `+` method (`Class.alloc`, not `Class#alloc`). A `+` method's
 * `self` is the class object; this pass only looks up instance methods.
 */

const COMPOSER = new DefaultSymbolIdComposer();

export class ObjcSelfInstanceMemberSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "selfInstanceMember";

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== "self" || ctx.callerScope.length === 0) return CONTINUE;
    const hit = lookupSameFileInstanceMethod(call.member, ctx);
    return hit ? resolved(hit) : CONTINUE;
  }
}

function lookupSameFileInstanceMethod(member: string, ctx: CallContext): SymbolResolutionTarget | null {
  const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
  if (enclosing === undefined) return null;
  const fqName = COMPOSER.compose(enclosing, member, { methodKind: "instance" });
  const hit = ctx.symbolTable.lookup(fqName).find((def) => def.relPath === ctx.callerFile);
  if (!hit) return null;
  return { targetRelPath: hit.relPath, targetSymbolId: hit.symbolId };
}
