/**
 * The receiver-fold hops the external signature table answers (bd
 * tea-rags-mcp-s3i8m.7 T3b). The hand hops in `std-type-hops.ts` know a
 * closed set of std shapes; the table knows every public inherent member,
 * alias and closed associated type of std and the dependencies:
 *   - a member an external receiver declares inherently answers its declared
 *     return, impl generics substituted from the receiver's arguments, `Self`
 *     the receiver, aliases expanded (`Mutex<Store>.lock()` → `Result<MutexGuard<Store>, …>`);
 *   - a member an external type with a `Deref::Target` does not answer itself
 *     (inherent `self` method or trait impl member) is handed to that target
 *     (`MutexGuard<Store>.m()` → `Store`), the contract the hand table encodes
 *     for `Box` / `Arc` / `Rc`, which keep their hand reading.
 * Every answer is additive: no table, an ambiguous or unstable member, or a
 * project type sharing a short name in the answer leaves the old read in
 * place. A deref target the fold cannot spell is `"unprovable"` — a typed miss
 * through it never proves anything.
 */

import type { CallContext } from "../../../../contracts/types/codegraph.js";
import type {
  RustExternalSignatureTable,
  RustExternalTypeExpr,
  TypeRef,
} from "../../../../contracts/types/language.js";
import type { NominalTypeRef } from "../../kernel/index.js";
import {
  rustStdOwnedForms,
  rustStdPrimitiveTypes,
  rustStdTraitMemberReturns,
  rustTextIsStdPreludeType,
  rustTextIsStdSmartPointer,
} from "../vocabulary/std-prelude.js";
import { rustExternalSignaturesOf } from "./resolve-environment.js";
import { projectDeclaresType, rustStdSmartPointerTarget } from "./std-type-hops.js";
import {
  lookupRustSymbolsByShortName,
  RUST_OWN_CRATE_PATH_HEADS,
  rustImportBindings,
  rustImportIsExternal,
  rustPathHeadIsExternal,
} from "./strategies/shared.js";

const RUST_STD_ROOTS: ReadonlySet<string> = new Set(["std", "core", "alloc"]);
const MAX_ALIAS_EXPANSIONS = 4;

/**
 * The std module of each hand std type the fold carries by its bare spelling
 * (`rustStdTypeRef` reads it as std without a `use`). `Ordering` is left out:
 * `std::cmp` and `std::sync::atomic` both declare one.
 */
const RUST_HAND_STD_MODULES: ReadonlyMap<string, string> = new Map([
  ["String", "std::string"],
  ["Vec", "std::vec"],
  ...["VecDeque", "HashMap", "HashSet", "BTreeMap", "BTreeSet", "BinaryHeap", "LinkedList"].map(
    (name): [string, string] => [name, "std::collections"],
  ),
  ["Box", "std::boxed"],
  ["Rc", "std::rc"],
  ["Arc", "std::sync"],
  ["Cell", "std::cell"],
  ["RefCell", "std::cell"],
  ["Mutex", "std::sync"],
  ["RwLock", "std::sync"],
  ["Once", "std::sync"],
  ["Cow", "std::borrow"],
  ["Path", "std::path"],
  ["PathBuf", "std::path"],
  ["Instant", "std::time"],
  ["Duration", "std::time"],
  ["SystemTime", "std::time"],
  ["Option", "std::option"],
  ["Result", "std::result"],
]);

/**
 * A tuple element the table spells but a project namesake silences (an empty
 * union, which no hop reads). Only a destructuring pattern sees it, and its
 * tuple step answers `undefined` for it — never a typed receiver.
 */
export const RUST_UNPROVEN_TUPLE_ELEMENT: TypeRef = Object.freeze({ form: "union", members: [] });

/** What a table `Deref` hop does with a member: the type answers it, hands it to a target, or hides the target. */
export type RustExternalDerefHop = { readonly target: NominalTypeRef } | "own" | "unprovable";

/**
 * The table's canonical path of an unplaced fold type: the spelling read
 * through the caller's `use` declarations, else a hand std name's std module.
 * A project type of the same short name vetoes.
 */
function rustExternalTypePath(
  recv: TypeRef,
  ctx: CallContext,
  signatures: RustExternalSignatureTable,
): string | undefined {
  if (recv.form !== "instance" || recv.name.includes(".rs::")) return undefined;
  if (projectDeclaresType(ctx, rustShortName(recv.name))) return undefined;
  const found = signatures.canonicalType(
    recv.name,
    ctx.imports.map((imp) => imp.importText),
  );
  if (found !== undefined) return found;
  const module = RUST_HAND_STD_MODULES.get(recv.name);
  return module === undefined ? undefined : signatures.canonicalType(`${module}::${recv.name}`, []);
}

