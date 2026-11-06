import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { capability } from "../../capability.js";
import type { ResolverConfig } from "./shared.js";

/**
 * Bare call to a top-level function declared in the same file. The id is the
 * function's own name (`topLevel`), scope empty — a method's id is qualified
 * (`Widget.draw`) and does not match. Another file's function of the same
 * name is not a candidate: this pass does not look across the project.
 *
 * Runs after `enclosingBareCall`, so a member of the enclosing type wins
 * over a file-level namesake. A receiver-present call continues; answering
 * it here would make the runner's synthesised import edge (`receiver` =
 * import basename) land on a same-named function.
 */
export class KotlinSameFileFunctionSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "sameFileFunction";
  constructor(_cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== null) return CONTINUE;
    const kinds = capability.codegraph.symbolKindRoles.callee;
    const hit = ctx.symbolTable
      .lookup(call.member, { kinds })
      .find((def) => def.relPath === ctx.callerFile && def.scope.length === 0 && def.symbolId === call.member);
    return hit ? resolved({ targetRelPath: hit.relPath, targetSymbolId: hit.symbolId }) : CONTINUE;
  }
}
