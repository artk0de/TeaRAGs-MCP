/**
 * Python's member-return-type reads: the owner -> ancestors walk through the
 * kernel `MemberReturnTypeResolver`, the field-call-result tier, and the
 * call-result binding (bd tea-rags-mcp-m99j1.1.29, the K6 hub cut).
 *
 * Extracted verbatim from `strategies/shared.ts`, which re-exports every
 * exported name so existing import paths keep working. Imports the addressing
 * leaf `python-type-addressing.js` and the kernel, never `strategies/shared.ts`.
 */

import { identifierEntry } from "../../../../contracts/identifier-record.js";
import type { CallContext, SymbolDefinition } from "../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../contracts/types/language.js";
import {
  MemberReturnTypeResolver,
  propagateReceiverType,
  typeRefReceiverForm,
  type AncestorLinearizer,
  type MemberReturnTypePorts,
  type NominalTypeRef,
  type ReceiverTypePorts,
} from "../../kernel/index.js";
import { pythonVocabularyFor } from "../vocabulary/frameworks/index.js";
import { PYTHON_SELF_RETURN } from "../walker/passes/python-type-annotation.js";
import { pythonModuleReturnKey } from "../walker/passes/python-type-channels.js";
import type { PythonImportFileMapper } from "./python-import-file-mapper.js";
import {
  findPythonImportBinding,
  lastSegment,
  parsePythonClassKey,
  pythonAliasedClassKey,
  pythonBoundClassKey,
  pythonImportBoundFile,
  resolveTypeFile,
} from "./python-type-addressing.js";
import { lookupPythonSymbolsByShortName } from "./short-name-lookup.js";

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
  args?: readonly TypeRef[],
): TypeRef | undefined {
  const declared = pythonDeclaredMemberType(bareType, member, form, ctx, mapper, linearizer, args);
  if (declared !== undefined) return declared;
  // LAST, and only when the run carries the channel: a field assigned from a
  // CALL, folded ONE level (bd tea-rags-mcp-w205u, E4.6c).
  return pythonFieldCallResultType(bareType, member, ctx, mapper, linearizer);
}

/**
 * `-> Self` names the class the RECEIVER holds, not the one that declared the
 * method (bd tea-rags-mcp-w205u E4.6b-1, bd tea-rags-mcp-1v12o.1.6 E5.1b).
 *
 * The annotation facet records the marker rather than a class precisely because
 * only the read side knows the receiver: polar's `CustomerRepository` inherits
 * `from_session` from `RepositoryBase`, and recording the DECLARING class puts
 * every following hop on the base. A class receiver substitutes that class, an
 * instance receiver its own type — ONE rule, because the receiver's NAME is all
 * either form contributes, and a receiver with no type substitutes nothing.
 *
 * Every read of the channel that can see a receiver funnels through here, so
 * the marker cannot leave this module under any spelling: the MRO walk above,
 * and the call-result binding in {@link pythonCallBindingType}.
 */
export function pythonSubstituteSelfReturn(returned: TypeRef | undefined, receiverName: string): TypeRef | undefined {
  return returned?.form === "instance" && returned.name === PYTHON_SELF_RETURN
    ? { form: "instance", name: receiverName }
    : returned;
}

/** {@link pythonInheritedMemberType} minus its call-result tier — the pre-E4.6c body. */
function pythonDeclaredMemberType(
  bareType: string,
  member: string,
  form: "class" | "instance",
  ctx: CallContext,
  mapper: PythonImportFileMapper,
  linearizer: AncestorLinearizer<CallContext> | undefined,
  args?: readonly TypeRef[],
): TypeRef | undefined {
  const resolver = new MemberReturnTypeResolver(pythonMemberReturnTypePorts(ctx, mapper, linearizer));
  // `args` reach the framework port only: a relation carries its model there.
  const owner: NominalTypeRef = args === undefined ? { form, name: bareType } : { form, name: bareType, args };
  return resolver.returnTypeOf(owner, member, ctx) ?? undefined;
}

/**
 * Python's reads for the kernel `MemberReturnTypeResolver` (bd
 * tea-rags-mcp-m99j1.1.12), built per call because the receiver's class key is
 * computed at most once and shared by the owner read and the ancestor list.
 *
 * Owner and ancestor are read in DIFFERENT channel orders, and both orders are
 * measured behaviour:
 *
 *   - the OWNER: its bare-name field, then its return under the receiver
 *     form's spelling — byte-identical to the pre-seam read, because
 *     `classFieldTypes` is bare-name-keyed and `structuredReturnTypes`
 *     FQ-keyed, and a receiver type spells both the same way — then, only when
 *     the run can read it, the run-global class-key field channel
 *     (bd tea-rags-mcp-f0xaa): the short-name read only ever sees the CALLER's
 *     file, so a receiver typed to a class declared elsewhere reaches its
 *     fields only there;
 *   - an ANCESTOR: class-key field first, short name second — the qualified
 *     channel names the file that declares the ancestor, where the bare-name
 *     one answers with whatever the CALLER's file happens to call that name.
 *
 * Every return read substitutes `-> Self` with the OWNER's name, never the
 * ancestor that declared it. Python has no framework hook and no flat fact on
 * this path; the call-result tier runs after the kernel walk, in
 * {@link pythonInheritedMemberType}.
 */
