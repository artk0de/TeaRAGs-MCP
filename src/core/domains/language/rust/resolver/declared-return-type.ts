import { identifierEntry } from "../../../../contracts/identifier-record.js";
import type { CallContext, SymbolDefinition, TypeDeclarationFact } from "../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../contracts/types/language.js";
import { MemberReturnTypeResolver, RunScopedMemo, type NominalTypeRef } from "../../kernel/index.js";
import { rustTextIsStdPreludeType } from "../vocabulary/std-prelude.js";
import { rustDeclaringFileImportOf, rustPlaceTypeThroughDeclaringFile } from "./declaring-file-type.js";
import {
  rustExternalMemberReturnType,
  rustStdDerefTarget,
  rustStdTraitMemberReturnType,
} from "./external-type-hops.js";
import { rustCrateRootOf, rustCrateTypeMembers, rustCrateUniqueType } from "./rust-crate-scope.js";
import {
  rustNameBoundByExternalImport,
  rustStdAccessorReturnType,
  rustStdTypeRef,
  rustStdUnwrapType,
} from "./std-type-hops.js";
import { lookupRustSymbolsByShortName, rustFollowReexports, rustImportBindings } from "./strategies/shared.js";

/** File-qualified nominal identity is kept inside the existing TypeRef channel, never a bare global namesake. */
export function resolveRustNominalType(nominalType: TypeRef, ctx: CallContext): NominalTypeRef | undefined {
  if (nominalType.form !== "instance" && nominalType.form !== "class") return undefined;
  const { name } = nominalType;
  if (/^(?:::)?(?:std|core|alloc)::/.test(name)) return undefined;
  if (!name.includes(".rs::") && rustNameBoundByExternalImport(name, ctx)) {
    // Only an EXTERNAL binding vetoes placement now. An import-bound project
    // type (`use script_bindings::Str2`) reaches the candidate lookup below,
    // where the sole-match and lexical-scope gates keep it honest — the old
    // blanket veto dropped every import-bound type from the chain fold no
    // matter where its definition lived.
    return undefined;
  }
  const shortName = name.split("::").at(-1);
  if (shortName === undefined) return undefined;
  const candidates = lookupRustSymbolsByShortName(ctx, shortName)
    .filter((def) => def.symbolKind === undefined || def.symbolKind === "class" || def.symbolKind === "enum")
    .filter((def) => def.symbolId === shortName || def.symbolId.endsWith(`::${shortName}`));
  let hit: SymbolDefinition | undefined;
  if (name.includes(".rs::")) {
    const boundary = name.indexOf(".rs::") + 3;
    const exact = candidates.filter(
      (def) => def.relPath === name.slice(0, boundary) && def.symbolId === name.slice(boundary + 2),
    );
    if (exact.length === 1) hit = exact[0];
  } else {
    // Lexical module scopes, innermost first. No suffix-based same-file tie-break.
    for (let depth = ctx.callerScope.length; depth >= 0 && hit === undefined; depth--) {
      const fq = [...ctx.callerScope.slice(0, depth), name].join("::");
      const local = candidates.filter((def) => def.relPath === ctx.callerFile && def.symbolId === fq);
      if (local.length === 1) hit = local[0];
      else if (local.length > 1) return undefined;
    }
    if (hit === undefined && candidates.length === 1 && candidates[0].symbolId === name) hit = candidates[0];
  }
  if (hit === undefined) return undefined;
  const typeArguments = nominalType.args?.map((arg) => resolveRustNominalType(arg, ctx));
  if (typeArguments?.some((arg) => arg === undefined)) return undefined;
  return {
    ...nominalType,
    name: `${hit.relPath}::${hit.symbolId}`,
    ...(typeArguments === undefined ? {} : { args: typeArguments as TypeRef[] }),
  };
}

