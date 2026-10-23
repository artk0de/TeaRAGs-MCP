/**
 * What the compiler says about one call site — the rustc call-site driver
 * (bd s3i8m T7): the definition its member token names, whether that
 * definition is the project's own callable — and which table symbol it is — or
 * provably outside the project. Shared by the chain's compiler strategy and the
 * miss classifier's gates, so both read the driver the same way. Absence of
 * evidence is never a verdict: no index, no member position or no row answers
 * null.
 */
import type {
  CallContext,
  CallRef,
  SymbolDefinition,
  SymbolResolutionTarget,
} from "../../../../contracts/types/codegraph.js";
import type { RustCallSiteDefinition, TypeRef } from "../../../../contracts/types/language.js";
import { rustTextIsStdSmartPointer, rustTextIsStdType } from "../vocabulary/std-prelude.js";
import { rustcCallSitesOf } from "./resolve-environment.js";
import { projectDeclaresType, rustStdSmartPointerTarget } from "./std-type-hops.js";
import { rustTraitDeclarersOf } from "./strategies/rust-trait-self-method.js";
import { rustReceiverChainType } from "./strategies/rust-type-receiver.js";
import {
  rustCalleeShortNameCandidates,
  rustCallIsMacroInvocation,
  rustImportBindings,
  rustMacroShortNameCandidates,
  type RustImportBinding,
} from "./strategies/shared.js";

/**
 * The definition the rustc driver records for the call's member token — the
 * type-checked callee (bd s3i8m T7); null without an index, a position or a row.
 */
export function rustcCallSiteDefinitionOf(call: CallRef, ctx: CallContext): RustCallSiteDefinition | null {
  const index = rustcCallSitesOf(ctx);
  if (index === undefined || call.memberStartLine === undefined || call.memberStartColumn === undefined) return null;
  return index.definitionAt(ctx.callerFile, call.memberStartLine, call.memberStartColumn);
}

/**
 * Whether the compiler dispatched the call to a `#[automatically_derived]`
 * impl: derive output, so no table symbol is its edge and no external call it
 * is — the site counts as `noInProjectDef` (bd s3i8m T7).
 */
export function rustCallSiteIsDerivedImpl(definition: RustCallSiteDefinition): boolean {
  return definition.implIsDerived === true;
}

/**
 * Whether a macro the project does not own — a dependency's proc macro or
 * `macro_rules!` (`thiserror`, `bitflags!`) — generated the definition
 * (format 4 `defExpansion`): dependency output written into a project crate,
 * external like any dependency code, never a namesake's.
 */
export function rustCallSiteIsForeignGenerated(definition: RustCallSiteDefinition): boolean {
  return definition.defExpansion?.macroInProject === false;
}

/**
 * Whether the definition is provably outside the project's own code: std,
 * core, alloc or a dependency, a workspace definition with no project source
 * position (derive output, a build-script `OUT_DIR` item), or a definition a
 * dependency's macro generated there (format 4) — even where its position
 * falls on the project's `#[derive]` line.
 * An external trait's DECLARATION member proves the trait, not the impl the
 * call dispatches to: it is external only when no project impl of that trait
 * declares the member — a provided method nobody overrides (bd s3i8m.6 R3c).
 * On a receiver proven to be a std type only a project impl of the trait FOR
 * that type counts (bd s3i8m.6 R3d): `usize::from(b)` dispatches to std's
 * `impl From<u8> for usize`, whatever `impl From<_> for X` the project writes.
 */
export function rustCallSiteDefinitionIsExternal(
  definition: RustCallSiteDefinition,
  call: CallRef,
  ctx: CallContext,
): boolean {
  if (definition.kind === "local" || rustCallSiteIsDerivedImpl(definition)) return false;
  if (rustCallSiteIsForeignGenerated(definition)) return true;
  if (definition.inProject) return false;
  if (definition.declaringTrait !== undefined) {
    const selfType = rustProvenStdReceiverTypeName(call, definition.name, ctx);
    return !rustProjectImplDeclaresTraitMember(definition.declaringTrait, definition.name, ctx, selfType);
  }
  // A dependency, or a workspace definition with no project source position: a
  // build-script `OUT_DIR` item (servo's `script_bindings::codegen::`) or derive
  // output — no table symbol is it, so no namesake may stand in.
  return true;
}

