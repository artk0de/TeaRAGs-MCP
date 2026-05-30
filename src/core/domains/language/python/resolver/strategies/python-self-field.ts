import {
  pickSingleCandidate,
  type CallContext,
  type CallRef,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import type { ResolverConfig } from "./shared.js";

/**
 * Cross-method instance-field dispatch — `self.<field>.<method>()` where
 * `<field>` was bound to a class in `__init__` (recorded by the walker in
 * `classFieldTypes` keyed by the enclosing class). Look up the field's type,
 * then resolve `<Type>#<member>` / `<Type>.<member>` against the symbol table.
 * Mirrors the TS resolver's `this.field.method()` path; Python binds fields via
 * `self`. Only one access level is supported (`self.foo.bar()`); chained
 * `self.foo.bar.baz()` needs recursive type inference and is out of scope —
 * those continue to later passes (bd tea-rags-mcp-rjuc).
 *
 * **Guard:** when the receiver is `self.<field>` (single segment) inside a
 * class but the field's type was NOT recorded, the call DROPS rather than
 * falling through to the import-match / global short-name paths — a
 * `self.<field>` receiver is an instance-field access, never a module/import
 * name, so falling through would attribute the call to any unrelated class that
 * happens to define `<member>` (the precise false positive this feature
 * prevents).
 */
export class PythonSelfFieldSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "selfField";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver || !call.receiver.startsWith("self.") || ctx.callerScope.length === 0) return CONTINUE;
    const fieldSegment = call.receiver.slice("self.".length);
    if (fieldSegment.includes(".")) return CONTINUE;

    const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
    const typeName = ctx.classFieldTypes?.[enclosing]?.[fieldSegment];
    if (typeName) {
      // Field type known → resolution is CONSTRAINED to that class.
      // Instance form first (the common dispatch shape), static fallback.
      // When neither matches the type is EXTERNAL (stdlib / third-party —
      // e.g. `self._context_stack = ExitStack()` from `contextlib`), so emit
      // a type-qualified best-effort target anchored to the bare type name
      // rather than dropping. This records the dependency without fabricating
      // a wrong `.py` file and never falls through to the ambiguous short-name
      // path — the type is KNOWN from a constructor assignment, so we attach
      // it to that type (instance `#` form: the call is on a value), never to
      // an unrelated class that happens to define `<member>`. Mirrors the Java
      // resolver's CharSequence#charAt external path.
      const instanceHit = pickSingleCandidate(ctx.symbolTable.lookup(`${typeName}#${call.member}`), this.cfg.mode);
      if (instanceHit) return resolved({ targetRelPath: instanceHit.relPath, targetSymbolId: instanceHit.symbolId });
      const staticHit = pickSingleCandidate(ctx.symbolTable.lookup(`${typeName}.${call.member}`), this.cfg.mode);
      if (staticHit) return resolved({ targetRelPath: staticHit.relPath, targetSymbolId: staticHit.symbolId });
      return resolved({ targetRelPath: typeName, targetSymbolId: `${typeName}#${call.member}` });
    }
    // Field type NOT recorded. A `self.<field>` receiver is an instance-field
    // access, never a module/import name, so DROP rather than fall through to
    // the import-match / global short-name paths — falling through would
    // attribute the call to any unrelated class that happens to define
    // `<member>` (the precise false positive this feature prevents).
    return DROP;
  }
}