function pythonMemberReturnTypePorts(
  ctx: CallContext,
  mapper: PythonImportFileMapper,
  linearizer: AncestorLinearizer<CallContext> | undefined,
): MemberReturnTypePorts {
  let classKey: string | null | undefined;
  // Addressing the class costs symbol-table work, so it is deferred until
  // something can read the answer: a run carrying neither the run-global field
  // channel nor a linearizer is the pre-seam path, unchanged.
  const receiverClassKey = (bareType: string): string | null => {
    if (linearizer === undefined && ctx.classFieldTypesByClassKey === undefined) return null;
    if (classKey === undefined) classKey = pythonReceiverClassKey(bareType, ctx, mapper);
    return classKey;
  };
  const onClass = (owner: NominalTypeRef, shortName: string, classFq: string, member: string): TypeRef | null => {
    const fieldType = identifierEntry(identifierEntry(ctx.classFieldTypes, shortName), member);
    if (fieldType !== undefined) return { form: "instance", name: fieldType };
    const separator = owner.form === "class" ? "." : "#";
    const returned = pythonReturnFactAsReceiver(ctx.structuredReturnTypes?.[`${classFq}${separator}${member}`]);
    return pythonSubstituteSelfReturn(returned, owner.name) ?? null;
  };
  const byClassKey = (key: string, member: string): TypeRef | null => {
    const fieldType = identifierEntry(identifierEntry(ctx.classFieldTypesByClassKey, key), member);
    return fieldType === undefined ? null : { form: "instance", name: fieldType };
  };
  return {
    declaredReturnType: (owner, member) => {
      const own = onClass(owner, owner.name, owner.name, member);
      if (own !== null) return own;
      const key = receiverClassKey(owner.name);
      return key === null ? null : byClassKey(key, member);
    },
    ancestorsOf: (owner) => {
      if (linearizer === undefined) return [];
      const key = receiverClassKey(owner.name);
      return key === null ? [] : linearizer.linearize(key).order.filter((ancestorKey) => ancestorKey !== key);
    },
    ancestorReturnType: (ancestorKey, owner, member) => {
      const byKey = byClassKey(ancestorKey, member);
      if (byKey !== null) return byKey;
      const parsed = parsePythonClassKey(ancestorKey);
      return parsed === null ? null : onClass(owner, lastSegment(parsed.classFq), parsed.classFq, member);
    },
    frameworkReturnType: (owner, member) => pythonFrameworkReturnType(owner, member, ctx, mapper, linearizer),
  };
}

/**
 * What an ACTIVE framework synthesizes for `member` on `owner` (bd
 * tea-rags-mcp-m99j1.1.21) — the kernel consults it after the owner and every
 * ancestor declared nothing, so a project's own `objects = ...` still wins.
 *
 * Two shapes, both read off {@link PythonFrameworkMemberTypes}:
 *   - a verb on one of the framework's relation classes CARRYING a model
 *     (`QuerySet[Book].filter` → `QuerySet[Book]`, `.first` → `Book`). A
 *     relation class without a model in `args` answers nothing: the model is
 *     the claim, and a bare `Manager` names none;
 *   - a synthesized attribute on a MODEL (`Book.objects` → `Manager[Book]`,
 *     `Book._meta` → `Options`), gated on the owner's recorded bases reaching
 *     a model base.
 *
 * The answer names the framework's OWN class. Where the corpus is the
 * framework, the chain pass places it; elsewhere no project file declares it
 * and the pass drops the call as external — never a project namesake guess
 * beyond what the pass already refuses for any type.
 */
function pythonFrameworkReturnType(
  owner: NominalTypeRef,
  member: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
  linearizer: AncestorLinearizer<CallContext> | undefined,
): TypeRef | null {
  for (const vocabulary of pythonVocabularyFor(ctx.declaredDependencies).memberTypes) {
    const model = owner.args?.[0];
    const isRelationClass = vocabulary.relationClasses.has(lastSegment(owner.name));
    // A user manager (`ContentTypeManager(models.Manager)`) inherits the verb, so
    // the receiver's own subclass is what the next hop resolves on.
    if (
      vocabulary.selfReturning.has(member) &&
      (isRelationClass || pythonDescendsFromAny(owner.name, vocabulary.relationClasses, ctx, mapper, linearizer))
    ) {
      return owner;
    }
    if (isRelationClass) {
      if (model === undefined) continue;
      if (vocabulary.relationReturning.has(member)) {
        return { form: "instance", name: vocabulary.relationClass, args: [model] };
      }
      if (vocabulary.instanceReturning.has(member)) return model;
      continue;
    }
    const attribute = vocabulary.modelAttributes.get(member);
    if (attribute === undefined) continue;
    if (!pythonDescendsFromAny(owner.name, vocabulary.modelBases, ctx, mapper, linearizer)) continue;
    const modelRef: TypeRef = { form: "instance", name: owner.name };
    return attribute.carriesModel
      ? { form: "instance", name: attribute.className, args: [modelRef] }
      : { form: "instance", name: attribute.className };
  }
  return null;
}