function rustShortName(name: string): string {
  return name.split("::").at(-1) ?? name;
}

/**
 * Step 4: the declared return of the stable, unambiguous inherent `self`
 * method `member` of the external receiver `recv`, or `undefined`. A project
 * symbol implementing `member` on the type's short name may be the method
 * Rust probes first, so it silences the table.
 */
export function rustExternalMemberReturnType(recv: TypeRef, member: string, ctx: CallContext): TypeRef | undefined {
  const signatures = rustExternalSignaturesOf(ctx);
  if (signatures === undefined || recv.form !== "instance") return undefined;
  const typePath = rustExternalTypePath(recv, ctx, signatures);
  if (typePath === undefined) return undefined;
  const found = signatures.inherentMember(typePath, member);
  if (found === undefined || found === "ambiguous" || !found.stable || found.selfKind === "none") return undefined;
  if (found.returns === undefined || rustProjectImplementsMemberOn(ctx, rustShortName(recv.name), member)) {
    return undefined;
  }
  return rustExternalTypeOf(found.returns, recv, found.methodGenericParameters, ctx, signatures);
}

/**
 * `ExtType::assoc(..)` (bd s3i8m.7 T3c): the declared return of the stable,
 * unambiguous associated function `assoc` (no `self`) of the external type
 * `spelling` names from the caller's file, `Self` the bare type. A project
 * symbol implementing `assoc` on the type's short name silences the table.
 */
export function rustExternalAssociatedCallType(spelling: string, assoc: string, ctx: CallContext): TypeRef | undefined {
  const signatures = rustExternalSignaturesOf(ctx);
  if (signatures === undefined) return undefined;
  const typePath = rustExternalTypePath({ form: "instance", name: spelling }, ctx, signatures);
  if (typePath === undefined) return undefined;
  if (rustProjectImplementsMemberOn(ctx, rustShortName(spelling), assoc)) return undefined;
  const recv: TypeRef = { form: "instance", name: typePath };
  const found = signatures.inherentMember(typePath, assoc);
  // No inherent `default`: the path call is `Default::default`, whose return is `Self`.
  if (found === undefined && assoc === "default") return rustNormalizeExternal(recv, ctx);
  if (found === undefined || found === "ambiguous" || !found.stable || found.selfKind !== "none") return undefined;
  if (found.returns === undefined) return undefined;
  return rustExternalTypeOf(found.returns, recv, found.methodGenericParameters, ctx, signatures);
}

/**
 * `f(..)` / `module::f(..)` naming an external free function (bd s3i8m.7
 * T-A2): the declared return of the stable, unambiguous table function the
 * spelling reaches from the caller's file. The function's own generics are
 * unknown, so `Sender<T>` keeps its head and drops its argument. The caller
 * asks the project first; here every route that could still reach project
 * code declines:
 *   - a head bound by a non-glob `use` must be bound exactly once, by an
 *     external import, and resolves through that binding alone;
 *   - an unbound module head must be a std root or a crate name the project
 *     holds no module, directory or workspace crate for;
 *   - a bare name reached only through a glob needs an external glob and no
 *     project function of the name anywhere;
 *   - any same-file function of the name declines.
 * A destructuring reader passes `partialTuples`: a tuple element a project
 * namesake silences is {@link RUST_UNPROVEN_TUPLE_ELEMENT}, and only the
 * names bound to it stay untyped (tikv's own `Receiver` beside a std
 * `SyncSender`).
 */
export function rustExternalFreeCallType(
  spelling: string,
  ctx: CallContext,
  partialTuples = false,
): TypeRef | undefined {
  const signatures = rustExternalSignaturesOf(ctx);
  if (signatures === undefined) return undefined;
  const segments = spelling.replace(/^::/, "").split("::");
  const name = segments[segments.length - 1];
  const projectFunctions = lookupRustSymbolsByShortName(ctx, name).filter((def) => def.symbolKind === "function");
  if (projectFunctions.some((def) => def.relPath === ctx.callerFile)) return undefined;
  const path = rustExternalFunctionPath(segments, projectFunctions.length > 0, ctx, signatures);
  const found = path === undefined ? undefined : signatures.freeFunction(path);
  if (found === undefined || found === "ambiguous" || !found.stable || found.returns === undefined) return undefined;
  return rustExternalTypeOf(found.returns, undefined, found.functionGenericParameters, ctx, signatures, partialTuples);
}