/** Path roots that name the project's own module tree. */
const PROJECT_PATH_ROOTS: ReadonlySet<string> = new Set(["crate", "self", "super"]);
/** Path roots that name std. */
const STD_PATH_ROOTS: ReadonlySet<string> = new Set(["std", "core", "alloc"]);

/** The last `::` segment of a type spelling: `std::sync::mpsc::Sender` → `Sender`. */
function rustTypeShortName(name: string): string {
  return name.split("::").at(-1) ?? name;
}

/**
 * The short name of the std type a spelling provably names, or `undefined`: a
 * `std` / `core` / `alloc` path, or a bare prelude / primitive type the
 * project does not shadow.
 */
function rustStdTypeShortName(name: string, ctx: CallContext): string | undefined {
  const path = name.replace(/^::/, "");
  if (path.includes("::")) return STD_PATH_ROOTS.has(path.split("::")[0]) ? rustTypeShortName(path) : undefined;
  return rustTextIsStdType(path) && !projectDeclaresType(ctx, path) ? path : undefined;
}

/**
 * The short name of the std type the call's receiver provably is, or
 * `undefined` when unknown, generic or a project type. A path call
 * (`usize::from(b)`, `Vec::<u8>::from(v)`) reads its spelled type — a std
 * type by name, never a trait path like `std::io::Write::write(w, ..)`, whose
 * receiver is the argument; a value receiver reads the chain's receiver typing.
 */
function rustProvenStdReceiverTypeName(call: CallRef, member: string, ctx: CallContext): string | undefined {
  const { receiver } = call;
  if (receiver === null) return undefined;
  if (call.callText.startsWith(`${receiver}::`)) {
    const spelled = rustStdTypeShortName(receiver.replace(/::<.*>$/, "").replace(/<.*>$/, ""), ctx);
    return spelled !== undefined && rustTextIsStdType(spelled) ? spelled : undefined;
  }
  return rustStdTypeRefShortName(rustReceiverChainType(call, ctx), member, ctx);
}

/** A std smart pointer handing `member` to its `Deref` target answers with that target's verdict. */
function rustStdTypeRefShortName(
  receiverType: TypeRef | undefined,
  member: string,
  ctx: CallContext,
): string | undefined {
  if (receiverType?.form !== "instance") return undefined;
  const shortName = rustStdTypeShortName(receiverType.name, ctx);
  if (shortName === undefined || !rustTextIsStdSmartPointer(shortName)) return shortName;
  const derefTarget = rustStdSmartPointerTarget(receiverType, member);
  if (derefTarget !== undefined) return rustStdTypeRefShortName(derefTarget, member, ctx);
  // The pointer answers `member` itself only when its one argument is known.
  return receiverType.args?.length === 1 ? shortName : undefined;
}

/**
 * Whether a project callable `member` sits inside an `impl <trait> for X`
 * block — a re-opening type fact whose `conforms` names the trait (short name;
 * a `crate::` / `self::` / `super::` path names a project trait, never the
 * external one) and whose span contains the callable's line. A known
 * `selfType` also requires the impl's type to be it (short name).
 */
function rustProjectImplDeclaresTraitMember(
  trait: string,
  member: string,
  ctx: CallContext,
  selfType?: string,
): boolean {
  const namesTrait = (conformed: string): boolean => {
    const segments = conformed.split("::");
    if (segments.length > 1 && PROJECT_PATH_ROOTS.has(segments[0])) return false;
    return segments.at(-1) === trait;
  };
  return rustCalleeShortNameCandidates(ctx, member).some((callable) => {
    const line = callable.startLine;
    if (line === undefined) return false;
    return (ctx.typeDeclarations?.[callable.relPath] ?? []).some(
      (fact) =>
        fact.reopens &&
        (selfType === undefined || rustTypeShortName(fact.typeId) === selfType) &&
        fact.selfConstraints !== undefined &&
        fact.selfConstraints.startLine <= line &&
        line <= fact.selfConstraints.endLine &&
        (fact.conforms ?? []).some(namesTrait),
    );
  });
}

