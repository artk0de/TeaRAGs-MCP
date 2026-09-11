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
  nearestCallResultBinding,
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
  type ImportRef,
  type SymbolDefinition,
  type SymbolLookupOptions,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../../contracts/types/language.js";
import {
  findMemberInAncestorChain,
  type AncestorClosure,
  type AncestorLinearizer,
} from "../../../kernel/ancestor-walk.js";
import { propagateReceiverType, type ReceiverTypePorts } from "../../../kernel/receiver-type-propagation.js";
import { PYTHON_BUILTINS } from "../../vocabulary/builtins.js";
import { isPythonSourcePath } from "../../vocabulary/source-extensions.js";
import { PYTHON_SELF_RETURN } from "../../walker/passes/python-type-annotation.js";
import { pythonModuleReturnKey } from "../../walker/passes/python-type-channels.js";
import type { PythonImportFileMapper } from "../python-import-file-mapper.js";
import { mapPythonImportToFile } from "../python-path-mapper.js";

/**
 * Short-name lookup restricted to PYTHON candidates — the ONLY short-name entry
 * point the Python resolver may use (bd tea-rags-mcp-w205u).
 *
 * The symbol table is built once per run over every `CODEGRAPH_LANGUAGES`
 * extension and carries no `language` field, so `lookupByShortName` alone
 * answers with any file that spells the name. It is not a hypothetical: polar's
 * `range(...)` landed on `Paginator.tsx#range` and `GitHub()` on
 * `Icons.tsx#GitHub`, 46 phantoms across two strategies. Wrapping the call
 * rather than filtering per site is what keeps the guard from being forgotten
 * at the next one; see {@link isPythonSourcePath} for why the extension, and
 * not a `language` field, is the axis.
 */
