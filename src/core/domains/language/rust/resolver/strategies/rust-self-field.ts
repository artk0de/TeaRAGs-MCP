import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import type { ResolverConfig } from "./shared.js";

/**
 * bd tea-rags-mcp-q1pl — `self.<field>.<method>()` where the struct declares
 * `field: Type`. The walker records the field type in `classFieldTypes` keyed
 * by the struct name (= the impl type name in `callerScope`). Look up the
 * field's type, then resolve `<Type>#<member>` / `<Type>.<member>`. Mirrors
 * the Java/Python resolver's `this.field` / `self.field` branch. Only one
 * access level is supported (`self.foo.bar()`); chained `self.foo.bar.baz()`
 * needs recursive type inference and is out of scope (continue).
 *
 * This is a **guard** pass for the single-access case: a `self.<field>`
 * receiver is an instance-field access, never a module/import name — so when
 * the field type is known-but-member-missing OR the field type is NOT recorded
 * it DROPS rather than falling through to the import-match / global short-name
 * paths that would route to an unrelated type's member.
 */
export class RustSelfFieldSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "selfField";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver || !call.receiver.startsWith("self.") || ctx.callerScope.length === 0) return CONTINUE;
    const fieldSegment = call.receiver.slice("self.".length);
    // Chained access (`self.foo.bar()`) is out of scope — defer to later passes.
    if (fieldSegment.includes(".")) return CONTINUE;

    const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
    const typeName = ctx.classFieldTypes?.[enclosing]?.[fieldSegment];
    if (typeName) {
      const instanceHit = pickSingleCandidate(ctx.symbolTable.lookup(`${typeName}#${call.member}`), this.cfg.mode);
      if (instanceHit) return resolved({ targetRelPath: instanceHit.relPath, targetSymbolId: instanceHit.symbolId });
      const staticHit = pickSingleCandidate(ctx.symbolTable.lookup(`${typeName}.${call.member}`), this.cfg.mode);
      if (staticHit) return resolved({ targetRelPath: staticHit.relPath, targetSymbolId: staticHit.symbolId });
      // Receiver type known but member not on it — DROP, same as the
      // localBinding branch below. Falling through to the global
      // short-name lookup would route to an unrelated type's member.
      return DROP;
    }
    // Field type NOT recorded. A `self.<field>` receiver is an
    // instance-field access, never a module/import name — DROP rather
    // than fall through to the import-match / global short-name paths.
    return DROP;
  }
}