/** Whether the rustc driver proves the call's target lives outside the project. */
export function rustCallSiteProvesExternal(call: CallRef, ctx: CallContext): boolean {
  const definition = rustcCallSiteDefinitionOf(call, ctx);
  return definition !== null && rustCallSiteDefinitionIsExternal(definition, call, ctx);
}

/**
 * Whether the rustc driver proves the callee is a closure, a fn pointer or an
 * Fn-bound param / trait object (RESIDUAL R4): a target decided at run time,
 * which no static pass can name.
 */
export function rustCallSiteProvesIndirectCallee(call: CallRef, ctx: CallContext): boolean {
  return rustcCallSiteDefinitionOf(call, ctx)?.indirectCallee !== undefined;
}

/**
 * Whether the rustc driver proves no project callable is
 * the call's target although one may share its name: an in-project type or
 * local — a tuple-struct / tuple-variant constructor or a closure variable
 * (bd s3i8m.6 R3b) — or a derived impl (bd s3i8m T7).
 */
export function rustCallSiteProvesNoProjectCallable(call: CallRef, ctx: CallContext): boolean {
  const definition = rustcCallSiteDefinitionOf(call, ctx);
  if (definition === null) return false;
  if (rustCallSiteIsDerivedImpl(definition)) return true;
  return definition.inProject && (definition.kind === "type" || definition.kind === "local");
}

/**
 * The table symbol an in-project driver definition names: the callee-role (or,
 * for a macro invocation, macro) candidates of the descriptor's name — never
 * the call's member, which a `use a as b` alias renames — declared in the
 * definition's file with a span containing its line; the narrowest wins. When
 * no span contains it, the file's one symbolId of that name owned by the impl's
 * self type the compiler named: an inherent method and a trait-impl method of
 * one type compose the same id, and the table keeps it once with the first
 * window. Null for a non-callable definition, no such tableSymbol, or a tie.
 */
export function mapRustCallSiteDefinitionToSymbol(
  definition: RustCallSiteDefinition,
  call: CallRef,
  ctx: CallContext,
): SymbolResolutionTarget | null {
  const isMacro = rustCallIsMacroInvocation(call);
  if (!definition.inProject || definition.relPath === undefined || definition.line === undefined) return null;
  if (definition.kind !== (isMacro ? "macro" : "callable")) return null;
  const candidates = isMacro
    ? rustMacroShortNameCandidates(ctx, definition.name)
    : rustCalleeShortNameCandidates(ctx, definition.name);
  return (
    narrowestSymbolContaining(candidates, definition.relPath, definition.line) ??
    sameIdWindowOwnedBy(candidates, definition.relPath, rustCompilerPathOwner(definition.symbol), ctx)
  );
}

/** What a compiler path's item is declared under: an impl's self type, or a module. */
interface RustCompilerPathOwner {
  readonly kind: "type" | "module";
  /** The owner's key — {@link rustOwnerKey} of its spelling. */
  readonly name: string;
}

/**
 * The one symbolId the file declares among the candidates whose owner is the
 * one the compiler path names: the impl's self type — or the project type it
 * is an alias of — or the module. A module-owned definition no module scope
 * matches (a cfg variant re-exported from the crate root) takes the file's one
 * symbolId of that name; a type owner never does. Null without an owner, for
 * none, or for several.
 */
function sameIdWindowOwnedBy(
  candidates: readonly SymbolDefinition[],
  relPath: string,
  owner: RustCompilerPathOwner | null,
  ctx: CallContext,
): SymbolResolutionTarget | null {
  if (owner === null) return null;
  const inFile = candidates.filter((tableSymbol) => tableSymbol.relPath === relPath);
  const ownedBy = (name: string) =>
    uniqueSymbolIdIn(
      relPath,
      inFile.filter((tableSymbol) => rustOwnerKey(tableSymbol.scope.at(-1) ?? "") === name),
    );
  const direct = ownedBy(owner.name);
  if (direct !== null || inFile.length === 0) return direct;
  if (owner.kind === "module") return uniqueSymbolIdIn(relPath, inFile);
  const aliased = rustProjectAliasTargetKey(owner.name, ctx);
  return aliased === undefined ? null : ownedBy(aliased);
}