/** The canonical table path `segments` names from the caller's file, through the gates of {@link rustExternalFreeCallType}. */
function rustExternalFunctionPath(
  segments: readonly string[],
  projectDeclaresFunction: boolean,
  ctx: CallContext,
  signatures: RustExternalSignatureTable,
): string | undefined {
  const [head, ...rest] = segments;
  if (RUST_OWN_CRATE_PATH_HEADS.has(head)) return undefined;
  const parsedImports = ctx.imports.map((imp) => ({
    importText: imp.importText,
    bindings: rustImportBindings(imp.importText),
  }));
  // An unparseable import may bind anything: no route is provable.
  if (parsedImports.some((parsedImport) => parsedImport.bindings === null)) return undefined;
  const bound = parsedImports.flatMap((parsedImport) =>
    (parsedImport.bindings ?? [])
      .filter((binding) => !binding.globImport && binding.localName === head)
      .map((binding) => ({ importText: parsedImport.importText, binding })),
  );
  if (bound.length > 0) {
    if (bound.length !== 1 || !rustImportIsExternal(bound[0].importText, ctx, head)) return undefined;
    const { binding } = bound[0];
    const boundPath =
      binding.sourceName === null ? binding.moduleSegments : [...binding.moduleSegments, binding.sourceName];
    return signatures.canonicalFunction([...boundPath, ...rest].join("::"), []);
  }
  if (rest.length > 0) {
    const projectModule = lookupRustSymbolsByShortName(ctx, head).some(
      (def) => def.relPath === ctx.callerFile && def.symbolKind === "module",
    );
    return projectModule || !rustPathHeadIsExternal(head, ctx)
      ? undefined
      : signatures.canonicalFunction(segments.join("::"), []);
  }
  if (projectDeclaresFunction) return undefined;
  const globs = parsedImports
    .filter((parsedImport) => parsedImport.bindings?.some((binding) => binding.globImport) === true)
    .map((parsedImport) => parsedImport.importText);
  return globs.every((text) => rustImportIsExternal(text, ctx)) ? signatures.canonicalFunction(head, globs) : undefined;
}

/**
 * The closed std-trait return model (bd s3i8m.7 T3c, spec §3.2) on a typed
 * receiver no declared or table member answered: `to_string` → `String`,
 * `eq` → `bool`, `cmp` → `Ordering`, … whichever implementor answers. A
 * `Self` member (`clone`, `to_owned`) answers the receiver only when no deref
 * target could take it instead: `selfIsOwn` for a placed project type (the
 * caller's proof), the table's facts for an external one. A project symbol
 * implementing the member on the type, or a project namesake of the answer's
 * type, silences the model; without a table it never answers.
 */
export function rustStdTraitMemberReturnType(
  recv: TypeRef,
  member: string,
  ctx: CallContext,
  selfIsOwn = false,
): TypeRef | undefined {
  const model = rustStdTraitMemberReturns.get(member);
  const signatures = rustExternalSignaturesOf(ctx);
  if (model === undefined || signatures === undefined || recv.form !== "instance") return undefined;
  const placed = recv.name.includes(".rs::");
  const shortName = rustShortName(recv.name);
  if (rustProjectImplementsMemberOn(ctx, shortName, member)) return undefined;
  if (model !== "Self") return rustNormalizeExternal(model, ctx);
  const owned = member === "to_owned" && !placed ? rustStdOwnedForms.get(shortName) : undefined;
  if (owned !== undefined) {
    return projectDeclaresType(ctx, owned) ? undefined : rustNormalizeExternal({ form: "instance", name: owned }, ctx);
  }
  const ownsSelf = placed ? selfIsOwn : rustExternalTypeKeepsSelfMembers(recv, ctx, signatures);
  return ownsSelf ? recv : undefined;
}

/** A primitive, or a table type with no `Deref::Target` or with its own `Clone` impl, answers `clone` itself. */
function rustExternalTypeKeepsSelfMembers(
  recv: TypeRef,
  ctx: CallContext,
  signatures: RustExternalSignatureTable,
): boolean {
  if (recv.form !== "instance") return false;
  if (rustStdPrimitiveTypes.has(recv.name)) return true;
  const typePath = rustExternalTypePath(recv, ctx, signatures);
  if (typePath === undefined) return false;
  return (
    signatures.associatedType(typePath, "Deref::Target") === undefined ||
    signatures.traitImplDeclares(typePath, "clone")
  );
}

/**
 * A public field of the external receiver `recv` (bd s3i8m.7 T3c): the
 * table's declared field type, owner generics read from `recv`'s arguments
 * (`Range<Store>.start` → `Store`).
 */