export function lookupPythonSymbolsByShortName(
  ctx: CallContext,
  name: string,
  options?: SymbolLookupOptions,
): SymbolDefinition[] {
  return ctx.symbolTable.lookupByShortName(name, options).filter((def) => isPythonSourcePath(def.relPath));
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
  const declared = lookupPythonSymbolsByShortName(ctx, bareName).filter((def) => def.relPath === relPath);
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
 */
export function resolvePythonMemberOnTypeThroughMro(
  typeName: string,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
  mapper: PythonImportFileMapper,
  linearizer: AncestorLinearizer<CallContext>,
): PythonTypeMemberResolution {
  const bareType = lastSegment(typeName);
  const targetFile = resolveTypeFile(bareType, ctx, mapper);
  const direct = targetFile === null ? null : pythonBoundClassKey(bareType, targetFile, ctx);
  // Only on a MISS: an import that RENAMED the class carries the source name,
  // and the annotation recorded the local one (bd tea-rags-mcp-w205u, E4.6c).
  const classKey = direct ?? pythonAliasedClassKey(bareType, ctx, mapper);
  if (classKey === null) return UNBOUND_TYPE_MEMBER;
  return resolvePythonInheritedMember(classKey, member, ctx, mode, linearizer);
}

/**
 * The MRO key a name that an import ALIASED denotes — `OrderSchema` under
 * `from polar.order.schemas import Order as OrderSchema` is `Order`'s key (bd
 * tea-rags-mcp-w205u, E4.6c).
 *
 * `null` for everything else, and deliberately so: an UNALIASED binding is
 * already what every other read spells, and an import that maps outside the
 * project names no class this run holds. The alias is evidence the local name
 * alone cannot be — `lookupPythonSymbolsByShortName("OrderSchema")` is empty
 * and `resolveTypeFile`'s import pass matches the module text's last segment,
 * never the alias.
 *
 * The re-export hop is the same one `resolveTypeFile` takes: a package that
 * only re-exports the source name declares nothing, so ask which file does.
 */
export function pythonAliasedClassKey(
  localName: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): string | null {
  const binding = findPythonImportBinding(ctx.imports, localName);
  if (binding === null || binding.importedName === binding.localName) return null;
  const mapped = mapper.mapImportToFile(binding.imp.importText, ctx.callerFile, ctx);
  if (mapped.kind !== "project") return null;
  const direct = pythonBoundClassKey(binding.importedName, mapped.relPath, ctx);
  if (direct !== null) return direct;
  const declaring = mapper.resolveExportedName(mapped.relPath, binding.importedName, ctx);
  return declaring === null ? null : pythonBoundClassKey(binding.importedName, declaring, ctx);
}

/**
 * The MRO key to start a receiver-type walk from, anchored in the CALLER's own
 * file first (bd tea-rags-mcp-yl85b).
 *
 * `resolveTypeFile` answers for a name a file IMPORTS, and it is the wrong
 * question for a `self` receiver: polar declares `MembersSync` in four files
 * and `MetricsSync` in two, so the short-name pass is ambiguous, the
 * import-narrowing pass filters against a list that never contains the caller's
 * own file, and the walk that 1,528 rows depend on never starts. A class the
 * calling file itself declares is the class a bare name in that file binds —
 * module scope is what Python resolves it against — so that read comes first
 * and the import-informed one is the fallback.
 */
function pythonReceiverClassKey(bareType: string, ctx: CallContext, mapper: PythonImportFileMapper): string | null {
  const bare = lastSegment(bareType);
  const own = pythonBoundClassKey(bare, ctx.callerFile, ctx);
  if (own !== null) return own;
  const imported = resolveTypeFile(bare, ctx, mapper);
  const direct = imported === null ? null : pythonBoundClassKey(bare, imported, ctx);
  // Last, and only on a miss: the name an import RENAMED (bd
  // tea-rags-mcp-w205u, E4.6c). See {@link pythonAliasedClassKey}.
  return direct ?? pythonAliasedClassKey(bare, ctx, mapper);
}

/**
 * What `member` yields on a receiver of type `bareType`, consulting the whole
 * MRO rather than just the class the receiver names (bd tea-rags-mcp-yl85b).
 *
 * This is the FIELD and RETURN counterpart of {@link resolvePythonInheritedMember},
 * and it exists because of one measured shape: polar's generated SDK assigns
 * `self.client` in `SyncServiceBase.__init__` and calls it from 60-odd
 * subclasses in other files. `classFieldTypes` is keyed by the SHORT name of
 * the class that ASSIGNED the field, so the subclass has no entry and the fold
 * stopped on hop 1 — 1,528 rows, 95 % of that corpus's `chain` hole.
 *
 * Order per class, own class first: the FIELD channel (narrower — it names the
 * class that owns the attribute), then the RETURN channel under the spelling
 * the receiver form dictates. First answer wins; the walk stops there.
 *
 * A hierarchy that leaves the project before a definition yields NOTHING. The
 * absence is not a verdict here — the caller owns what a miss means, and this
 * function never fabricates a type to fill one.
 *
 * A run with no linearizer (a walker-v2 index carrying no `classAncestors`)
 * reads the own class only, which is exactly the pre-seam behaviour.
 */
export function pythonInheritedMemberType(
  bareType: string,
  member: string,
  form: "class" | "instance",
  ctx: CallContext,
  mapper: PythonImportFileMapper,
  linearizer: AncestorLinearizer<CallContext> | undefined,
): TypeRef | undefined {
  const declared = pythonDeclaredMemberType(bareType, member, form, ctx, mapper, linearizer);
  if (declared !== undefined) return declared;
  // LAST, and only when the run carries the channel: a field assigned from a
  // CALL, folded ONE level (bd tea-rags-mcp-w205u, E4.6c).
  return pythonFieldCallResultType(bareType, member, ctx, mapper, linearizer);
}

/** {@link pythonInheritedMemberType} minus its call-result tier — the pre-E4.6c body. */
function pythonDeclaredMemberType(
  bareType: string,
  member: string,
  form: "class" | "instance",
  ctx: CallContext,
  mapper: PythonImportFileMapper,
  linearizer: AncestorLinearizer<CallContext> | undefined,
): TypeRef | undefined {
  const separator = form === "class" ? "." : "#";
  const onClass = (shortName: string, classFq: string): TypeRef | undefined => {
    const fieldType = ctx.classFieldTypes?.[shortName]?.[member];
    if (fieldType !== undefined) return { form: "instance", name: fieldType };
    const returned = ctx.structuredReturnTypes?.[`${classFq}${separator}${member}`];
    // `-> Self` is the class the RECEIVER names, not the one that declared the
    // method (bd tea-rags-mcp-w205u, E4.6b-1). The annotation facet records the
    // marker precisely because only this side knows `bareType`; substituting
    // here rather than in one port covers `selfField` on the same terms.
    return returned?.form === "instance" && returned.name === PYTHON_SELF_RETURN
      ? { form: "instance", name: bareType }
      : returned;
  };
  const byClassKey = (classKey: string): TypeRef | undefined => {
    const fieldType = ctx.classFieldTypesByClassKey?.[classKey]?.[member];
    return fieldType === undefined ? undefined : { form: "instance", name: fieldType };
  };
  // The own-class read is byte-identical to the pre-seam one: `classFieldTypes`
  // is bare-name-keyed and `structuredReturnTypes` FQ-keyed, and a receiver
  // type spells both the same way.
  const own = onClass(bareType, bareType);
  if (own !== undefined) return own;
  // Addressing the class costs symbol-table work, so it is deferred until
  // something can read the answer: a run carrying neither the run-global field
  // channel nor a linearizer is the pre-seam path, unchanged.
  if (linearizer === undefined && ctx.classFieldTypesByClassKey === undefined) return undefined;

  const classKey = pythonReceiverClassKey(bareType, ctx, mapper);
  if (classKey === null) return undefined;
  // The own class again, this time run-global (bd tea-rags-mcp-f0xaa) — the
  // short-name read above only ever sees the CALLER's file, so a receiver typed
  // to a class declared elsewhere reaches its fields only here.
  const ownByKey = byClassKey(classKey);
  if (ownByKey !== undefined) return ownByKey;
  if (linearizer === undefined) return undefined;
  for (const ancestorKey of linearizer.linearize(classKey).order) {
    if (ancestorKey === classKey) continue;
    // Class-key first, short name second: the qualified channel names the file
    // that declares this ancestor, where the bare-name one answers with whatever
    // the CALLER's file happens to call that name.
    const byKey = byClassKey(ancestorKey);
    if (byKey !== undefined) return byKey;
    const parsed = parsePythonClassKey(ancestorKey);
    if (parsed === null) continue;
    const hit = onClass(lastSegment(parsed.classFq), parsed.classFq);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** A single capitalized identifier — Python's class-name convention. */
const PYTHON_CLASS_NAME = /^[A-Z]\w*$/;
/** A single lowercase identifier — a function, never a class. */
const PYTHON_FUNCTION_NAME = /^[a-z_]\w*$/;

/**
 * What answers when NO import binding names a file — the two pre-E5.1c
 * reachability rules, kept apart because each was measured on its own path.
 *
 *   - `"requireReach"` — the caller's own module scope, or an import that maps
 *     into the project. E4.6b-1's gate for a chain head and E4.6c's for a
 *     field; a name the caller cannot reach is not the name it called.
 *   - `"acceptSoleDef"` — the corpus declares exactly ONE module-level def of
 *     that name, so there is nothing to pick between. `pythonCallBindingType`
 *     has admitted those since z68v9 with no reachability test at all.
 */
type PythonUnboundCalleeRule = "requireReach" | "acceptSoleDef";

/**
 * WHICH file's module-level `callee` this caller meant (bd
 * tea-rags-mcp-1v12o.1.7, E5.1c).
 *
 * The binding for THAT name first, through {@link pythonImportBoundFile} — the
 * one funnel that narrows a namesake anywhere in this resolver. It also answers
 * the caller's OWN file when nothing imported the name, which is what a bare
 * call resolves against. Only when the funnel is silent does
 * {@link PythonUnboundCalleeRule} decide, and only ever on a SOLE candidate:
 * two defs and no binding is a refusal on both rules, which is the collision
 * the per-file key exists to prevent.
 */
function pythonModuleDefFile(
  callee: string,
  defs: readonly SymbolDefinition[],
  ctx: CallContext,
  mapper: PythonImportFileMapper,
  unbound: PythonUnboundCalleeRule,
): string | null {
  if (defs.length === 0) return null;
  const narrowed = pythonImportBoundFile(
    callee,
    defs.map((def) => def.relPath),
    ctx,
    mapper,
  );
  if (narrowed !== null) return narrowed;
  if (defs.length !== 1) return null;
  const only = defs[0].relPath;
  if (unbound === "acceptSoleDef" || only === ctx.callerFile) return only;
  const bound = findPythonImportBinding(ctx.imports, callee);
  return bound !== null && mapper.mapImportToFile(bound.imp.importText, ctx.callerFile, ctx).kind === "project"
    ? only
    : null;
}

/**
 * What a MODULE-LEVEL `callee` records as its return, read under the file the
 * caller's own binding names (bd tea-rags-mcp-1v12o.1.7, E5.1c).
 *
 * Only `scope.length === 0` defs are candidates, because only they are keyed
 * `<relPath>::<name>`; a class member is addressed by its owner and is reached
 * through {@link pythonInheritedMemberType} instead. A key shape an older
 * persisted pass-1 slice wrote (the bare name, bd tea-rags-mcp-8qyax) is never
 * asked for, so it is silence rather than a wrong answer.
 */
export function pythonModuleReturnType(
  callee: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
  unbound: PythonUnboundCalleeRule,
): TypeRef | undefined {
  const defs = lookupPythonSymbolsByShortName(ctx, callee).filter((def) => def.scope.length === 0);
  const file = pythonModuleDefFile(callee, defs, ctx, mapper, unbound);
  return file === null ? undefined : ctx.structuredReturnTypes?.[pythonModuleReturnKey(file, callee)];
}

/**
 * A bare `factory()` call's own recorded return type (bd tea-rags-mcp-w205u,
 * E4.6b-1 as a chain head, E4.6c at a field).
 *
 * The lowercase gate is this arm's alone: a chain head spelled `Datatable(…)`
 * is a CONSTRUCTOR and belongs to the class-head seed, which runs before this.
 */
export function pythonBareCallReturnType(
  callee: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): TypeRef | undefined {
  return PYTHON_FUNCTION_NAME.test(callee) ? pythonModuleReturnType(callee, ctx, mapper, "requireReach") : undefined;
}

/**
 * What the CALLEE recorded in `classFieldCallResults` returns, read ONE level
 * (bd tea-rags-mcp-w205u, E4.6c).
 *
 * Three spellings and no fourth, because those are the three the corpora
 * measured:
 *
 *   `get_geo_provider`             a bare project function — its own return
 *   `PaymentRepository.from_session`  a class-form call, `-> Self` naming the
 *                                    RECEIVER class rather than the declaring one
 *   `self._init_transport`         a method of the class being walked
 *
 * Every arm reads {@link pythonDeclaredMemberType}, never the exported entry
 * point: one level means a callee whose own return is itself only knowable
 * through this channel is silence, not a worklist (decision 3 of the plan).
 */
function pythonFieldCallResultType(
  bareType: string,
  member: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
  linearizer: AncestorLinearizer<CallContext> | undefined,
): TypeRef | undefined {
  const channel = ctx.classFieldCallResults;
  // The pre-channel path, and the perf gate: a run without it never addresses
  // the class, which costs symbol-table work.
  if (channel === undefined) return undefined;
  const classKey = pythonReceiverClassKey(bareType, ctx, mapper);
  if (classKey === null) return undefined;
  const keys = [classKey, ...(linearizer === undefined ? [] : linearizer.linearize(classKey).order)];
  for (const key of keys) {
    const callee = channel[key]?.[member];
    if (callee === undefined) continue;
    const type = pythonCalleeSpellingType(callee, bareType, ctx, mapper, linearizer);
    // First fact wins, answer or not — a second class further up the MRO
    // assigning the same field is shadowed, exactly as the type channels are.
    return type;
  }
  return undefined;
}

/** One callee SPELLING → the type it yields. See {@link pythonFieldCallResultType}. */
function pythonCalleeSpellingType(
  callee: string,
  ownerType: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
  linearizer: AncestorLinearizer<CallContext> | undefined,
): TypeRef | undefined {
  const dot = callee.lastIndexOf(".");
  if (dot === -1) return pythonBareCallReturnType(callee, ctx, mapper);
  const head = callee.slice(0, dot);
  const method = callee.slice(dot + 1);
  // `self.<method>()` — the receiving class IS the one whose field this is.
  if (head === "self") return pythonDeclaredMemberType(ownerType, method, "instance", ctx, mapper, linearizer);
  const bareHead = lastSegment(head);
  if (!PYTHON_CLASS_NAME.test(bareHead)) return undefined;
  // Gated on the class resolving into the project, exactly as the chain's own
  // class-head seed is: a capitalised name an import took from a library is a
  // coincidence of spelling, not evidence.
  if (resolveTypeFile(bareHead, ctx, mapper) === null && pythonAliasedClassKey(bareHead, ctx, mapper) === null) {
    return undefined;
  }
  return pythonDeclaredMemberType(bareHead, method, "class", ctx, mapper, linearizer);
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
 * Which of `candidates` the CALLER's own import binding for `name` points at,
 * or `null` (bd tea-rags-mcp-1v12o.1.5, E5.1a). The single funnel both namesake
 * halves narrow through.
 *
 * A short name declared in two or more project files is only ambiguous to a
 * reader who ignores what the calling file wrote down. polar declares
 * `Subscription` at `models/subscription.py` and `subscription/schemas.py` and
 * `get_client` in six files, and every residual row of that shape carries an
 * import naming exactly one of them. Nothing here guesses: the answer is the
 * caller's statement resolved through {@link PythonImportFileMapper}, or
 * nothing.
 *
 * Why it is not {@link resolveTypeFile}'s existing narrowing. That pass filters
 * candidates against the caller's import SET — every file ANY import maps to —
 * and polar's `customer_portal/service/subscription.py` imports `Subscription`
 * from `polar.models` AND `SubscriptionChargePreview` from
 * `polar.subscription.schemas`. Both candidate files land in the set, two
 * survive, and the pass refuses. The binding for THIS name names one.
 *
 * Three reads, first hit wins, all deterministic: the module the import maps
 * to, the file that DECLARES the imported name one re-export hop on
 * (`from polar.models import Subscription` → `models/__init__.py` →
 * `models/subscription.py`), and the MODULE a package aliases under that name
 * (`from . import _datatable as datatable`). An import that maps outside the
 * project, or onto a file no candidate occupies, is a refusal — not a fallback.
 *
 * With NO binding for the name, the caller's OWN file answers when it declares
 * the name: module scope is what a bare name resolves against, and a file that
 * declares it needs no import. Everything else refuses.
 */
export function pythonImportBoundFile(
  name: string,
  candidates: readonly string[],
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): string | null {
  const binding = findPythonImportBinding(ctx.imports, name);
  if (binding === null) return candidates.includes(ctx.callerFile) ? ctx.callerFile : null;
  const mapped = mapper.mapImportToFile(binding.imp.importText, ctx.callerFile, ctx);
  if (mapped.kind !== "project") return null;
  const hops = [
    mapped.relPath,
    mapper.resolveExportedName(mapped.relPath, binding.importedName, ctx),
    mapper.resolveExportedModule(mapped.relPath, binding.importedName, ctx),
  ];
  for (const hop of hops) if (hop !== null && candidates.includes(hop)) return hop;
  return null;
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
  const tableMatches = lookupPythonSymbolsByShortName(ctx, bareType);
  if (tableMatches.length === 1) {
    return pythonTypeOwnsMembers(bareType, member, ctx) ? tableMatches[0].relPath : null;
  }

  // Second pass: try to disambiguate via imports — the class file
  // must be one of the files reachable from the caller's imports. Only a
  // `project` verdict names a file the table can hold, so it is the only one
  // that can narrow the candidates.
  if (tableMatches.length > 1) {
    // FIRST, the binding for THIS name (bd tea-rags-mcp-1v12o.1.5, E5.1a). The
    // set-filter below reads every file any import maps to, which conflates
    // "a file this caller imports something from" with "the file this caller's
    // binding for this name names" — polar's
    // `customer_portal/service/subscription.py` imports `Subscription` from
    // `polar.models` and `SubscriptionChargePreview` from
    // `polar.subscription.schemas`, and the set holds both `Subscription`
    // candidates. See {@link pythonImportBoundFile}.
    const bound = pythonImportBoundFile(
      bareType,
      tableMatches.map((def) => def.relPath),
      ctx,
      mapper,
    );
    if (bound !== null) return bound;
    const importedFiles = new Set<string>();
    for (const imp of ctx.imports) {
      const mapped = mapper.mapImportToFile(imp.importText, ctx.callerFile, ctx);
      if (mapped.kind === "project") importedFiles.add(mapped.relPath);
    }
    const filtered = tableMatches.filter((def) => importedFiles.has(def.relPath));
    if (filtered.length === 1) return filtered[0].relPath;
    // A miss here is often a package that RE-EXPORTS the name rather than
    // declaring it: netbox's `from core.models import ObjectType` maps to a
    // `__init__.py` that star-imports six siblings, so the filter above kept
    // nothing and the second `ObjectType` in `netbox/graphql/types.py` made
    // guessing illegal — 117 rows. Widening runs only AFTER the direct answer
    // failed, so every row that resolves today resolves to the same file.
    for (const relPath of [...importedFiles]) {
      const declaring = mapper.resolveExportedName(relPath, bareType, ctx);
      if (declaring !== null) importedFiles.add(declaring);
    }
    const followed = tableMatches.filter((def) => importedFiles.has(def.relPath));
    if (followed.length === 1) return followed[0].relPath;
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
  const candidates = lookupPythonSymbolsByShortName(ctx, member).filter(
    (def) => def.relPath === targetFile && def.scope[def.scope.length - 1] === bareType,
  );
  const target = pickSingleCandidate(candidates, mode);
  if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
  // bd tea-rags-mcp-yrs0 — `member` is not defined on the type itself. Walk its
  // IN-PROJECT base chain before giving up: an inherited `Leaf().shared()`
  // where `shared` lives on `Base` resolves to `Base#shared`. The walk starts
  // one level up (the type was already checked above).
  const parent = ctx.classExtends?.[bareType];
  return parent ? walkClassExtendsForMethod(parent, member, ctx, mode) : null;
}

/**
 * The type of the call a local was bound from — ONE hop (bd tea-rags-mcp-z68v9).
 *
 * The callee's receiver is folded by the shared chain engine (so
 * `self.factory.build` works), then its return type is read off the class the
 * fold produced, through the MRO — which is the whole point, since
 * `SubscriptionRepository.from_session` is declared on `RepositoryBase`.
 *
 * A BARE callee (`build_client(…)`) reads {@link pythonModuleReturnType}, which
 * addresses the fact by the FILE the caller's own binding names (bd
 * tea-rags-mcp-1v12o.1.7, E5.1c). E5.1a narrowed the same shape and then had to
 * check the fact's provenance, because the bare key held ONE of polar's six
 * `get_client` annotations for all of them; a per-file key states the
 * provenance instead of leaving it to be inferred, so the guard is gone. The
 * sole-def arm this path has always had stays `"acceptSoleDef"`: one def of the
 * name in the corpus is one answer, whether or not the caller imported it.
 *
 * ONE hop by construction: the returned ref is never itself re-folded. A
 * fixpoint over return types is a different seam and would need a cycle guard
 * this does not have.
 */
export function pythonCallBindingType(
  callee: string,
  atLine: number,
  ctx: CallContext,
  ports: ReceiverTypePorts,
  mapper: PythonImportFileMapper,
): TypeRef | undefined {
  const cut = callee.lastIndexOf(".");
  if (cut < 0) return pythonModuleReturnType(callee, ctx, mapper, "acceptSoleDef");
  const receiverType = propagateReceiverType(callee.slice(0, cut), atLine, ctx, ports);
  if (receiverType === undefined) return undefined;
  return ports.memberTypeOf(receiverType, callee.slice(cut + 1), ctx);
}