/** The target of `candidates` when they share one symbolId; null for none or several. */
function uniqueSymbolIdIn(relPath: string, candidates: readonly SymbolDefinition[]): SymbolResolutionTarget | null {
  const symbolIds = new Set(candidates.map((tableSymbol) => tableSymbol.symbolId));
  if (symbolIds.size !== 1) return null;
  const [targetSymbolId] = symbolIds;
  return { targetRelPath: relPath, targetSymbolId };
}

/**
 * The key one owner spelling compares under, compiler path and table scope
 * alike: references (`&`, `&'a mut`) and generic arguments dropped, the last
 * `::` segment kept — `&[u8]` → `[u8]`, `std::sync::mpsc::SyncSender<C>` and
 * `mpsc::SyncSender` → `SyncSender`.
 */
function rustOwnerKey(spelling: string): string {
  const unreferenced = spelling.trim().replace(/^(&\s*('\w+\s+)?(mut\s+)?)+/, "");
  if (unreferenced.startsWith("[") || unreferenced.startsWith("(")) return unreferenced.replace(/\s+/g, "");
  return unreferenced.replace(/<.*$/, "").replace(/::$/, "").split("::").at(-1) ?? "";
}

/** Per run's import map: each `use … X as Y` rename's local name → the renamed items' keys. */
const renamesByImports = new WeakMap<Readonly<Record<string, readonly string[]>>, Map<string, Set<string>>>();

/** The item a `use` binding renames (`Time` of `Time as DateTime`); undefined for a glob or an unrenamed binding. */
function rustRenamedItemOf(binding: RustImportBinding): string | undefined {
  if (binding.globImport) return undefined;
  const item = binding.sourceName ?? binding.moduleSegments.at(-1);
  return item === undefined || item === binding.localName || item === "self" ? undefined : item;
}

/** The keys of the items the project's `use` imports rename to `localName` (`use m::{Time as DateTime}`). */
function rustUseRenameSourceKeys(localName: string, ctx: CallContext): ReadonlySet<string> {
  const importsByFile = ctx.rustUseImportsByFile;
  if (importsByFile === undefined) return new Set();
  let renames = renamesByImports.get(importsByFile);
  if (renames === undefined) {
    renames = new Map();
    for (const importTexts of Object.values(importsByFile)) {
      for (const importText of importTexts) {
        for (const binding of rustImportBindings(importText) ?? []) {
          const renamedItem = rustRenamedItemOf(binding);
          if (renamedItem === undefined) continue;
          const sources = renames.get(binding.localName) ?? new Set<string>();
          sources.add(rustOwnerKey(renamedItem));
          renames.set(binding.localName, sources);
        }
      }
    }
    renamesByImports.set(importsByFile, renames);
  }
  return renames.get(localName) ?? new Set();
}

/**
 * The owner key of the type a project alias of key `aliasKey` stands for — a
 * type alias (`pub type DateTime = Time`) or a `use` rename (`use m::{Time as
 * DateTime}`) — when every alias of that name agrees on one; undefined otherwise.
 */
function rustProjectAliasTargetKey(aliasKey: string, ctx: CallContext): string | undefined {
  const targets = new Set<string>(rustUseRenameSourceKeys(aliasKey, ctx));
  for (const facts of Object.values(ctx.typeDeclarations ?? {})) {
    for (const fact of facts) {
      if (fact.symbolKind !== "type_alias" || fact.reopens || rustOwnerKey(fact.typeId) !== aliasKey) continue;
      const aliased = fact.aliasedType;
      if (aliased?.form !== "instance" && aliased?.form !== "class") return undefined;
      targets.add(rustOwnerKey(aliased.name));
    }
  }
  if (targets.size !== 1) return undefined;
  const [targetKey] = targets;
  return targetKey === aliasKey ? undefined : targetKey;
}

/**
 * What a compiler path's item is declared under: `<X as Trait>::m` and
 * `<impl Trait for X>::m` name the self type X — any spelling, a reference or
 * a primitive included — `a::Store::<T>::get` the type `Store`, `a::imp::m`
 * the module `imp`. Null for an inherent impl on a builtin (`<impl str>`) or a
 * path with no owner segment.
 */
function rustCompilerPathOwner(compilerPath: string): RustCompilerPathOwner | null {
  const path = compilerPath.replace(/^rustc \S+ /, "");
  const selfType = /^<(.+?) as .+>::[^:]+$/.exec(path)?.[1] ?? /<impl .+ for (.+)>::[^:]+$/.exec(path)?.[1];
  if (selfType !== undefined) {
    const name = rustOwnerKey(selfType);
    return name === "" ? null : { kind: "type", name };
  }
  const owner = path.split("::").slice(0, -1).join("::");
  if (owner.includes("<impl ")) return null;
  const name = rustOwnerKey(owner);
  if (/^[A-Z][A-Za-z0-9_]*$/.test(name)) return { kind: "type", name };
  return /^[a-z_][a-z0-9_]*$/.test(name) ? { kind: "module", name } : null;
}

/**
 * The self type's key of the impl a compiler path names, generic arguments
 * and references dropped: `<a::Either<L, R> as AsRef<T>>::as_ref`,
 * `m::<impl From<D> for b::ConfigValue>::from` and `<&[u8] as D>::decode`
 * give `Either` / `ConfigValue` / `[u8]`, `a::Store::<T>::get` gives `Store`.
 * Null when the path names no type owner.
 */
export function rustImplSelfTypeName(compilerPath: string): string | null {
  const owner = rustCompilerPathOwner(compilerPath);
  return owner?.kind === "type" ? owner.name : null;
}

/**
 * The project trait's declaration of the member a project macro GENERATED an
 * impl of (`#[derive(AggrFunction)]` writing `impl AggrFunction for X { fn
 * create_state }`): the trait method is the call's real target in source,
 * ahead of the macro. Null without an impl trait, or unless exactly one
 * project trait of that short name declares the member.
 */
export function mapRustGeneratedTraitImplToDeclaration(
  definition: RustCallSiteDefinition,
  ctx: CallContext,
): SymbolResolutionTarget | null {
  const trait = definition.implTrait;
  if (trait === undefined || definition.defExpansion?.macroInProject !== true) return null;
  const declarers = rustTraitDeclarersOf(definition.name, ctx).filter((declarer) => declarer.trait === trait);
  if (declarers.length !== 1) return null;
  return { targetRelPath: declarers[0].def.relPath, targetSymbolId: declarers[0].def.symbolId };
}

/**
 * The table symbol of the in-project macro that GENERATED a definition
 * (format 4 `defExpansion`): the macro — a `macro_rules!` — or the function a
 * workspace proc macro is, named as declared at its definition and containing
 * that line; the narrowest wins. Null for a foreign macro, an expansion
 * without a position, no containing symbol, or a tie.
 */
export function mapRustGeneratingMacroToSymbol(
  definition: RustCallSiteDefinition,
  ctx: CallContext,
): SymbolResolutionTarget | null {
  const expansion = definition.defExpansion;
  if (expansion?.macroInProject !== true) return null;
  const { macroDefRelPath, macroDefLine } = expansion;
  if (macroDefRelPath === undefined || macroDefLine === undefined) return null;
  const name = expansion.macroDefName ?? expansion.macro;
  const candidates = [...rustMacroShortNameCandidates(ctx, name), ...rustCalleeShortNameCandidates(ctx, name)];
  return narrowestSymbolContaining(candidates, macroDefRelPath, macroDefLine);
}

/** The one narrowest of `candidates` declared in `relPath` with a span containing `line`; null on none or a tie. */
function narrowestSymbolContaining(
  candidates: readonly SymbolDefinition[],
  relPath: string,
  line: number,
): SymbolResolutionTarget | null {
  const containing = candidates.filter(
    (tableSymbol) =>
      tableSymbol.relPath === relPath &&
      tableSymbol.startLine !== undefined &&
      tableSymbol.endLine !== undefined &&
      tableSymbol.startLine <= line &&
      line <= tableSymbol.endLine,
  );
  const span = (tableSymbol: SymbolDefinition) => (tableSymbol.endLine ?? 0) - (tableSymbol.startLine ?? 0);
  const narrowest = Math.min(...containing.map(span));
  const hits = containing.filter((tableSymbol) => span(tableSymbol) === narrowest);
  if (hits.length !== 1) return null;
  return { targetRelPath: relPath, targetSymbolId: hits[0].symbolId };
}