export function rustExternalFieldType(recv: TypeRef, field: string, ctx: CallContext): TypeRef | undefined {
  const signatures = rustExternalSignaturesOf(ctx);
  if (signatures === undefined) return undefined;
  const typePath = rustExternalTypePath(recv, ctx, signatures);
  if (typePath === undefined) return undefined;
  const fieldType = signatures.field(typePath, field);
  return fieldType === undefined ? undefined : rustExternalTypeOf(fieldType, recv, [], ctx, signatures);
}

/**
 * Step 5: what the table's `Deref::Target` of the external receiver `recv`
 * does with `member` (a method, or a field when `access` says so), or
 * `undefined` when the table holds no target. `Box` / `Arc` / `Rc` are the
 * hand hop's ({@link rustStdSmartPointerTarget}) and never answer here.
 */
export function rustExternalDerefHop(
  recv: TypeRef,
  member: string,
  ctx: CallContext,
  access: "method" | "field" = "method",
): RustExternalDerefHop | undefined {
  if (recv.form !== "instance" || rustTextIsStdSmartPointer(recv.name)) return undefined;
  const signatures = rustExternalSignaturesOf(ctx);
  if (signatures === undefined) return undefined;
  const typePath = rustExternalTypePath(recv, ctx, signatures);
  if (typePath === undefined) return undefined;
  const target = signatures.associatedType(typePath, "Deref::Target");
  if (target === undefined) return undefined;
  if (
    access === "field" ? signatures.field(typePath, member) !== undefined : rustOwnsMethod(signatures, typePath, member)
  ) {
    return "own";
  }
  const typed = rustExternalTypeOf(target, recv, [], ctx, signatures);
  return typed?.form === "instance" ? { target: typed } : "unprovable";
}

/** The deref target a std receiver hands `member` to: the hand smart-pointer hop, else the table's. */
export function rustStdDerefTarget(
  recv: TypeRef,
  member: string,
  ctx: CallContext,
  access: "method" | "field" = "method",
): TypeRef | undefined {
  const pointee = rustStdSmartPointerTarget(recv, member);
  if (pointee !== undefined) return pointee;
  const hop = rustExternalDerefHop(recv, member, ctx, access);
  return typeof hop === "object" ? hop.target : undefined;
}

/** A method-call probe stops on the type itself: an inherent `self` method (or an ambiguous one) or a trait impl member. */
function rustOwnsMethod(signatures: RustExternalSignatureTable, typePath: string, member: string): boolean {
  const inherent = signatures.inherentMember(typePath, member);
  if (inherent === "ambiguous" || (inherent !== undefined && inherent.selfKind !== "none")) return true;
  return signatures.traitImplDeclares(typePath, member);
}

/** A project symbol declares `member` on a type of this short name (`impl Ext for MutexGuard<'_, T>`). */
export function rustProjectImplementsMemberOn(ctx: CallContext, typeName: string, member: string): boolean {
  return lookupRustSymbolsByShortName(ctx, member).some(
    (def) =>
      def.symbolId === `${typeName}#${member}` ||
      def.symbolId === `${typeName}.${member}` ||
      def.symbolId.endsWith(`::${typeName}#${member}`) ||
      def.symbolId.endsWith(`::${typeName}.${member}`),
  );
}

/**
 * A table type expression in the fold's channel: owner generics read
 * positionally from `recv`'s arguments, `Self` is `recv`, a method generic is
 * unknown, aliases expand on every head (at most four times), and a std head
 * the hand hops read by its bare name (`Option`, `Vec`, `Arc`) is shortened.
 * A bare generic nothing binds, or a head whose short name the project
 * declares, answers `undefined`; an argument nothing binds drops the
 * argument list and keeps the head. A free function has no receiver: its
 * `Self` is unknown like any unbound generic.
 */
function rustExternalTypeOf(
  typeExpr: RustExternalTypeExpr,
  recv: TypeRef | undefined,
  methodGenerics: readonly string[],
  ctx: CallContext,
  signatures: RustExternalSignatureTable,
  partialTuples = false,
): TypeRef | undefined {
  const receiverArgs = recv?.form === "instance" ? recv.args : undefined;
  const bound = rustSubstitute(typeExpr.type, (name) => {
    if (name === "Self") return recv;
    const position = typeExpr.genericParameters.indexOf(name);
    if (position >= 0) return receiverArgs?.[position];
    return methodGenerics.includes(name) ? undefined : null;
  });
  const expanded = bound === undefined ? undefined : rustExpandAliases(bound, signatures, 0);
  return expanded === undefined ? undefined : rustNormalizeExternal(expanded, ctx, partialTuples);
}