/** Resolve a member ONLY under the fully identified owner; the old lookup keeps its own fallback outside this seam. */
export function rustExactMember(owner: NominalTypeRef, member: string, ctx: CallContext): SymbolDefinition | undefined {
  const boundary = owner.name.indexOf(".rs::");
  if (boundary < 0) return undefined;
  const relPath = owner.name.slice(0, boundary + 3);
  const fq = owner.name.slice(boundary + 5);
  const separator = owner.form === "class" ? "." : "#";
  const matches = ctx.symbolTable.lookup(`${fq}${separator}${member}`).filter((def) => def.relPath === relPath);
  if (matches.length > 0) return matches.length === 1 ? matches[0] : undefined;
  return (
    rustAliasImplMember(owner, relPath, fq, separator, member, ctx) ??
    rustCrateMember(relPath, fq, separator, member, ctx)
  );
}

/**
 * An impl block on a type alias is an impl on the aliased type: servo's
 * `impl<T> DomRoot<T> { fn as_traced }` beside `pub type DomRoot<T> =
 * Root<Dom<T>>` answers `as_traced` on a `Root<Dom<Document>>` the alias
 * expanded to. The alias lives in the owner's file and expands to the owner's
 * head; every argument it fixes (not one of its own parameters) must match
 * the owner's argument head, so `Root<Other>` never borrows it. A sole
 * candidate only.
 */
