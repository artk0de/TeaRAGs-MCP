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

import { identifierEntry } from "../../../../../contracts/identifier-record.js";
import {
  nearestCallResultBinding,
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
  type SymbolDefinition,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import {
  findMemberInAncestorChain,
  type AncestorClosure,
  type AncestorLinearizer,
  type NominalTypeRef,
} from "../../../kernel/index.js";
import { isPythonSourcePath } from "../../vocabulary/source-extensions.js";
import { PYTHON_STDLIB_MODULES } from "../../vocabulary/stdlib-modules.js";
import { pythonModuleValueKey } from "../../walker/passes/python-type-channels.js";
import type { PythonImportFileMapper } from "../python-import-file-mapper.js";
import {
  findPythonImportBinding,
  lastSegment,
  parsePythonClassKey,
  pythonAliasedClassKey,
  pythonBoundClassKey,
  pythonClassKey,
  pythonDeclaredClassFq,
  resolveTypeFile,
  type PythonImportBinding,
} from "../python-type-addressing.js";
import { lookupPythonSymbolsByShortName } from "../short-name-lookup.js";

/**
 * Moved out of this hub to resolver-root leaves (bd tea-rags-mcp-m99j1.1.29) and
 * re-exported, so `strategies/shared.js` stays the one import path the
 * strategies, tests and scripts use: the class/import ADDRESSING helpers to
 * `../python-type-addressing.js`, the member-return-type walk to
 * `../python-member-return-types.js`.
 */
export {
  findPythonImportBinding,
  lastSegment,
  parsePythonClassKey,
  pythonAliasedClassKey,
  pythonBoundClassKey,
  pythonClassKey,
  pythonDeclaredClassFq,
  pythonImportBoundFile,
  pythonTypeNameIsExternal,
  pythonTypeOwnsMembers,
  resolveTypeFile,
  type PythonImportBinding,
} from "../python-type-addressing.js";
export {
  pythonBareCallReturnType,
  pythonCallBindingType,
  pythonInheritedMemberType,
  pythonModuleReturnType,
  pythonSubstituteSelfReturn,
} from "../python-member-return-types.js";

/**
 * The language-filtered short-name lookup, re-exported so
 * `strategies/shared.js` stays the one import path the strategies use. It is
 * DEFINED one level up, in the leaf `../short-name-lookup.js`, so the
 * resolver-root modules the strategies reach back into — the
 * `PythonImportFileMapper` type foremost — can use it without closing an
 * import cycle (bd tea-rags-mcp-0qaht.35); see there.
 */
export { lookupPythonSymbolsByShortName, PYTHON_SYMBOL_KIND_ROLES } from "../short-name-lookup.js";

/**
 * Fully-qualified lookup restricted to PYTHON candidates — the lookup the
 * Python resolver hands `reexportOriginFile` (bd tea-rags-mcp-nbf8q). The
 * fq key is no safer than the short name: a top-level class's fqName is its
 * bare name in every language, so a TypeScript `Flask` beside the package's
 * own made the barrel hop read two declarations and decline, or land a Python
 * import on a `.ts` file. Mirrors `lookupEcmascriptSymbols` on the TypeScript
 * side.
 */
export function lookupPythonSymbols(ctx: CallContext, fqName: string): SymbolDefinition[] {
  return ctx.symbolTable.lookup(fqName).filter((def) => isPythonSourcePath(def.relPath));
}

/**
 * Was `receiver` assigned, at or above `atLine`, from a call whose CALLEE the
 * project does not declare?
 *
 * The head is what carries the answer, and only the head: `User.objects.get`
 * starts on a project class and its result is overwhelmingly an instance of it,
 * while `authenticate(...)`, `get_object_or_404(...)`, `RQ_Job.fetch` and
 * `logging.getLogger(...)` start outside and their results are library values
 * that happen to be spelled like a project name. Measured on seam 5's A/B:
 * gating on the mere PRESENCE of a call binding removed 7 phantoms (netbox 5,
 * ugnest 2) but cost 12 correct answers, eleven of them ugnest rows bound by
 * `User.objects.get`. Gating on the head's origin removes the same 7 and costs
 * one row, because that is the axis the two populations actually differ on.
 *
 * `self` / `cls` heads are the caller's own object and never foreign. The lookup
 * is a symbol-table short-name probe, so a caller that was already going to weigh
 * the site adds no new scan.
 *
 * Two readers, one definition: `namingConvention` guesses a class from the
 * receiver's SPELLING, the untyped-name dispatch component fans over the
 * member's owners — and both are wrong on exactly this shape.
 */
export function pythonBoundToForeignCall(receiver: string, atLine: number, ctx: CallContext): boolean {
  const binding = nearestCallResultBinding(ctx.callResultBindings, receiver, atLine);
  if (binding === undefined) return false;
  const head = binding.callee.split(".")[0] ?? "";
  if (head === "self" || head === "cls" || head.length === 0) return false;
  return lookupPythonSymbolsByShortName(ctx, head).length === 0;
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
    if (identifierEntry(ctx.classAncestors, key) !== undefined || pythonClassKeyIsDeclared(key, ctx)) {
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

/** A member found on a class or one of its ancestors, and how far the walk could see. */
export interface PythonInheritedMemberResult {
  readonly target: SymbolResolutionTarget | null;
  readonly closure: AncestorClosure;
}

/**
 * `<member>` on `classKey` or the first ancestor in its MRO that owns it (bd
 * tea-rags-mcp-9fgdi). `classifyMethod` files an undecorated `def` as the
 * instance spelling (`Cls#m`) and a `@classmethod` / `@staticmethod` one as the
 * class spelling (`Cls.m`), and the corpora carry both
 * (`GetRelatedModelsMixin#get_related_models`, `RepositoryBase.from_session`),
 * so the scan tries both at every class in the order.
 *
 * WHICH ONE IT TRIES FIRST is `options.spellingOrder`, and it matters only for
 * a class that declares BOTH — a `@classmethod` shadowing an inherited instance
 * method. `instanceFirst` is the default and is what an instance receiver
 * wants; `classFirst` is what a receiver that IS the class object wants (bd
 * tea-rags-mcp-w205u, E4.4a). The option REORDERS and never excludes, so a
 * `cls.instance_method()` still resolves.
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
  options: {
    readonly startAfter?: boolean;
    readonly spellingOrder?: "instanceFirst" | "classFirst";
  } = {},
): PythonInheritedMemberResult {
  const scan = findMemberInAncestorChain(
    classKey,
    linearizer,
    (candidateKey) => {
      const parsed = parsePythonClassKey(candidateKey);
      if (parsed === null) return null;
      const instance = `${parsed.classFq}#${member}`;
      const klass = `${parsed.classFq}.${member}`;
      for (const spelling of options.spellingOrder === "classFirst" ? [klass, instance] : [instance, klass]) {
        const inFile = ctx.symbolTable.lookup(spelling).filter((def) => def.relPath === parsed.relPath);
        const picked = pickSingleCandidate(inFile, mode);
        if (picked) return { targetRelPath: picked.relPath, targetSymbolId: picked.symbolId };
      }
      return null;
    },
    // Forward only what the kernel walk declares, so a Python-only option
    // cannot leak into a signature that has no field for it.
    { startAfter: options.startAfter },
  );
  return { target: scan.target, closure: scan.closure };
}

/**
 * Where a walk for a member on a NAMED TYPE stopped, when it found nothing.
 * `unbound` is this module's own state and not one of the kernel's: the type
 * NAME never named a class the project declares, so no hierarchy was entered
 * and the ancestor closure has nothing to say about it.
 */
export type PythonTypeMemberClosure = AncestorClosure | "unbound";

/** A member found on a named type or one of its ancestors, and how far the walk saw. */
export interface PythonTypeMemberResolution {
  readonly target: SymbolResolutionTarget | null;
  readonly closure: PythonTypeMemberClosure;
}

const UNBOUND_TYPE_MEMBER: PythonTypeMemberResolution = { target: null, closure: "unbound" };

/**
 * `<member>` on a receiver whose TYPE NAME is known, resolved through the C3
 * MRO (bd tea-rags-mcp-s2w5g).
 *
 * The two steps between a type name and {@link resolvePythonInheritedMember}:
 * the name resolves to the FILE that declares it, and the file plus the name
 * become the dotted-FQ class KEY the ancestor walk is addressed by. Stated once
 * here because three passes ask the same question of a differently-obtained
 * type — `localBinding` of the walker's binding, `selfField` of the field's
 * recorded type, `chainType` of what the fold arrived at — and the verbatim
 * `<Type>#<member>` lookup two of them used instead is blind to inheritance:
 * polar's `self.client.build_request()` types `client` to `SyncClientBase` and
 * `build_request` is declared on `BuildRequestMixin`, a base of it. 752 rows.
 *
 * The verdict is the CALLER's. `unbound` and `closed` and `external` are three
 * different pieces of evidence and the passes act on them differently; this
 * function never fabricates a target to settle one.
 *
 * `options.spellingOrder` is forwarded to {@link resolvePythonInheritedMember}:
 * a receiver that IS the class object asks `classFirst`. Omitted, the order is
 * the instance-first default every existing caller relies on.
 */
export function resolvePythonMemberOnTypeThroughMro(
  typeName: string,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
  mapper: PythonImportFileMapper,
  linearizer: AncestorLinearizer<CallContext>,
  options: { readonly spellingOrder?: "instanceFirst" | "classFirst" } = {},
): PythonTypeMemberResolution {
  const bareType = lastSegment(typeName);
  const targetFile = resolveTypeFile(bareType, ctx, mapper);
  const direct = targetFile === null ? null : pythonBoundClassKey(bareType, targetFile, ctx);
  // Only on a MISS: an import that RENAMED the class carries the source name,
  // and the annotation recorded the local one (bd tea-rags-mcp-w205u, E4.6c).
  const classKey = direct ?? pythonAliasedClassKey(bareType, ctx, mapper);
  if (classKey === null) return UNBOUND_TYPE_MEMBER;
  return resolvePythonInheritedMember(classKey, member, ctx, mode, linearizer, {
    spellingOrder: options.spellingOrder,
  });
}

/**
 * `ResolverConfig` / `CONE_MAX_DEFAULT` live in the kernel
 * (`readResolverConfig` builds the config); re-exported so
 * `strategies/shared.js` stays the one import path the strategies use.
 * `CODEGRAPH_PY_CONE_MAX` overrides at composition.
 */
export { CONE_MAX_DEFAULT, type ResolverConfig } from "../../../kernel/index.js";

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
    current = identifierEntry(ctx.classExtends, current);
  }
  return null;
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

/**
 * The module text a single-identifier receiver denotes, from the two shapes
 * `collectPythonImports` records (`walker/walker.ts:499`).
 *
 * `importedBindings[local] === importText` IS the `import_statement` form —
 * there the recorded value is the MODULE PATH. An unaliased `import a.b` binds
 * the top package, so its head denotes `a`, not `a.b`; an aliased one denotes
 * the whole path. Everything else is `from M import name`, where the value is
 * an exported NAME and the receiver denotes the SUBMODULE `M.name` — joined
 * without a separator when `M` already ends in a dot, or `from . import c`
 * would compose `..c` and climb a package.
 */
export function receiverModuleText(binding: PythonImportBinding): string {
  const { importText } = binding.imp;
  if (binding.importedName === importText) {
    const firstSegment = binding.importedName.split(".")[0];
    return binding.localName === firstSegment ? firstSegment : binding.importedName;
  }
  return importText.endsWith(".") ? `${importText}${binding.importedName}` : `${importText}.${binding.importedName}`;
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
  const candidates = lookupPythonSymbolsByShortName(ctx, member, { role: "callee" }).filter(
    (def) => def.relPath === targetFile && def.scope[def.scope.length - 1] === bareType,
  );
  const target = pickSingleCandidate(candidates, mode);
  if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
  // bd tea-rags-mcp-yrs0 — `member` is not defined on the type itself. Walk its
  // IN-PROJECT base chain before giving up: an inherited `Leaf().shared()`
  // where `shared` lives on `Base` resolves to `Base#shared`. The walk starts
  // one level up (the type was already checked above).
  const parent = identifierEntry(ctx.classExtends, bareType);
  return parent ? walkClassExtendsForMethod(parent, member, ctx, mode) : null;
}

/**
 * A module-scope VALUE a receiver denotes, anchored at the file that binds it
 * (P4, bd tea-rags-mcp-m99j1.1.15): the recorded type, and the KEY of the class
 * that type names, resolved from the VALUE's file rather than the caller's.
 * `apps = Apps(...)` in `django/apps/registry.py` names the `Apps` that file
 * declares, whatever an importing caller happens to call `Apps`.
 */
export interface PythonModuleValueClass {
  readonly type: NominalTypeRef;
  readonly classKey: string;
}

/**
 * `name` as a module-scope value, or `null`. Two ways to reach one:
 *
 *  - an IMPORT bound the name: the import's module maps into the project and
 *    its file — or the one it re-exports from — binds a typed value under it
 *    (`PythonImportFileMapper#resolveExportedValue`). A stdlib import is
 *    refused before the mapper, the rule `importedName` keeps;
 *  - NOTHING bound it locally: no import, and the caller's chunk records no
 *    binding of the name at all — Python makes a name assigned anywhere in a
 *    function local to all of it — so it is the caller's own module global.
 *
 * The class key is the precision gate. The value's own file declaring the class
 * once answers; otherwise exactly one project definition of that short name
 * does. Anything else is a refusal — the declaring file's imports are not
 * reachable from a `CallContext`, so an ambiguous name stays untyped.
 */
export function pythonModuleValueClass(
  name: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): PythonModuleValueClass | null {
  if (ctx.moduleValueTypes === undefined) return null;
  const key = pythonModuleValueKeyFor(name, ctx, mapper);
  if (key === null) return null;
  const type = identifierEntry(ctx.moduleValueTypes, key);
  if (type?.form !== "instance") return null;
  const valueFile = key.slice(0, key.lastIndexOf("::"));
  const classKey = pythonValueClassKey(lastSegment(type.name), valueFile, ctx);
  return classKey === null ? null : { type, classKey };
}

/**
 * Is this an ABSOLUTE import of a stdlib module? Relative text (`.models`) can
 * never name the stdlib and its first segment is empty, so it is excluded
 * rather than tested. (Moved from `python-imported-name.ts`, P4.)
 */
export function pythonImportsStdlibModule(importText: string): boolean {
  if (importText.startsWith(".")) return false;
  return PYTHON_STDLIB_MODULES.has(importText.split(".")[0]);
}

function pythonModuleValueKeyFor(name: string, ctx: CallContext, mapper: PythonImportFileMapper): string | null {
  const binding = findPythonImportBinding(ctx.imports, name);
  if (binding !== null) {
    const { importText } = binding.imp;
    if (pythonImportsStdlibModule(importText)) return null;
    const mapped = mapper.mapImportToFile(importText, ctx.callerFile, ctx);
    return mapped.kind === "project" ? mapper.resolveExportedValue(mapped.relPath, binding.importedName, ctx) : null;
  }
  if (identifierEntry(ctx.localBindings, name) !== undefined) return null;
  if (identifierEntry(ctx.callResultBindings, name) !== undefined) return null;
  const key = pythonModuleValueKey(ctx.callerFile, name);
  return identifierEntry(ctx.moduleValueTypes, key) === undefined ? null : key;
}

function pythonValueClassKey(bareType: string, valueFile: string, ctx: CallContext): string | null {
  const own = pythonBoundClassKey(bareType, valueFile, ctx);
  if (own !== null) return own;
  const defs = lookupPythonSymbolsByShortName(ctx, bareType);
  return defs.length === 1 ? pythonClassKey(defs[0].relPath, pythonDeclaredClassFq(defs[0])) : null;
}

/**
 * `member` on the class a module value holds — instance spelling first, the
 * value is an instance. Up the MRO when the run has a linearizer, else the
 * class's own two spellings in its file; a miss is `null` and the caller keeps
 * its own verdict.
 */
export function resolvePythonModuleValueMember(
  value: PythonModuleValueClass,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
  linearizer: AncestorLinearizer<CallContext> | undefined,
): SymbolResolutionTarget | null {
  if (linearizer !== undefined) {
    return resolvePythonInheritedMember(value.classKey, member, ctx, mode, linearizer, {
      spellingOrder: "instanceFirst",
    }).target;
  }
  const parsed = parsePythonClassKey(value.classKey);
  if (parsed === null) return null;
  for (const spelling of [`${parsed.classFq}#${member}`, `${parsed.classFq}.${member}`]) {
    const picked = pickSingleCandidate(
      ctx.symbolTable.lookup(spelling).filter((def) => def.relPath === parsed.relPath),
      mode,
    );
    if (picked) return { targetRelPath: picked.relPath, targetSymbolId: picked.symbolId };
  }
  return null;
}
