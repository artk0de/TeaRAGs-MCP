/**
 * Shared inputs and helpers for the Python symbol-resolution strategies.
 *
 * `ResolverConfig` is the per-resolver config every strategy receives by
 * constructor injection (the old `PythonCallResolver(mode)` argument). Python
 * has no tsconfig path mapper, so the config carries only the
 * ambiguous-resolve `mode`.
 *
 * `walkClassExtendsForMethod`, `pythonImportMatchesReceiver`, `lastSegment`,
 * `findPythonImportBinding`, `resolveTypeFile`, `resolvePythonMemberOnType`,
 * the `pythonClassKey` / `parsePythonClassKey` pair and
 * `resolvePythonInheritedMember` are the helpers shared by more than one
 * strategy AND by the local-type walk — factored here so each lives once.
 */

import {
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
  type ImportRef,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import {
  findMemberInAncestorChain,
  type AncestorClosure,
  type AncestorLinearizer,
} from "../../../kernel/ancestor-walk.js";
import { PYTHON_BUILTINS } from "../../vocabulary/builtins.js";
import type { PythonImportFileMapper } from "../python-import-file-mapper.js";
import { mapPythonImportToFile } from "../python-path-mapper.js";

/**
 * The run-global address of a Python class: `<relPath>::<dotted class FQ>` (bd
 * tea-rags-mcp-9fgdi). `classAncestors` is run-global, so a bare class name
 * cannot be the key — two `Base` classes in two files would conflate. `::` and
 * not a dot, because `Outer.Inner` is a legal class FQ and would not split.
 */
export function pythonClassKey(relPath: string, classFq: string): string {
  return `${relPath}::${classFq}`;
}

/** The inverse of {@link pythonClassKey}; `null` for anything not in that shape. */
export function parsePythonClassKey(classKey: string): { readonly relPath: string; readonly classFq: string } | null {
  const at = classKey.indexOf("::");
  if (at <= 0) return null;
  const classFq = classKey.slice(at + 2);
  return classFq.length === 0 ? null : { relPath: classKey.slice(0, at), classFq };
}

/**
 * The dotted FQ a symbol-table definition is addressed by — its scope plus its
 * own short name (bd tea-rags-mcp-graiw). THE spelling rule for a Python class
 * key, stated once: `collectSymbols` pushes every `nameOf`-named container onto
 * `scope`, and `pyNameOf` names a `function_definition` as well as a
 * `class_definition`, so a class declared inside a `def` reads
 * `Authenticator._AuthenticatorSignature` here and nowhere reads
 * `_AuthenticatorSignature`.
 */
export function pythonDeclaredClassFq(def: { readonly scope: readonly string[]; readonly shortName: string }): string {
  return [...def.scope, def.shortName].join(".");
}

/** The class a call site is written inside, addressed the way the run keys classes. */
export interface PythonEnclosingClass {
  /** `<relPath>::<dotted class FQ>` — the {@link pythonClassKey} form the MRO walk starts from. */
  readonly key: string;
  /** The dotted FQ alone — what the symbol table composes members under. */
  readonly classFq: string;
  /** The class's OWN short name — the key of the bare-name channels (`classFieldTypes`, `classExtends`). */
  readonly name: string;
}

/**
 * The innermost class enclosing the call site, or `null` when the caller has no
 * scope at all (bd tea-rags-mcp-graiw).
 *
 * `callerScope` is not a list of class containers, and reading it as one is the
 * defect this replaces. Two measured shapes broke on it, in opposite
 * directions:
 *
 *   - polar `server/polar/auth/dependencies.py:207` — `_AuthenticatorSignature`
 *     is declared inside `def Authenticator()`, so the scope is
 *     `["Authenticator", "_AuthenticatorSignature"]` and the class FQ needs
 *     BOTH segments. A key built from the trailing name alone named nothing.
 *   - flask, 10 sites — a call inside `App#template_filter#decorator` carries
 *     the scope `["App", "template_filter"]`, and the class FQ is the FIRST
 *     segment alone. A key built from the whole join named nothing.
 *
 * So the answer is the LONGEST prefix that names a class, tried outward from
 * the call. Two channels of evidence, either sufficient: the run's
 * `classAncestors` keys (authoritative — the walker only ever writes classes
 * there), and a symbol-table definition at the caller's own file whose
 * {@link pythonDeclaredClassFq} is that prefix. The second is what pins a class
 * that declares no base, and it separates a class from a method because a
 * container joins with the scope separator while an instance method joins with
 * `#`: `Outer.Inner` is in the table, `App.template_filter` is not.
 *
 * When no prefix is confirmed the WHOLE scope is returned rather than `null`,
 * which is byte-identically what every caller used to build. A key nothing
 * declares then reads closure `unknown` in `../python-ancestor-policy.ts`, so
 * the miss falls through instead of claiming the member is absent.
 */
export function pythonEnclosingClass(ctx: CallContext): PythonEnclosingClass | null {
  const scope = ctx.callerScope;
  if (scope.length === 0) return null;
  for (let depth = scope.length; depth > 0; depth--) {
    const classFq = scope.slice(0, depth).join(".");
    const key = pythonClassKey(ctx.callerFile, classFq);
    if (ctx.classAncestors?.[key] !== undefined || pythonClassKeyIsDeclared(key, ctx)) {
      return { key, classFq, name: scope[depth - 1] };
    }
  }
  const classFq = scope.join(".");
  return { key: pythonClassKey(ctx.callerFile, classFq), classFq, name: scope[scope.length - 1] };
}

/**
 * Does anything in the run DECLARE the class this key addresses (bd
 * tea-rags-mcp-graiw)?
 *
 * The distinction the closure rests on: a class with no bases has no
 * `classAncestors` entry and a miss under it really is evidence of absence,
 * while a key nothing declares carries no evidence either way.
 */
export function pythonClassKeyIsDeclared(classKey: string, ctx: CallContext): boolean {
  const parsed = parsePythonClassKey(classKey);
  if (parsed === null) return false;
  return ctx.symbolTable.lookup(parsed.classFq).some((def) => def.relPath === parsed.relPath);
}

/**
 * The MRO key of the class `bareName` names INSIDE `relPath`, or `null` when
 * that file declares no such class — or declares it twice (bd
 * tea-rags-mcp-xasyu).
 *
 * A type name and a file are not yet an address the ancestor walk accepts: the
 * key is DOTTED-FQ-qualified, so a nested `Outer.Inner` has to be spelled from
 * its own definition rather than from the short name the binding carried. This
 * is the same question `resolveBaseKey` asks of a base spelling in
 * `../python-ancestor-policy.ts`, asked here of a receiver's inferred type; it
 * stays in this leaf module because the policy imports from here and not the
 * other way round.
 *
 * `null` is a positive answer, not a residual: the run holds no class under
 * that name in that file, so there is no hierarchy to read and no member to
 * find. A caller that gets it has evidence the bound type is not a class the
 * project declares.
 */
export function pythonBoundClassKey(bareName: string, relPath: string, ctx: CallContext): string | null {
  const declared = ctx.symbolTable.lookupByShortName(bareName).filter((def) => def.relPath === relPath);
  if (declared.length !== 1) return null;
  return pythonClassKey(relPath, pythonDeclaredClassFq(declared[0]));
}

/** A member found on a class or one of its ancestors, and how far the walk could see. */
export interface PythonInheritedMemberResult {
  readonly target: SymbolResolutionTarget | null;
  readonly closure: AncestorClosure;
}

/**
 * `<member>` on `classKey` or the first ancestor in its MRO that owns it (bd
 * tea-rags-mcp-9fgdi). Instance spelling (`Cls#m`) first, class spelling
 * (`Cls.m`) second — `classifyMethod` files an undecorated `def` as instance
 * and a `@classmethod` / `@staticmethod` one as class-level, and the corpora
 * carry both (`GetRelatedModelsMixin#get_related_models`,
 * `RepositoryBase.from_session`).
 *
 * Every lookup is FILTERED BY THE CANDIDATE'S OWN FILE. The class key is
 * file-qualified precisely so two `Base` classes in two files stay apart, and
 * an unfiltered `symbolTable.lookup("Base#m")` would put them back together.
 *
 * `closure` is the caller's evidence for what to do with a miss — a hierarchy
 * read to the end that does not own the member is evidence of ABSENCE, one that
 * left the project or could not be bound is not. This function never decides;
 * see each strategy's verdict table.
 */
export function resolvePythonInheritedMember(
  classKey: string,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
  linearizer: AncestorLinearizer<CallContext>,
  options: { readonly startAfter?: boolean } = {},
): PythonInheritedMemberResult {
  const scan = findMemberInAncestorChain(
    classKey,
    linearizer,
    (candidateKey) => {
      const parsed = parsePythonClassKey(candidateKey);
      if (parsed === null) return null;
      for (const spelling of [`${parsed.classFq}#${member}`, `${parsed.classFq}.${member}`]) {
        const inFile = ctx.symbolTable.lookup(spelling).filter((def) => def.relPath === parsed.relPath);
        const picked = pickSingleCandidate(inFile, mode);
        if (picked) return { targetRelPath: picked.relPath, targetSymbolId: picked.symbolId };
      }
      return null;
    },
    options,
  );
  return { target: scan.target, closure: scan.closure };
}

export interface ResolverConfig {
  mode: AmbiguousResolveMode;
  /**
   * Max cone size before CHA devirtualization collapses to a single
   * `poly-base` edge (bd tea-rags-mcp-f10y). `|cone| ≤ coneMax` persists N
   * `cone` edges (confidence `1/N`); `> coneMax` persists one base-decl edge
   * expanded at query time. Defaults to `CONE_MAX_DEFAULT` (8) when omitted;
   * env `CODEGRAPH_PY_CONE_MAX` overrides at composition.
   */
  coneMax?: number;
}

/** Default cone-size threshold; env `CODEGRAPH_PY_CONE_MAX` overrides at composition. */
export const CONE_MAX_DEFAULT = 8;

/**
 * Resolve `<member>` against `startClass` and, on a miss, its IN-PROJECT
 * base-class chain (`classExtends`). bd tea-rags-mcp-yrs0.
 *
 * Walk order: the class itself first (so a method defined on the direct
 * class always wins over an inherited one), then each ancestor reached
 * via single-inheritance `classExtends`, left-to-right MRO-ish. Instance
 * form (`Class#member`) is preferred at each level, static form
 * (`Class.member`) is the fallback.
 *
 * Safety:
 *   - CYCLE GUARD: a `visited` set breaks `A extends B extends A` and
 *     self-references — the walk always terminates.
 *   - IN-PROJECT ONLY: an ancestor whose definition is not in the symbol
 *     table (external base — Django CBVs, werkzeug) yields no lookup hit
 *     and the branch simply continues to its parent (which is usually
 *     undefined for an external base, ending the walk). No edge is
 *     fabricated for an external method.
 *   - DROP on miss: when no class in the chain defines `member`, returns
 *     `null` so the caller does NOT fall through to ambiguous global
 *     short-name resolution.
 */
export function walkClassExtendsForMethod(
  startClass: string,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
): SymbolResolutionTarget | null {
  const visited = new Set<string>();
  let current: string | undefined = startClass;
  while (current && !visited.has(current)) {
    visited.add(current);
    const instanceHit = pickSingleCandidate(ctx.symbolTable.lookup(`${current}#${member}`), mode);
    if (instanceHit) return { targetRelPath: instanceHit.relPath, targetSymbolId: instanceHit.symbolId };
    const staticHit = pickSingleCandidate(ctx.symbolTable.lookup(`${current}.${member}`), mode);
    if (staticHit) return { targetRelPath: staticHit.relPath, targetSymbolId: staticHit.symbolId };
    current = ctx.classExtends?.[current];
  }
  return null;
}

export function lastSegment(qualified: string): string {
  const parts = qualified.split(".");
  return parts[parts.length - 1] ?? qualified;
}

/**
 * Does this TYPE NAME belong to something outside the project (bd
 * tea-rags-mcp-lbtmm)?
 *
 * Two arms, both positive verdicts rather than residuals:
 *   - a BUILTIN (`dict`, `str`, `list`) — bound by the interpreter, so no
 *     project file can declare it;
 *   - a name an import BOUND from a module the {@link PythonImportFileMapper}
 *     calls `external`. The ROOT segment is what the statement binds, so
 *     `io.BytesIO` is decided by `io` and `Pattern` by itself.
 *
 * Same shape — deliberately — as `PythonExternalVocabulary.isBareCallExternal`:
 * the vocabulary and the chain must answer one import question the same way, or
 * a call the chain drops lands back in the recall denominator.
 *
 * `false` means UNKNOWN, never "in project": nothing here proves a type is
 * ours, and the callers act on the two verdicts differently.
 */
export function pythonTypeNameIsExternal(typeName: string, ctx: CallContext, mapper: PythonImportFileMapper): boolean {
  const root = typeName.split(".")[0];
  if (root.length === 0) return false;
  if (PYTHON_BUILTINS.has(root)) return true;
  for (const imp of ctx.imports) {
    const bound = imp.importedBindings?.[root] ?? (imp.importedNames?.includes(root) ? root : undefined);
    if (bound === undefined) continue;
    if (mapper.mapImportToFile(imp.importText, ctx.callerFile, ctx).kind === "external") return true;
  }
  return false;
}

/**
 * Can `bareType` OWN a member — is it class-kind (bd tea-rags-mcp-lbtmm)?
 *
 * A Python `class Foo` and a top-level `def foo` are INDISTINGUISHABLE in the
 * symbol table: both compose a bare `symbolId` with an empty scope, and
 * `SymbolDefinition` carries no kind. So the question is answered by
 * corroboration instead, and any ONE channel is enough:
 *
 *   - the walker recorded a BASE class for it (`classExtends`) — the shape
 *     behind every legitimate file-only edge, since a member the class itself
 *     does not declare has to be inherited from somewhere;
 *   - the walker recorded typed FIELDS on it (`classFieldTypes`);
 *   - the table holds `<Type>#<member>` / `<Type>.<member>` — it owns the very
 *     member under resolution.
 *
 * No member to probe (the cone locator asks about a type, not a call) leaves
 * the first two channels, so the answer degrades toward "yes" rather than
 * silently narrowing a caller that never asked for the guard.
 *
 * The measured miss this refuses: polar declares `def datetime(value)` in
 * `server/polar/backoffice/formatters.py`, and it was the sole short-name match
 * for every `x: datetime` receiver in the repo.
 */
export function pythonTypeOwnsMembers(bareType: string, member: string | undefined, ctx: CallContext): boolean {
  if (ctx.classExtends?.[bareType] !== undefined) return true;
  if (ctx.classFieldTypes?.[bareType] !== undefined) return true;
  if (member === undefined) return true;
  return (
    ctx.symbolTable.lookup(`${bareType}#${member}`).length > 0 ||
    ctx.symbolTable.lookup(`${bareType}.${member}`).length > 0
  );
}

export function pythonImportMatchesReceiver(importText: string, receiver: string): boolean {
  // Strip leading dots (relative-import marker) for the comparison —
  // `..foo.bar` should still match `bar` as a receiver. Compare
  // case-sensitively: Python is case-sensitive (User != user).
  const cleaned = importText.replace(/^\.+/, "");
  const segments = cleaned.split(".").filter((s) => s.length > 0);
  const last = segments[segments.length - 1] ?? "";
  return last === receiver;
}

/** One import statement, the local name it bound, and the name the module exports. */
export interface PythonImportBinding {
  imp: ImportRef;
  localName: string;
  importedName: string;
}

/**
 * The import that bound `localName`, with the name the MODULE exports it under.
 *
 * `importedBindings` is the authority (it survives aliasing);
 * `importedNames` alone means the statement bound the name unaliased, which is
 * the shape `from a import b` produces when a walker-1 file is mixed in.
 */
export function findPythonImportBinding(imports: readonly ImportRef[], localName: string): PythonImportBinding | null {
  for (const imp of imports) {
    const importedName = imp.importedBindings?.[localName];
    if (importedName) return { imp, localName, importedName };
  }
  for (const imp of imports) {
    if (imp.importedBindings) continue; // already consulted above; do not re-answer
    if (imp.importedNames?.includes(localName)) return { imp, localName, importedName: localName };
  }
  return null;
}

/**
 * Find the file path of a bare class name by walking the import list.
 * Two shapes match:
 *   - `from <module> import <Bare>` — importText is `<module>`; the
 *     class name appears in the symbol table at the file `<module>`
 *     resolves to.
 *   - `import <module>` where `<module>` ends in the bare type name.
 *
 * Returns the file path of the class definition when an import
 * resolves there, or `null` otherwise.
 *
 * Both import-consulting passes go through `PythonImportFileMapper` (bd
 * tea-rags-mcp-9fgdi): membership in the symbol table, never a path synthesised
 * from the module text. An `external` verdict contributes NOTHING — attributing
 * a type to `rest_framework/serializers.py` is the phantom this seam removes.
 * An `unknown` verdict keeps the pre-seam fallback, per decision 1 of
 * `docs/superpowers/plans/2026-09-08-python-import-file-mapper.md`: three
 * states exist precisely so "I cannot tell" and "I know it is a library" behave
 * differently.
 *
 * `member` is the member being resolved ON the type, and it is what lets the
 * short-name pass tell a class from a same-named `def` (bd tea-rags-mcp-lbtmm)
 * — see {@link pythonTypeOwnsMembers}. Optional: the cone locator asks about a
 * TYPE with no call in hand, and omitting it leaves that caller's answers
 * exactly as they were.
 */
export function resolveTypeFile(
  bareType: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
  member?: string,
): string | null {
  // An import-bound name the mapper calls EXTERNAL is a library class, and no
  // project file declares it. Deciding that FIRST is what stops the short-name
  // pass below from answering with a namesake: `from datetime import datetime`
  // in 53 polar files, against polar's own `def datetime(value)` in
  // `server/polar/backoffice/formatters.py` (bd tea-rags-mcp-lbtmm).
  if (pythonTypeNameIsExternal(bareType, ctx, mapper)) return null;

  // First pass: scan symbol table for ANY definition matching the
  // bare type name. If it's unique we have the file directly — provided the
  // match can OWN a member at all, which a top-level `def` cannot.
  const tableMatches = ctx.symbolTable.lookupByShortName(bareType);
  if (tableMatches.length === 1) {
    return pythonTypeOwnsMembers(bareType, member, ctx) ? tableMatches[0].relPath : null;
  }

  // Second pass: try to disambiguate via imports — the class file
  // must be one of the files reachable from the caller's imports. Only a
  // `project` verdict names a file the table can hold, so it is the only one
  // that can narrow the candidates.
  if (tableMatches.length > 1) {
    const importedFiles = new Set<string>();
    for (const imp of ctx.imports) {
      const mapped = mapper.mapImportToFile(imp.importText, ctx.callerFile, ctx);
      if (mapped.kind === "project") importedFiles.add(mapped.relPath);
    }
    const filtered = tableMatches.filter((def) => importedFiles.has(def.relPath));
    if (filtered.length === 1) return filtered[0].relPath;
    // Still ambiguous — refuse to guess.
    return null;
  }

  // Third pass: bare type not in symbol table (defined outside the
  // project — e.g. DRF Serializer). Walk imports: if any import path
  // ends in the type name and maps to a file, attribute to that.
  for (const imp of ctx.imports) {
    if (lastSegment(imp.importText) !== bareType) continue;
    const mapped = mapper.mapImportToFile(imp.importText, ctx.callerFile, ctx);
    if (mapped.kind === "project") return mapped.relPath;
    if (mapped.kind === "external") continue;
    const file = mapPythonImportToFile(imp.importText, ctx.callerFile);
    if (file) return file;
  }
  return null;
}

/**
 * Resolve `<typeName>.<member>` inside the file that defines `typeName`, then
 * up its IN-PROJECT `classExtends` chain. `null` when no class in the chain
 * defines the member — the CALLER decides whether that is a file-only edge
 * (a direct local binding, bd tea-rags-mcp-yrs0 / 86qfb) or a DROP (a folded
 * chain type, which has no measurement supporting the weaker answer).
 */
export function resolvePythonMemberOnType(
  typeName: string,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
  mapper: PythonImportFileMapper,
): SymbolResolutionTarget | null {
  const bareType = lastSegment(typeName);
  const targetFile = resolveTypeFile(bareType, ctx, mapper, member);
  if (!targetFile) return null;
  const candidates = ctx.symbolTable
    .lookupByShortName(member)
    .filter((def) => def.relPath === targetFile && def.scope[def.scope.length - 1] === bareType);
  const target = pickSingleCandidate(candidates, mode);
  if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
  // bd tea-rags-mcp-yrs0 — `member` is not defined on the type itself. Walk its
  // IN-PROJECT base chain before giving up: an inherited `Leaf().shared()`
  // where `shared` lives on `Base` resolves to `Base#shared`. The walk starts
  // one level up (the type was already checked above).
  const parent = ctx.classExtends?.[bareType];
  return parent ? walkClassExtendsForMethod(parent, member, ctx, mode) : null;
}
