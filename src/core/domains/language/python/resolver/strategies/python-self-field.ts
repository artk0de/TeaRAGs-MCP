import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import type { PythonAncestorLinearizerCache } from "../python-ancestor-policy.js";
import { PythonImportFileMapper } from "../python-import-file-mapper.js";
import {
  pythonEnclosingClass,
  pythonInheritedMemberType,
  pythonTypeNameIsExternal,
  resolvePythonMemberOnTypeThroughMro,
  type ResolverConfig,
} from "./shared.js";

/**
 * Cross-method instance-field dispatch — `self.<field>.<method>()` where
 * `<field>` was bound to a class in `__init__` (recorded by the walker in
 * `classFieldTypes` keyed by the class that ASSIGNED it — so the lookup walks
 * the enclosing class's MRO, not just the enclosing class). Look up the field's
 * type, then resolve the member on THAT class's own MRO (bd
 * tea-rags-mcp-s2w5g) — both halves of `self.<field>.<member>()` are hierarchy
 * questions, and answering only the first left polar's
 * `self.client.build_request()` unresolved 752 times.
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
    const linearizer = this.linearizers?.for(ctx);
    const fieldType = pythonInheritedMemberType(enclosing.name, fieldSegment, "instance", ctx, this.mapper, linearizer);
    const typeName = fieldType?.form === "instance" ? fieldType.name : undefined;
    if (typeName) {
      // Field type known → resolution is CONSTRAINED to that class, and to the
      // classes that class INHERITS from (bd tea-rags-mcp-s2w5g). polar's
      // `self.client.build_request()` types `client` to `SyncClientBase` and
      // `build_request` is declared on `BuildRequestMixin`, a base of it — 752
      // rows the verbatim reads below cannot see, every one of them a row jedi
      // pins on the mixin. The walk is `selfMember`'s and `localBinding`'s, and
      // it answers with the DEFINING class's own spelling.
      const mro =
        linearizer === undefined
          ? undefined
          : resolvePythonMemberOnTypeThroughMro(typeName, call.member, ctx, this.cfg.mode, this.mapper, linearizer);
      if (mro?.target) return resolved(mro.target);
      // The verbatim reads stay BELOW the walk rather than being replaced by
      // it. They answer a shape the walk cannot address at all — a type name
      // the project declares in several files, which `resolveTypeFile` refuses
      // to pick between — and removing that recall is a separate decision with
      // its own measurement.
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
      //
      // A hierarchy that LEFT the project before any definition is the third
      // verdict, and it is `localBinding`'s (bd tea-rags-mcp-s2w5g): the field
      // types to a project class whose base is a library one, so the member is
      // the library's and a miss under it proves nothing. `closed` and
      // `unknown` fall through to the type-name test below unchanged — a
      // hierarchy read to the end without the member is not evidence about the
      // TYPE, which is what that test is about.
      if (mro?.closure === "external") return DROP;
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