function rustAliasImplMember(
  owner: NominalTypeRef,
  relPath: string,
  fq: string,
  separator: "#" | ".",
  member: string,
  ctx: CallContext,
): SymbolDefinition | undefined {
  const shortName = (name: string): string => name.split("::").at(-1) ?? name;
  const expandsToOwner = (aliased: TypeRef, parameters: readonly string[]): boolean => {
    if (aliased.form !== "instance" && aliased.form !== "class") return false;
    if (shortName(aliased.name) !== shortName(fq)) return false;
    return (aliased.args ?? []).every((arg, index) => {
      if (arg.form === "instance" && arg.args === undefined && parameters.includes(arg.name)) return true;
      const given = owner.args?.[index];
      return (
        (arg.form === "instance" || arg.form === "class") &&
        (given?.form === "instance" || given?.form === "class") &&
        shortName(arg.name) === shortName(given.name)
      );
    });
  };
  const candidates = (ctx.typeDeclarations?.[relPath] ?? [])
    .filter(
      (fact) =>
        fact.symbolKind === "type_alias" &&
        !fact.reopens &&
        fact.aliasedType !== undefined &&
        expandsToOwner(fact.aliasedType, fact.genericParameters ?? []),
    )
    .flatMap((fact) =>
      ctx.symbolTable.lookup(`${fact.typeId}${separator}${member}`).filter((def) => def.relPath === relPath),
    );
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * The owner file's miss, asked of the owner's crate (bd tea-rags-mcp-s3i8m
 * Task 2): a type name unique in its crate owns every `T#m` / `T.m` the crate
 * declares, so an impl block in another module answers. Keyed on the short
 * type name, so an inline-module id (`ops::Peer#region`) still matches by
 * suffix. A sole candidate only.
 */
function rustCrateMember(
  relPath: string,
  fq: string,
  separator: "#" | ".",
  member: string,
  ctx: CallContext,
): SymbolDefinition | undefined {
  const typeName = fq.split("::").at(-1);
  const root = rustCrateRootOf(relPath, ctx);
  if (typeName === undefined || root === undefined) return undefined;
  if (rustCrateUniqueType(typeName, root, ctx) === undefined) return undefined;
  const candidates = rustCrateTypeMembers(typeName, separator, member, root, ctx);
  return candidates.length === 1 ? candidates[0] : undefined;
}

const RUST_MEMBER_RETURN_TYPES = new MemberReturnTypeResolver({
  declaredReturnType: (owner, member, ctx) => {
    const target = rustExactMember(owner, member, ctx);
    if (target === undefined) return null;
    const declared = ctx.structuredReturnTypes?.[`${target.relPath}::${target.symbolId}`];
    if (declared === undefined) return null;
    const ownerName = owner.name.slice(owner.name.indexOf(".rs::") + 5);
    const declaration = ctx.typeDeclarations?.[target.relPath]?.find(
      (fact) => fact.typeId === ownerName && !fact.reopens,
    );
    const substitute = (recv: TypeRef): TypeRef | undefined => {
      // A tuple return (`-> (Tx, Rx)`) is typed only when every element is
      // (bd tea-rags-mcp-s3i8m, Task 1a): a destructuring pattern indexes it.
      if (recv.form === "tuple") {
        const elements = recv.elements.map(substitute);
        return elements.every((element) => element !== undefined) ? { form: "tuple", elements } : undefined;
      }
      if (recv.form !== "instance" && recv.form !== "class") return undefined;
      // `Self` and `Self::Target`-style associated paths answer the OWNER;
      // rustDerefTarget turns the degenerate owner answer into its single
      // generic argument, which is what `type Target = T` means for a
      // one-parameter smart pointer (`Root<T>`'s `-> &Self::Target`).
      if (recv.name === "Self" || recv.name === "Self::Target") return { ...owner, form: "instance" };
      // Any other associated type (`-> Self::WriteBatch` on `impl WriteBatchExt
      // for Engine`) names an impl-chosen type, never the owner: answering the
      // owner typed tikv's `engine.write_batch()` as the engine and dropped its
      // `wb.set_sequence_number()` edge once cross-file impls answered
      // (bd tea-rags-mcp-s3i8m Task 2).
      if (recv.name.startsWith("Self::")) return undefined;
      const parameter = declaration?.genericParameters?.indexOf(recv.name) ?? -1;
      if (parameter >= 0) return owner.args?.[parameter];
      // `<T as Deref>::Target` (servo `impl<T: Deref> Deref for Root<T>`):
      // the owner's argument for `T`, dereferenced once (bd tea-rags-mcp-s3i8m).
      const projected = RUST_DEREF_TARGET_PROJECTION.exec(recv.name)?.[1];
      if (projected !== undefined) {
        const argument = owner.args?.[declaration?.genericParameters?.indexOf(projected) ?? -1];
        return argument?.form === "instance" ? rustDerefTarget(argument, ctx) : undefined;
      }
      // An argument nothing substitutes (an owner generic the receiver never
      // fixed: `-> &PeerStorage<EK, ER>` on a bare `Peer`) drops the argument
      // list and keeps the head typed — a member needing the argument then
      // declines on its own (bd tea-rags-mcp-2g2og.24).
      const substituted = recv.args?.map(substitute);
      const typeArguments = substituted?.every((arg) => arg !== undefined) ? substituted : undefined;
      const declaringCtx = { ...ctx, callerFile: target.relPath, callerScope: target.scope.slice(0, -1) };
      const withArguments = (placedHead: NominalTypeRef): TypeRef =>
        typeArguments === undefined || typeArguments.length === 0 ? placedHead : { ...placedHead, args: typeArguments };
      // Where the lexical read declines, the declaring file's own `use`
      // imports place the spelling (bd tea-rags-mcp-s3i8m letCall S4b).
      const throughImports = (): TypeRef | undefined => {
        const imported = rustPlaceTypeThroughDeclaringFile(recv.name, target.relPath, ctx);
        return imported === undefined ? undefined : withArguments({ ...imported, form: recv.form });
      };
      const head = resolveRustNominalType({ form: recv.form, name: recv.name }, declaringCtx);
      // A same-name `impl From<..> for Result<T>` declares no type: a spelling
      // the declaring file binds by `use` names the imported item (tikv's
      // re-exported `codec::Result` alias). The read is additive — where it
      // proves nothing new, the lexical read below stands, as before it existed:
      // - an import that places nothing (servo's `use style::properties::
      //   ComputedValues`, a foreign type the project extends by `impl Ext for T`);
      // - a project type placed elsewhere that the declaring file's own impl
      //   block extends (servo's `impl Node` in `node/focus.rs`): both readings
      //   name one type, and only the lexical one keeps that block's members.
      if (
        head !== undefined &&
        rustPlacedOnImplBlockOnly(head, ctx) &&
        rustDeclaringFileImportOf(recv.name, target.relPath, ctx) !== undefined
      ) {
        const imported = throughImports() ?? rustExpandProjectAlias(recv.name, substituted, target.relPath, ctx);
        const extendedHere =
          (imported?.form === "instance" || imported?.form === "class") &&
          imported.name.includes(".rs::") &&
          head.name.startsWith(`${target.relPath}::`);
        if (imported !== undefined && !extendedHere) return imported;
      }
      if (head === undefined) {
        return (
          rustStdTypeRef(recv.name, substituted, declaringCtx) ??
          throughImports() ??
          rustExpandProjectAlias(recv.name, substituted, target.relPath, ctx)
        );
      }
      if (rustPreludeOverForeignImpl(recv.name, head, target.relPath, ctx)) {
        return typeArguments === undefined || typeArguments.length === 0
          ? { form: "instance", name: recv.name }
          : { form: "instance", name: recv.name, args: typeArguments };
      }
      const placed = withArguments(head);
      // Cross-file, a lexical read is safe only for a type the DECLARING file
      // declares in its own scope: a name it bound through `use` must not land
      // on a caller-file namesake (`use external::Product` in lib.rs naming
      // main.rs's Product fabricated an edge before this constraint). Such a
      // name is placed through the declaring file's imports instead.
      if (target.relPath !== ctx.callerFile && !head.name.startsWith(`${target.relPath}::`)) {
        // An alias the declaring file imports (servo `use crate::root::DomRoot`)
        // may share its name with an `impl DomRoot<T>` block elsewhere.
        return throughImports() ?? rustExpandProjectAlias(recv.name, substituted, target.relPath, ctx);
      }
      return placed;
    };
    return substitute(declared) ?? null;
  },
  ancestorsOf: () => [],
  ancestorReturnType: () => null,
});

/**
 * Whether a std prelude spelling (`Result`, `Option`, …) the declaring file
 * neither declares nor binds by `use` was placed only onto ANOTHER file's
 * untagged `impl` block — servo's `impl MallocSizeOf for Result<T, E>` in
 * `malloc_size_of/lib.rs`, the sole project symbol named `Result` (bd
 * tea-rags-mcp-s3i8m). An impl block declares no type, so the spelling is
 * std's own.
 */
function rustPreludeOverForeignImpl(
  name: string,
  head: NominalTypeRef,
  declaringFile: string,
  ctx: CallContext,
): boolean {
  if (!rustTextIsStdPreludeType(name) || head.name.startsWith(`${declaringFile}::`)) return false;
  if (!rustPlacedOnImplBlockOnly(head, ctx)) return false;
  const bindsName = (identifierEntry(ctx.rustUseImportsByFile, declaringFile) ?? []).some(
    (importText) => rustImportBindings(importText)?.some((binding) => binding.localName === name) ?? true,
  );
  return !bindsName;
}

/** Whether a placed `head` lands only on untagged `impl` blocks: an impl declares no type. */
function rustPlacedOnImplBlockOnly(head: NominalTypeRef, ctx: CallContext): boolean {
  const boundary = head.name.indexOf(".rs::");
  if (boundary < 0) return false;
  const relPath = head.name.slice(0, boundary + 3);
  const placed = ctx.symbolTable.lookup(head.name.slice(boundary + 5)).filter((def) => def.relPath === relPath);
  return placed.length > 0 && placed.every((def) => def.symbolKind === undefined);
}

/** `<T as Deref>::Target` with the projected parameter captured. */
const RUST_DEREF_TARGET_PROJECTION =
  /^<\s*([A-Za-z_][A-Za-z0-9_]*)\s+as\s+(?:(?:::)?(?:std|core)::ops::)?Deref\s*>::Target$/;
const MAX_PROJECT_ALIAS_EXPANSIONS = 4;

/**
 * A project `type` alias spelled `name` in `declaringFile`, expanded with its
 * generic parameters substituted by `typeArguments` (bd tea-rags-mcp-s3i8m):
 * servo's `-> DomRoot<T>` with `pub type DomRoot<T> = Root<Dom<T>>` is
 * `Root<Dom<T>>`. The alias is the declaring file's own or bound by one of
 * its `use` imports; its body's names are placed in the ALIAS's file. A
 * project head needs every argument known and every name placed, else
 * `undefined`; a std head stays std with an unknown argument list dropped.
 */
function rustExpandProjectAlias(
  name: string,
  typeArguments: readonly (TypeRef | undefined)[] | undefined,
  declaringFile: string,
  ctx: CallContext,
  expansions = 0,
): TypeRef | undefined {
  if (expansions >= MAX_PROJECT_ALIAS_EXPANSIONS || name.includes("::")) return undefined;
  const alias = rustAliasDeclaration(name, declaringFile, ctx);
  const aliasedType = alias?.fact.aliasedType;
  if (alias === undefined || aliasedType === undefined) return undefined;
  const { relPath, fact } = alias;
  const parameters = fact.genericParameters ?? [];
  const given = typeArguments ?? [];
  if (given.length !== parameters.length) return undefined;
  const aliasCtx = { ...ctx, callerFile: relPath, callerScope: fact.typeId.split("::").slice(0, -1) };
  const expand = (recv: TypeRef): TypeRef | undefined => {
    if (recv.form === "tuple") {
      const elements = recv.elements.map(expand);
      return elements.every((element) => element !== undefined) ? { form: "tuple", elements } : undefined;
    }
    if (recv.form !== "instance" && recv.form !== "class") return undefined;
    const parameter = recv.args === undefined ? parameters.indexOf(recv.name) : -1;
    if (parameter >= 0) return given[parameter];
    const expandedArguments = recv.args?.map(expand);
    // A std head is std whatever its arguments (an unknown one drops the list):
    // spelled as a std path, or bound by the alias file's `use` (`StdResult`),
    // which outranks a same-name `impl .. for StdResult<T, E>` block there.
    const std =
      rustStdImportedTypeRef(recv.name, expandedArguments, relPath, ctx) ??
      (recv.name.includes("::") ? rustStdTypeRef(recv.name, expandedArguments, aliasCtx) : undefined);
    if (std !== undefined) return std;
    if (expandedArguments?.some((arg) => arg === undefined)) return undefined;
    const withArgs = (placed: NominalTypeRef): TypeRef =>
      expandedArguments === undefined ? placed : { ...placed, form: recv.form, args: expandedArguments as TypeRef[] };
    const head = resolveRustNominalType({ form: recv.form, name: recv.name }, aliasCtx);
    if (head !== undefined) return head.name.startsWith(`${relPath}::`) ? withArgs(head) : undefined;
    const imported = rustPlaceTypeThroughDeclaringFile(recv.name, relPath, ctx);
    if (imported !== undefined) return withArgs({ ...imported, form: recv.form });
    return (
      rustStdTypeRef(recv.name, expandedArguments, aliasCtx) ??
      rustExpandProjectAlias(recv.name, expandedArguments, relPath, ctx, expansions + 1)
    );
  };
  return expand(aliasedType);
}

/**
 * The std type a spelling names through `relPath`'s one non-glob `use` of a
 * std path (`use std::result::Result as StdResult;`); undefined otherwise.
 */
function rustStdImportedTypeRef(
  name: string,
  typeArguments: readonly (TypeRef | undefined)[] | undefined,
  relPath: string,
  ctx: CallContext,
): TypeRef | undefined {
  const bindings = (identifierEntry(ctx.rustUseImportsByFile, relPath) ?? []).flatMap((importText) =>
    (rustImportBindings(importText) ?? []).filter((binding) => !binding.globImport && binding.localName === name),
  );
  if (bindings.length !== 1 || bindings[0].prefix !== null) return undefined;
  const [binding] = bindings;
  const path = binding.sourceName === null ? binding.moduleSegments : [...binding.moduleSegments, binding.sourceName];
  return path.length > 1 ? rustStdTypeRef(path.join("::"), typeArguments, ctx) : undefined;
}

/** The type alias `name` denotes in `declaringFile`: declared there, or bound by one of its imports. */
function rustAliasDeclaration(
  name: string,
  declaringFile: string,
  ctx: CallContext,
): { relPath: string; fact: TypeDeclarationFact } | undefined {
  const aliasIn = (relPath: string, typeId: string): TypeDeclarationFact[] =>
    (ctx.typeDeclarations?.[relPath] ?? []).filter(
      (fact) => fact.typeId === typeId && fact.symbolKind === "type_alias" && !fact.reopens,
    );
  const own = aliasIn(declaringFile, name);
  if (own.length > 0) return own.length === 1 ? { relPath: declaringFile, fact: own[0] } : undefined;
  // A type alias carries no symbol: its file's declaration facts answer.
  const imported = rustDeclaringFileImportOf(name, declaringFile, ctx);
  if (imported === undefined) return undefined;
  const found = imported.paths.flatMap((relPath) =>
    aliasIn(relPath, imported.itemName).map((fact) => ({ relPath, fact })),
  );
  if (found.length > 0) return found.length === 1 ? found[0] : undefined;
  // None there: the module's `pub use` re-exports (`pub use self::error::{Error, Result};`).
  const { target: reexported } = rustFollowReexports(imported.importText, name, declaringFile, ctx, (itemName) =>
    rustAliasDefinitionsNamed(itemName, ctx),
  );
  if (!reexported?.targetSymbolId) return undefined;
  const facts = aliasIn(reexported.targetRelPath, reexported.targetSymbolId);
  return facts.length === 1 ? { relPath: reexported.targetRelPath, fact: facts[0] } : undefined;
}

const RUST_ALIAS_DEFINITIONS = new RunScopedMemo<object, Map<string, SymbolDefinition[]>>();

/**
 * Every top-level type alias named `itemName`, as a definition the re-export
 * walk matches by file — an alias has no symbol-table row, so the run's
 * declaration facts stand in (indexed once per run).
 */
function rustAliasDefinitionsNamed(itemName: string, ctx: CallContext): readonly SymbolDefinition[] {
  const declarations = ctx.typeDeclarations;
  if (declarations === undefined) return [];
  let index = RUST_ALIAS_DEFINITIONS.get(ctx.runScope, declarations);
  if (index === undefined) {
    index = new Map();
    for (const [relPath, facts] of Object.entries(declarations)) {
      for (const fact of facts) {
        if (fact.symbolKind !== "type_alias" || fact.reopens || fact.typeId.includes("::")) continue;
        const definition = { symbolId: fact.typeId, fqName: fact.typeId, shortName: fact.typeId, relPath, scope: [] };
        index.set(fact.typeId, [...(index.get(fact.typeId) ?? []), definition]);
      }
    }
    RUST_ALIAS_DEFINITIONS.set(ctx.runScope, declarations, index);
  }
  return index.get(itemName) ?? [];
}

export function rustDeclaredMemberReturnType(
  nominalType: TypeRef,
  member: string,
  ctx: CallContext,
): TypeRef | undefined {
  // std hops first (bd tea-rags-mcp-2g2og.24): `Option`/`Result` unwrap through
  // `unwrap`/`expect`, a std smart pointer hands a member it does not answer to
  // its target. A placed project type never matches either.
  const unwrapped = rustStdUnwrapType(nominalType, member);
  if (unwrapped !== undefined) return unwrapped;
  // A std element accessor (`stack.pop()`, `map.insert(k, v)`, `opt.take()`)
  // answers `Option<element>` (bd tea-rags-mcp-s3i8m Task 1b).
  const accessed = rustStdAccessorReturnType(nominalType, member);
  if (accessed !== undefined) return accessed;
  // A guard / `String` / `PathBuf` hands a member it does not answer itself
  // to its table `Deref::Target` (bd tea-rags-mcp-s3i8m.7 T3b).
  const pointee = rustStdDerefTarget(nominalType, member, ctx);
  if (pointee !== undefined) return rustDeclaredMemberReturnType(pointee, member, ctx);
  const owner = resolveRustNominalType(nominalType, ctx);
  // An unplaced external receiver answers its table-declared inherent return.
  // A std trait member neither answers falls to the closed return model (bd s3i8m.7 T3c).
  if (owner === undefined) {
    return (
      rustExternalMemberReturnType(nominalType, member, ctx) ?? rustStdTraitMemberReturnType(nominalType, member, ctx)
    );
  }
  // Rust method resolution auto-derefs: a member the owner misses is retried
  // on its `Deref::deref` declared return (a project smart pointer whose
  // `fn deref(&self) -> &T` was walked). Only true misses deref — a member the
  // owner declares is answered by the precedence walk above, byte-identically.
  let current: NominalTypeRef | undefined = owner;
  for (let hop = 0; current !== undefined && hop < 3; hop++) {
    const found = RUST_MEMBER_RETURN_TYPES.returnTypeOf(current, member, ctx);
    if (found !== null) return found ?? undefined;
    if (member === "deref") return undefined;
    const next = rustDerefTarget(current, ctx);
    // A miss on a type with no project `Deref` reads the std-trait return
    // model; `clone` is the type's own only on the owner itself — a Deref
    // owner may derive Clone, so a target never answers `Self`.
    if (next === undefined) return rustStdTraitMemberReturnType(current, member, ctx, hop === 0);
    if (next.name === current.name) return undefined;
    current = next;
  }
  return undefined;
}

/**
 * The placed `Deref` target of a project smart pointer — the `deref` method's
 * declared return, generic parameters substituted with the owner's own
 * (`Dom<Window>` derefs to the placed `Window`). The owner is placed first when
 * the typing port handed a raw binding annotation, so `Dom` resolves to its
 * declaring file before the `deref` return is read. Answers only a project
 * target: std smart pointers' `deref` lives outside the indexed source, so
 * `Rc<T>` / `Box<T>` receivers decline here exactly as before.
 */
export function rustDerefTarget(owner: NominalTypeRef, ctx: CallContext): NominalTypeRef | undefined {
  const placed = owner.name.includes(".rs::")
    ? owner
    : (resolveRustNominalType({ ...owner, form: owner.form === "class" ? "class" : "instance" }, ctx) ?? undefined);
  if (!placed?.name.includes(".rs::")) return undefined;
  const declared = RUST_MEMBER_RETURN_TYPES.returnTypeOf(placed, "deref", ctx);
  if (declared === null) return undefined;
  if (declared.form !== "instance" && declared.form !== "class") return undefined;
  if (declared.name === placed.name) {
    // The substitution answered the owner itself (`-> &Self::Target`): the
    // deref target is the pointer's single generic argument.
    const argument = placed.args?.[0];
    if (argument === undefined || placed.args?.length !== 1) return undefined;
    if (argument.form !== "instance" && argument.form !== "class") return undefined;
    const argumentPlaced = argument.name.includes(".rs::")
      ? argument
      : (resolveRustNominalType(argument, ctx) ?? undefined);
    if (!argumentPlaced?.name.includes(".rs::")) return undefined;
    return argumentPlaced;
  }
  const target = declared.name.includes(".rs::") ? declared : resolveRustNominalType(declared, ctx);
  if (!target?.name.includes(".rs::")) return undefined;
  return target;
}