/**
 * The kernel's `ownerIndependentMemberType` port for Python (bd
 * tea-rags-mcp-m99j1.1.37): an attribute an ACTIVE framework declares
 * `nameUniqueToFramework` (`PythonFrameworkModelAttribute`), typed on an owner
 * the fold could not type. `self.model._meta` → `Options`,
 * `parent_model._default_manager` → `Manager` naming no model — the owner is
 * what is unknown, so no model can be threaded.
 *
 * Gated by the same declared-dependency catalogue as every other facet, so a
 * project that does not depend on Django never sees `Options`.
 */
export function pythonOwnerIndependentMemberType(member: string, ctx: CallContext): TypeRef | undefined {
  for (const vocabulary of pythonVocabularyFor(ctx.declaredDependencies).memberTypes) {
    const attribute = vocabulary.modelAttributes.get(member);
    if (attribute?.nameUniqueToFramework === true) return { form: "instance", name: attribute.className };
  }
  return undefined;
}

/**
 * Does the class `bareType` names record a base spelled as one of
 * `baseNames` — on itself or anywhere up its in-project MRO? The bases are
 * read as WRITTEN (`models.Model` → `Model`), because the model base is the
 * framework's and the hierarchy leaves the project exactly there.
 */
function pythonDescendsFromAny(
  bareType: string,
  baseNames: ReadonlySet<string>,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
  linearizer: AncestorLinearizer<CallContext> | undefined,
): boolean {
  const receiverClassKey = pythonReceiverClassKey(bareType, ctx, mapper);
  if (receiverClassKey === null) return false;
  const keys =
    linearizer === undefined ? [receiverClassKey] : [receiverClassKey, ...linearizer.linearize(receiverClassKey).order];
  for (const classKey of keys) {
    const parsed = parsePythonClassKey(classKey);
    if (parsed !== null && baseNames.has(lastSegment(parsed.classFq))) return true;
    for (const spelling of identifierEntry(ctx.classAncestors, classKey) ?? []) {
      if (baseNames.has(lastSegment(spelling))) return true;
    }
  }
  return false;
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
  const defs = lookupPythonSymbolsByShortName(ctx, callee, { role: "callee" }).filter((def) => def.scope.length === 0);
  const file = pythonModuleDefFile(callee, defs, ctx, mapper, unbound);
  return file === null
    ? undefined
    : pythonReturnFactAsReceiver(ctx.structuredReturnTypes?.[pythonModuleReturnKey(file, callee)]);
}

/**
 * A recorded return fact, read in RECEIVER position (bd tea-rags-mcp-1v12o.4).
 *
 * `-> Comment | None` is how Python spells "may be absent", and it is the
 * ordinary annotation on every selector / lookup / `.get`-alike in a Django
 * codebase. Left as a union it reaches `pythonCallBindingType`'s consumer and
 * the external-definition probe as a form neither can name a class from, so a
 * receiver the annotation typed outright stays untyped: 8 of ugnest's 43
 * residual misses, every one of them a `-> Model | None` selector.
 *
 * The collapse is {@link typeRefReceiverForm}'s own rule and nothing more — a
 * call on `None` reaches no definition, so a `Comment|None` receiver dispatches
 * exactly where a `Comment` receiver does. A union with TWO reachable arms is
 * untouched, because that call really can go two places.
 *
 * Applied at the two places a return fact leaves `structuredReturnTypes`, and
 * BEFORE {@link pythonSubstituteSelfReturn} on the path that has one: `Self |
 * None` must reach the substitution as the marker it is, or the marker leaks.
 */
function pythonReturnFactAsReceiver(returned: TypeRef | undefined): TypeRef | undefined {
  return typeRefReceiverForm(returned);
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
 * The result funnels through {@link pythonSubstituteSelfReturn} (bd
 * tea-rags-mcp-1v12o.1.6, E5.1b). `x = CustomerRepository.from_session(s)`
 * binds `x` to a `CustomerRepository`, never to the `RepositoryBase` that
 * declared the classmethod, and `x = obj.with_org()` binds it to `obj`'s own
 * type. The MRO walk substitutes on the arm it answers from; doing it HERE too
 * is what makes the marker unreachable from the binding path whatever a future
 * arm reads. A `container` / `union` receiver contributes no name and yields
 * nothing, which is what `memberTypeOf` already answered for one.
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
  if (receiverType.form !== "class" && receiverType.form !== "instance") return undefined;
  const returned = ports.memberTypeOf(receiverType, callee.slice(cut + 1), ctx);
  return pythonSubstituteSelfReturn(returned, receiverType.name);
}
