/**
 * Python's member-return-type reads: the owner -> ancestors walk through the
 * kernel `MemberReturnTypeResolver`, the field-call-result tier, and the
 * call-result binding (bd tea-rags-mcp-m99j1.1.29, the K6 hub cut).
 *
 * Extracted verbatim from `strategies/shared.ts`, which re-exports every
 * exported name so existing import paths keep working. Imports the addressing
 * leaf `python-type-addressing.js` and the kernel, never `strategies/shared.ts`.
 */

import { createIdentifierRecord, identifierEntry } from "../../../../contracts/identifier-record.js";
import type { CallContext, LocalBinding, SymbolDefinition } from "../../../../contracts/types/codegraph.js";
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
import { isPythonFrameworkAnswerClass, pythonVocabularyFor } from "../vocabulary/frameworks/index.js";
import { PYTHON_SELF_RETURN } from "../walker/passes/python-type-annotation.js";
import { pythonMemberReturnKey, pythonModuleReturnKey } from "../walker/passes/python-type-channels.js";
import { placePythonClassSpelling } from "./python-ancestor-policy.js";
import type { PythonImportFileMapper } from "./python-import-file-mapper.js";
import {
  findPythonImportBinding,
  isPythonPlacedClassKey,
  lastSegment,
  parsePythonClassKey,
  pythonAliasedClassKey,
  pythonBoundClassKey,
  pythonImportBoundFile,
  pythonTypeRefClassKey,
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
  // A return arm the reader already placed is its own key (bd tea-rags-mcp-m99j1.1.55).
  if (isPythonPlacedClassKey(bareType)) return bareType;
  const bare = lastSegment(bareType);
  // A framework answer says which module declares it (bd tea-rags-mcp-m99j1.1.45):
  // neither the caller's own namesake nor an import alias can stand in for it.
  if (isPythonFrameworkAnswerClass(bareType)) return pythonTypeRefClassKey(bareType, ctx, mapper);
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
 *
 * This is the CALL read (`obj.member(…)`); {@link pythonInheritedAttributeType}
 * is the same walk for `obj.member` with no call — see {@link PythonMemberAccess}.
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
  return pythonMemberTypeThroughMro(bareType, member, "call", form, ctx, mapper, linearizer, args);
}

/**
 * {@link pythonInheritedMemberType} for an ATTRIBUTE read — `obj.member` with
 * no call (bd tea-rags-mcp-m99j1.1.20). Same walk, same channels, except that a
 * member the run knows as a PLAIN method answers nothing: reading it yields a
 * bound method, not its return.
 */
export function pythonInheritedAttributeType(
  bareType: string,
  member: string,
  form: "class" | "instance",
  ctx: CallContext,
  mapper: PythonImportFileMapper,
  linearizer: AncestorLinearizer<CallContext> | undefined,
  args?: readonly TypeRef[],
): TypeRef | undefined {
  return pythonMemberTypeThroughMro(bareType, member, "attribute", form, ctx, mapper, linearizer, args);
}

