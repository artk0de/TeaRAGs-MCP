import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import type { PythonAncestorLinearizerCache } from "../python-ancestor-policy.js";
import { PythonImportFileMapper } from "../python-import-file-mapper.js";
import {
  pythonEnclosingClass,
  pythonInheritedMemberType,
  pythonTypeNameIsExternal,
  type ResolverConfig,
} from "./shared.js";

/**
 * Cross-method instance-field dispatch — `self.<field>.<method>()` where
 * `<field>` was bound to a class in `__init__` (recorded by the walker in
 * `classFieldTypes` keyed by the class that ASSIGNED it — so the lookup walks
 * the enclosing class's MRO, not just the enclosing class). Look up the field's type,
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
  /**
   * `mapper` is the resolver's shared `PythonImportFileMapper` when the caller
   * has one (bd tea-rags-mcp-9fgdi, E2.6): the external-type verdict below asks
   * the same import question the rest of the chain does and must read the same
   * memo. A caller with no chain to share with omits it and gets a private one.
   */
  constructor(
    private readonly cfg: ResolverConfig,
    private readonly mapper: PythonImportFileMapper = new PythonImportFileMapper(),
    private readonly linearizers?: PythonAncestorLinearizerCache,
  ) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver?.startsWith("self.") !== true) return CONTINUE;
    const fieldSegment = call.receiver.slice("self.".length);
    if (fieldSegment.includes(".")) return CONTINUE;

    // `classFieldTypes` is keyed by the class's OWN short name, so this pass
    // needs the enclosing CLASS — a call made from a nested `def` has that
    // `def` at the end of `callerScope` (bd tea-rags-mcp-graiw).
    const enclosing = pythonEnclosingClass(ctx);
    if (enclosing === null) return CONTINUE;
    // Own class first, then up the C3 MRO (bd tea-rags-mcp-yl85b): polar
    // assigns `self.client` once in `SyncServiceBase.__init__` and calls it
    // from 60-odd subclasses in other files, and `classFieldTypes` is keyed by
    // the ASSIGNING class's short name. A field the walk cannot type is
    // `undefined` here and falls to the DROP below exactly as before.
    const fieldType = pythonInheritedMemberType(
      enclosing.name,
      fieldSegment,
      "instance",
      ctx,
      this.mapper,
      this.linearizers?.for(ctx),
    );
    const typeName = fieldType?.form === "instance" ? fieldType.name : undefined;
    if (typeName) {
      // Field type known → resolution is CONSTRAINED to that class.
      // Instance form first (the common dispatch shape), static fallback.
      const instanceHit = pickSingleCandidate(ctx.symbolTable.lookup(`${typeName}#${call.member}`), this.cfg.mode);
      if (instanceHit) return resolved({ targetRelPath: instanceHit.relPath, targetSymbolId: instanceHit.symbolId });
      const staticHit = pickSingleCandidate(ctx.symbolTable.lookup(`${typeName}.${call.member}`), this.cfg.mode);
      if (staticHit) return resolved({ targetRelPath: staticHit.relPath, targetSymbolId: staticHit.symbolId });
      // Neither form is in the table, so the type is not a project class and
      // there is nothing to point AT. This used to emit
      // `{ targetRelPath: typeName, targetSymbolId: "<Type>#<member>" }` — a
      // best-effort anchor borrowed from the Java resolver's
      // `CharSequence#charAt` path — and the `targetRelPath` half of it is a
      // TYPE NAME where every consumer expects a file: `cg_symbols_edges_file`
      // stores it, nothing joins it, and the source's fanOut inflates against a
      // row that does not exist. 184 such rows across the five Python corpora,
      // none of them a match (bd tea-rags-mcp-lbtmm).
      //
      // So: never synthesize. An EXTERNAL type (a builtin, or a name an import
      // bound from outside the project — `io.BytesIO`, `httpx.Client`,
      // `re.Pattern`) is a verdict, and it DROPS so the external gate can take
      // the call out of the recall denominator instead. A type nothing can
      // classify is not a verdict, and CONTINUEs.
      return pythonTypeNameIsExternal(typeName, ctx, this.mapper) ? DROP : CONTINUE;
    }
    // Field type NOT recorded. A `self.<field>` receiver is an instance-field
    // access, never a module/import name, so DROP rather than fall through to
    // the import-match / global short-name paths — falling through would
    // attribute the call to any unrelated class that happens to define
    // `<member>` (the precise false positive this feature prevents).
    return DROP;
  }
}