/** `bind` answers a type for a parameter, `undefined` for an unknown one, `null` for a name that is no parameter. */
function rustSubstitute(type: TypeRef, bind: (name: string) => TypeRef | undefined | null): TypeRef | undefined {
  if (type.form === "tuple") {
    const elements = type.elements.map((element) => rustSubstitute(element, bind));
    return elements.every((element) => element !== undefined) ? { form: "tuple", elements } : undefined;
  }
  if (type.form !== "instance") return undefined;
  const bound = bind(type.name);
  if (bound !== null) return bound;
  return rustWithKnownArgs(
    type.name,
    type.args?.map((arg) => rustSubstitute(arg, bind)),
  );
}

function rustWithKnownArgs(name: string, args: readonly (TypeRef | undefined)[] | undefined): TypeRef {
  const known = args?.every((arg) => arg !== undefined) ? (args as TypeRef[]) : undefined;
  return known === undefined || known.length === 0
    ? { form: "instance", name }
    : { form: "instance", name, args: known };
}

function rustExpandAliases(
  type: TypeRef,
  signatures: RustExternalSignatureTable,
  expansions: number,
): TypeRef | undefined {
  if (type.form === "tuple") {
    const elements = type.elements.map((element) => rustExpandAliases(element, signatures, expansions));
    return elements.every((element) => element !== undefined) ? { form: "tuple", elements } : undefined;
  }
  if (type.form !== "instance") return type;
  const alias = signatures.alias(type.name);
  if (alias !== undefined) {
    if (expansions >= MAX_ALIAS_EXPANSIONS) return undefined;
    const target = rustSubstitute(alias.type, (name) => {
      const position = alias.genericParameters.indexOf(name);
      return position >= 0 ? type.args?.[position] : null;
    });
    return target === undefined ? undefined : rustExpandAliases(target, signatures, expansions + 1);
  }
  return rustWithKnownArgs(
    type.name,
    type.args?.map((arg) => rustExpandAliases(arg, signatures, expansions)),
  );
}

/**
 * Shorten hand std heads; any external head a project type shadows by short
 * name silences the answer. With `partialTuples` a silenced tuple element is
 * {@link RUST_UNPROVEN_TUPLE_ELEMENT} instead, so its siblings stay typed.
 */
function rustNormalizeExternal(type: TypeRef, ctx: CallContext, partialTuples = false): TypeRef | undefined {
  if (type.form === "tuple") {
    const elements = type.elements.map(
      (element) =>
        rustNormalizeExternal(element, ctx, partialTuples) ?? (partialTuples ? RUST_UNPROVEN_TUPLE_ELEMENT : undefined),
    );
    return elements.every((element) => element !== undefined) ? { form: "tuple", elements } : undefined;
  }
  if (type.form !== "instance" || type.name.includes(".rs::")) return type;
  const shortName = rustShortName(type.name);
  const external = type.name.includes("::") || rustTextIsStdPreludeType(type.name);
  if (external && projectDeclaresType(ctx, shortName)) return undefined;
  const stdRooted = RUST_STD_ROOTS.has(type.name.split("::")[0]);
  const name = stdRooted && rustTextIsStdPreludeType(shortName) ? shortName : type.name;
  const args = type.args?.map((arg) => rustNormalizeExternal(arg, ctx, partialTuples));
  if (args?.some((arg) => arg === undefined)) return undefined;
  return rustWithKnownArgs(name, args);
}

/**
 * Whether `member` on the typed std receiver `recv` is proven std: the
 * receiver is a std (or dependency) type, a member its table `Deref` hands on
 * is judged on the target (a project target proves nothing; an unspellable one keeps the type's own verdict), and
 * no project symbol implements `member` on any type the walk passed.
 */
export function rustStdTerminalTargetsExternal(recv: TypeRef, member: string, ctx: CallContext): boolean {
  let current = recv;
  for (let hops = 0; hops < 3; hops++) {
    if (current.form !== "instance" || current.name.includes(".rs::")) return false;
    if (rustStdSmartPointerTarget(current, member) !== undefined) return false;
    const projectImpl = rustProjectImplementsMemberOn(ctx, rustShortName(current.name), member);
    const hop = rustExternalDerefHop(current, member, ctx);
    // A target the fold cannot spell (`Cow` with its argument dropped) keeps
    // the pre-table verdict on the type itself.
    if (hop === undefined || hop === "own" || hop === "unprovable") return !projectImpl;
    // A project impl on the type itself is probed before its target; a std
    // target is judged in turn.
    if (projectImpl) return false;
    current = hop.target;
  }
  return false;
}