function pythonMemberTypeThroughMro(
  bareType: string,
  member: string,
  access: PythonMemberAccess,
  form: "class" | "instance",
  ctx: CallContext,
  mapper: PythonImportFileMapper,
  linearizer: AncestorLinearizer<CallContext> | undefined,
  args: readonly TypeRef[] | undefined,
): TypeRef | undefined {
  const declared = pythonDeclaredMemberType(bareType, member, access, form, ctx, mapper, linearizer, args);
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

/**
 * How a member is REACHED, which in Python decides what it yields (P3, bd
 * tea-rags-mcp-m99j1.1.20).
 *
 *   - `"call"` — `obj.m(…)`: a method's declared return, a field's type, or a
 *     framework verb's result. Unchanged from before the split.
 *   - `"attribute"` — `obj.m`: what the attribute HOLDS. A field (a descriptor
 *     `@property` / `@cached_property` is recorded as one by the walker's
 *     descriptor pass) or a framework-synthesized attribute, never the return
 *     of a def the symbol table declares under that spelling: on a plain method
 *     `obj.m` is a bound method, so typing it as its return would pin the next
 *     hop on a class the value is not. A return fact NO def stands behind is
 *     still read — nothing says it belongs to a method.
 */
export type PythonMemberAccess = "attribute" | "call";

/** {@link pythonInheritedMemberType} minus its call-result tier — the pre-E4.6c body. */
function pythonDeclaredMemberType(
  bareType: string,
  member: string,
  access: PythonMemberAccess,
  form: "class" | "instance",
  ctx: CallContext,
  mapper: PythonImportFileMapper,
  linearizer: AncestorLinearizer<CallContext> | undefined,
  args?: readonly TypeRef[],
): TypeRef | undefined {
  const resolver = new MemberReturnTypeResolver(pythonMemberReturnTypePorts(ctx, mapper, linearizer, access));
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
  access: PythonMemberAccess,
): MemberReturnTypePorts {
  let classKey: string | null | undefined;
  // The owner's class key, computed at most once. The owner is the only class
  // read without a key, so every caller passes the same name.
  const ownerClassKey = (bareType: string): string | null => {
    if (classKey === undefined) classKey = pythonReceiverClassKey(bareType, ctx, mapper);
    return classKey;
  };
  // Addressing the class costs symbol-table work, so it is deferred until
  // something can read the answer: a run carrying neither the run-global field
  // channel nor a linearizer is the pre-seam path, unchanged.
  const receiverClassKey = (bareType: string): string | null => {
    // A placed key costs nothing to address, so the perf gate does not apply.
    if (isPythonPlacedClassKey(bareType)) return bareType;
    if (linearizer === undefined && ctx.classFieldTypesByClassKey === undefined) return null;
    return ownerClassKey(bareType);
  };
  /** `definingFile` is the file the class lives in when the read knows it (an MRO key). */
  const onClass = (
    owner: NominalTypeRef,
    shortName: string,
    classFq: string,
    member: string,
    definingFile?: string,
  ): TypeRef | null => {
    const fieldType = identifierEntry(identifierEntry(ctx.classFieldTypes, shortName), member);
    if (fieldType !== undefined) return { form: "instance", name: fieldType };
    const separator = owner.form === "class" ? "." : "#";
    const memberFq = `${classFq}${separator}${member}`;
    // An attribute read of a def the run declares is a bound method: its return
    // is its CALL's. A descriptor def never gets here — the walker recorded it
    // as the field read above.
    if (access === "attribute" && ctx.symbolTable.lookup(memberFq).length > 0) return null;
    const declaringFiles = [...new Set(ctx.symbolTable.lookup(memberFq).map((def) => def.relPath))];
    const factFile = definingFile ?? pythonMemberDeclaringFile(declaringFiles, () => ownerClassKey(classFq));
    if (factFile === null) return null;
    const recorded = pythonMemberReturnFact(memberFq, factFile, declaringFiles, ctx);
    const definingFiles = factFile === undefined ? declaringFiles : [factFile];
    const returned = pythonReturnFactAsReceiver(pythonPlacedReturnFact(recorded, definingFiles, ctx, mapper));
    return pythonSubstituteSelfReturn(returned, owner.name) ?? null;
  };
  /** The owner's own read — through its key's parts when a reader placed it. */
  const onOwner = (owner: NominalTypeRef, member: string): TypeRef | null => {
    const placed = isPythonPlacedClassKey(owner.name) ? parsePythonClassKey(owner.name) : null;
    return placed === null
      ? onClass(owner, owner.name, owner.name, member)
      : onClass(owner, lastSegment(placed.classFq), placed.classFq, member, placed.relPath);
  };
  const byClassKey = (key: string, member: string): TypeRef | null => {
    const fieldType = identifierEntry(identifierEntry(ctx.classFieldTypesByClassKey, key), member);
    return fieldType === undefined ? null : { form: "instance", name: fieldType };
  };
  return {
    declaredReturnType: (owner, member) => {
      const own = onOwner(owner, member);
      if (own !== null) return own;
      const key = receiverClassKey(owner.name);
      if (key === null) return null;
      const byKey = byClassKey(key, member);
      // A placed owner's own class was already read through its key above.
      if (byKey !== null || !isPythonFrameworkAnswerClass(owner.name)) return byKey;
      // A framework answer's module spelling is no channel key, so its own
      // class is read through the key it was placed at — as an ancestor is.
      const parsed = parsePythonClassKey(key);
      return parsed === null
        ? null
        : onClass(owner, lastSegment(parsed.classFq), parsed.classFq, member, parsed.relPath);
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
      return parsed === null
        ? null
        : onClass(owner, lastSegment(parsed.classFq), parsed.classFq, member, parsed.relPath);
    },
    frameworkReturnType: (owner, member) => pythonFrameworkReturnType(owner, member, access, ctx, mapper, linearizer),
  };
}

/**
 * The file whose fact a member read takes when the read does not already know
 * the declaring file (bd tea-rags-mcp-m99j1.1.35): the one file declaring the
 * member, else the file of the RECEIVER's own class key — the narrowing that
 * keeps django's four `DatabaseWrapper#create_cursor` apart. `undefined` = no
 * def known (the read is as before); `null` = several files declare the member
 * and the receiver's class is none of them, so no fact belongs to it.
 *
 * `ownerKey` is deferred: addressing the class costs symbol-table work only
 * the namesake case needs.
 */
function pythonMemberDeclaringFile(
  declaringFiles: readonly string[],
  ownerKey: () => string | null,
): string | null | undefined {
  if (declaringFiles.length <= 1) return declaringFiles[0];
  const key = ownerKey();
  const parsed = key === null ? null : parsePythonClassKey(key);
  return parsed !== null && declaringFiles.includes(parsed.relPath) ? parsed.relPath : null;
}

/**
 * `memberFq`'s return fact AS `factFile` WROTE IT (bd tea-rags-mcp-m99j1.1.35):
 * its file-qualified key first, then the bare key — but the bare key only when
 * no OTHER file declares the member. The run keeps the bare key's first writer,
 * so with a namesake it may be another file's answer, and a guess at whose is
 * the fabrication this exists to stop. An index whose walker predates the
 * qualified key keeps every unambiguous read.
 */
function pythonMemberReturnFact(
  memberFq: string,
  factFile: string | undefined,
  declaringFiles: readonly string[],
  ctx: CallContext,
): TypeRef | undefined {
  if (factFile !== undefined) {
    const qualified = identifierEntry(ctx.structuredReturnTypes, pythonMemberReturnKey(factFile, memberFq));
    if (qualified !== undefined) return qualified;
  }
  return declaringFiles.every((declaring) => declaring === factFile)
    ? identifierEntry(ctx.structuredReturnTypes, memberFq)
    : undefined;
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
 *
 * The verbs are methods, so an ATTRIBUTE read (`qs.filter` with no call) skips
 * them and reaches the synthesized attributes only — see {@link PythonMemberAccess}.
 */
function pythonFrameworkReturnType(
  owner: NominalTypeRef,
  member: string,
  access: PythonMemberAccess,
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
      access === "call" &&
      vocabulary.selfReturning.has(member) &&
      (isRelationClass || pythonDescendsFromAny(owner.name, vocabulary.relationClasses, ctx, mapper, linearizer))
    ) {
      return owner;
    }
    if (isRelationClass) {
      // Every relation-class answer is a verb's, so an attribute read gets none.
      if (access === "attribute" || model === undefined) continue;
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
  return pythonReturnFactAsReceiver(pythonModuleReturnFact(callee, ctx, mapper, unbound));
}

/**
 * {@link pythonModuleReturnType}'s fact AS RECORDED — before the receiver
 * collapse, which drops a tuple (it is read by position, never dispatched
 * on). The one reader that wants the raw form is a tuple-unpacking target
 * (`a, b = make_pair()`, bd tea-rags-mcp-m99j1.1.18), which takes a position
 * out of it.
 */
export function pythonModuleReturnFact(
  callee: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
  unbound: PythonUnboundCalleeRule,
): TypeRef | undefined {
  const defs = lookupPythonSymbolsByShortName(ctx, callee, { role: "callee" }).filter((def) => def.scope.length === 0);
  const file = pythonModuleDefFile(callee, defs, ctx, mapper, unbound);
  if (file === null) return undefined;
  return pythonPlacedReturnFact(ctx.structuredReturnTypes?.[pythonModuleReturnKey(file, callee)], [file], ctx, mapper);
}

/**
 * A recorded return fact with every nominal arm placed by the file that WROTE
 * the return (bd tea-rags-mcp-m99j1.1.55), never by the caller's file.
 *
 * `BaseDatabaseWrapper#cursor` in `base/base.py` returns
 * `db.backends.utils::CursorDebugWrapper | db.backends.utils::CursorWrapper`;
 * read from `mysql/base.py`, which declares its own `CursorWrapper`, the bare
 * name landed on mysql's class, and from a backend importing neither it landed
 * nowhere — a partial union that dispatched as one confident edge. Each arm is
 * placed with the base-spelling rules and re-spelled as the class key
 * `relPath::classFq`. An arm no defining file can place, or that the defining
 * files place differently, KILLS the whole fact: a partial union is the
 * fabrication this exists to stop. A SINGLE external arm stays bare, so the
 * typed-external verdict downstream still applies to it; in a union it kills,
 * since a call the library may receive is no edge to fan.
 *
 * A bare arm reads as before unless the caller's own file declares a namesake —
 * see {@link pythonPlacedBareArmName}.
 */
export function pythonPlacedReturnFact(
  recorded: TypeRef | undefined,
  definingFiles: readonly string[],
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): TypeRef | undefined {
  if (recorded === undefined) return undefined;
  const placeArm = (arm: TypeRef, inUnion: boolean): TypeRef | null => {
    if (arm.form !== "instance") return arm;
    const name = pythonPlacedArmName(arm.name, inUnion, definingFiles, ctx, mapper);
    if (name === null) return null;
    return name === arm.name ? arm : { ...arm, name };
  };
  if (recorded.form === "instance") return placeArm(recorded, false) ?? undefined;
  if (recorded.form !== "union") return recorded;
  const members: TypeRef[] = [];
  for (const member of recorded.members) {
    const placed = placeArm(member, true);
    if (placed === null) return undefined;
    members.push(placed);
  }
  return { ...recorded, members };
}

/**
 * The union a union-annotated parameter or local states (`x: A | B`, bd
 * tea-rags-mcp-m99j1.1.30), every arm placed by the file that wrote the
 * annotation — the caller's own — with the return-arm rules of
 * {@link pythonPlacedReturnFact}.
 *
 * Three answers, because the callers need all three: `undefined` when the
 * binding is NOT a multi-arm union (the caller keeps its own `type` reading,
 * which is how `Optional[A]` stays `A`), `null` when the union dies, and the
 * placed union otherwise. It dies on ANY arm that names no project class — one
 * the reader cannot place, a library class, a builtin — because the surviving
 * arms would then fan as the whole receiver: a partial union is the
 * fabrication.
 */
export function pythonPlacedBindingUnion(
  binding: LocalBinding,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): TypeRef | null | undefined {
  const stated = typeRefReceiverForm(binding.typeRef);
  if (stated?.form !== "union") return undefined;
  const placed = pythonPlacedReturnFact(stated, [ctx.callerFile], ctx, mapper);
  if (placed?.form !== "union") return null;
  for (const arm of placed.members) {
    if (arm.form === "nil") continue;
    if (arm.form !== "instance" || resolveTypeFile(arm.name, ctx, mapper) === null) return null;
  }
  return placed;
}

/**
 * The chunk's local bindings as every Python reader may see them: a union
 * binding the resolver cannot read is REMOVED, as if the walker had never
 * published it (bd tea-rags-mcp-m99j1.1.30 regression).
 *
 * {@link pythonPlacedBindingUnion} answers `null` for two different findings.
 * An arm that places to a library or builtin class is EVIDENCE — the receiver
 * may be no project class at all — so the binding stays and keeps counting as
 * a fact (polar's `template: Template | str`, jinja, must not fan or be
 * guessed). An arm nothing places — a project type ALIAS, an unresolved name —
 * is ABSENCE of evidence, and a binding standing on it must change nothing:
 * httpx's `timeout: TimeoutTypes | UseClientDefault` used to reach
 * `Timeout#as_dict` through the naming-convention guess, and the guess, the
 * receiver-kind classifier and every binding-presence gate read PRESENCE. A
 * library arm beside an unknown one is still evidence.
 *
 * Returns the input map by identity when nothing is hidden.
 */
export function pythonVisibleLocalBindings(
  localBindings: Record<string, LocalBinding[]> | undefined,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): Record<string, LocalBinding[]> | undefined {
  return withoutBindings(localBindings, (binding) => pythonBindingUnionIsUnreadable(binding, ctx, mapper));
}

/**
 * The visible bindings as the call-site CLASSIFIERS read them (bd
 * tea-rags-mcp-m99j1.1.65): every union binding whose union dies is removed.
 *
 * After {@link pythonVisibleLocalBindings} the only dead unions left are the
 * EVIDENCE ones — an arm places to a library or builtin class (httpx
 * `value: str | bytes`, polar's jinja `template: Template | str`). Resolution
 * keeps reading them, so nothing guesses or fans onto a project namesake. But
 * they type no class a call could reach, and the receiver kind and the miss
 * buckets read presence and typedness: `value.encode()` is the `dynamic` core
 * homonym it was before m99j1.1.30 published the binding, not a `localVar`
 * in-project miss. A union every arm of which places to a project class is a
 * type and stays.
 *
 * Returns the input map by identity when nothing is hidden.
 */
export function pythonClassifierLocalBindings(
  localBindings: Record<string, LocalBinding[]> | undefined,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): Record<string, LocalBinding[]> | undefined {
  return withoutBindings(localBindings, (binding) => pythonPlacedBindingUnion(binding, ctx, mapper) === null);
}

/** `localBindings` minus every binding `hide` names, a name left with none deleted; the input by identity when nothing goes. */
function withoutBindings(
  localBindings: Record<string, LocalBinding[]> | undefined,
  hide: (binding: LocalBinding) => boolean,
): Record<string, LocalBinding[]> | undefined {
  if (localBindings === undefined) return undefined;
  let kept: Record<string, LocalBinding[]> | undefined;
  for (const [name, bindings] of Object.entries(localBindings)) {
    const readable = bindings.filter((binding) => !hide(binding));
    if (readable.length === bindings.length) continue;
    kept ??= Object.assign(createIdentifierRecord<LocalBinding[]>(), localBindings);
    if (readable.length === 0) delete kept[name];
    else kept[name] = readable;
  }
  return kept ?? localBindings;
}

/** A union binding whose union dies with no library / builtin arm to stand on — see {@link pythonVisibleLocalBindings}. */
function pythonBindingUnionIsUnreadable(
  binding: LocalBinding,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): boolean {
  if (pythonPlacedBindingUnion(binding, ctx, mapper) !== null) return false;
  const stated = typeRefReceiverForm(binding.typeRef);
  if (stated?.form !== "union") return false;
  return !stated.members.some(
    (arm) =>
      arm.form === "instance" &&
      !isPythonPlacedClassKey(arm.name) &&
      placePythonClassSpelling(arm.name, ctx.callerFile, ctx, mapper).kind === "external",
  );
}

/**
 * A BARE arm — the marker, a framework answer, an older index, an annotation,
 * a same-file class the walker leaves unqualified (`return self`) — reads as
 * before, with one exception: the caller's own file declares a NAMESAKE class
 * the bare name would bind to, while the one file defining the member declares
 * the arm itself. `CursorWrapper#__enter__` returns `self` in `utils.py`, and
 * read from `mysql/base.py` the bare `CursorWrapper` landed on mysql's own
 * class; that arm is placed by the declaring file.
 *
 * The same placement applies where the caller's own reading names NO file
 * (bd tea-rags-mcp-m99j1.1.67): `base/base.py` imports the `utils` module, not
 * the class, and with mysql's namesake in the run the bare name read from there
 * was ambiguous, so `with self.cursor() as cursor` stayed untyped. Only that
 * silence is replaced — a bare name the caller already places reads as before.
 */
function pythonPlacedBareArmName(
  name: string,
  definingFiles: readonly string[],
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): string {
  if (definingFiles.length !== 1 || definingFiles[0] === ctx.callerFile) return name;
  const classKey = pythonBoundClassKey(name, definingFiles[0], ctx);
  if (classKey === null) return name;
  if (pythonBoundClassKey(name, ctx.callerFile, ctx) !== null) return classKey;
  return resolveTypeFile(name, ctx, mapper) === null ? classKey : name;
}

/** One arm's name → its placed key, its bare name, or null (kill). See {@link pythonPlacedReturnFact}. */
function pythonPlacedArmName(
  name: string,
  inUnion: boolean,
  definingFiles: readonly string[],
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): string | null {
  if (isPythonPlacedClassKey(name)) return name;
  if (!name.includes("::")) return pythonPlacedBareArmName(name, definingFiles, ctx, mapper);
  // No def stands behind the fact: nothing to place by, so it reads as it always did.
  if (definingFiles.length === 0) return lastSegment(name);
  let placed: string | null = null;
  for (const file of definingFiles) {
    const verdict = placePythonClassSpelling(name, file, ctx, mapper);
    const answer =
      verdict.kind === "project"
        ? verdict.classKey
        : verdict.kind === "external" && !inUnion
          ? lastSegment(name)
          : null;
    if (answer === null || (placed !== null && placed !== answer)) return null;
    placed = answer;
  }
  return placed;
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
  if (head === "self") return pythonDeclaredMemberType(ownerType, method, "call", "instance", ctx, mapper, linearizer);
  const bareHead = lastSegment(head);
  if (!PYTHON_CLASS_NAME.test(bareHead)) return undefined;
  // Gated on the class resolving into the project, exactly as the chain's own
  // class-head seed is: a capitalised name an import took from a library is a
  // coincidence of spelling, not evidence.
  if (resolveTypeFile(bareHead, ctx, mapper) === null && pythonAliasedClassKey(bareHead, ctx, mapper) === null) {
    return undefined;
  }
  return pythonDeclaredMemberType(bareHead, method, "call", "class", ctx, mapper, linearizer);
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
