/**
 * What the compiler says about one call site — the rustc call-site driver
 * (bd s3i8m T7) and the rust-analyzer SCIP index (bd s3i8m.6 R3): the
 * definition its member token names, whether that definition is the project's
 * own callable — and which table symbol it is — or provably outside the
 * project. Shared by the chain's two compiler strategies and the miss
 * classifier's external gate, so all read either source the same way; the gate
 * reads the driver first, then SCIP. Absence of evidence is never a verdict:
 * no index, no member position or no occurrence answers null.
 */
import type {
  CallContext,
  CallRef,
  SymbolDefinition,
  SymbolResolutionTarget,
} from "../../../../contracts/types/codegraph.js";
import type { RustCallSiteDefinition, RustScipDefinition, TypeRef } from "../../../../contracts/types/language.js";
import { rustTextIsStdSmartPointer, rustTextIsStdType } from "../vocabulary/std-prelude.js";
import { rustAnalyzerScipOf, rustcCallSitesOf } from "./resolve-environment.js";
import { projectDeclaresType, rustStdSmartPointerTarget } from "./std-type-hops.js";
import { rustTraitDeclarersOf } from "./strategies/rust-trait-self-method.js";
import { rustReceiverChainType } from "./strategies/rust-type-receiver.js";
import {
  rustCalleeShortNameCandidates,
  rustCallIsMacroInvocation,
  rustMacroShortNameCandidates,
} from "./strategies/shared.js";

/**
 * Std traits `#[derive]` implements. A workspace-package method of one of
 * these with no definition occurrence is derive-generated code, not a symbol
 * the project wrote.
 */
export const RUST_DERIVABLE_TRAITS: ReadonlySet<string> = new Set([
  "Clone",
  "Copy",
  "Debug",
  "Default",
  "Hash",
  "PartialEq",
  "Eq",
  "PartialOrd",
  "Ord",
]);

/** What a compiler index answers for the call's member token; null without an index, a position or an answer. */
function definitionAtMember<D extends RustScipDefinition>(
  index: { definitionAt: (relPath: string, line: number, utf16Col: number) => D | null } | undefined,
  call: CallRef,
  ctx: CallContext,
): D | null {
  if (index === undefined || call.memberStartLine === undefined || call.memberStartColumn === undefined) return null;
  return index.definitionAt(ctx.callerFile, call.memberStartLine, call.memberStartColumn);
}

/** The definition SCIP records for the call's member token; null without an index, a position or an occurrence. */
export function rustScipDefinitionOf(call: CallRef, ctx: CallContext): RustScipDefinition | null {
  return definitionAtMember(rustAnalyzerScipOf(ctx), call, ctx);
}

/** The definition the rustc driver records for the call's member token (bd s3i8m T7); null as for SCIP. */
export function rustcCallSiteDefinitionOf(call: CallRef, ctx: CallContext): RustCallSiteDefinition | null {
  return definitionAtMember(rustcCallSitesOf(ctx), call, ctx);
}

/**
 * The compiler's answer for the call's member token: the rustc driver's — the
 * type-checked callee — and SCIP's only where the driver has no row
 * (bd s3i8m T7). Where both answer and disagree, the driver wins.
 */
function rustCallSiteDefinitionOf(call: CallRef, ctx: CallContext): RustCallSiteDefinition | null {
  return rustcCallSiteDefinitionOf(call, ctx) ?? rustScipDefinitionOf(call, ctx);
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
 * core, alloc or a dependency, a derive-generated impl in a workspace crate,
 * or a definition a dependency's macro generated there (format 4) — even
 * where its position falls on the project's `#[derive]` line. Any other
 * workspace symbol without a definition gets no verdict.
 * An external trait's DECLARATION member proves the trait, not the impl the
 * call dispatches to: it is external only when no project impl of that trait
 * declares the member — a provided method nobody overrides (bd s3i8m.6 R3c).
 * On a receiver proven to be a std type only a project impl of the trait FOR
 * that type counts (bd s3i8m.6 R3d): `usize::from(b)` dispatches to std's
 * `impl From<u8> for usize`, whatever `impl From<_> for X` the project writes.
 */
export function rustScipDefinitionIsExternal(
  definition: RustCallSiteDefinition,
  call: CallRef,
  ctx: CallContext,
): boolean {
  if (definition.kind === "local" || rustCallSiteIsDerivedImpl(definition)) return false;
  if (rustCallSiteIsForeignGenerated(definition)) return true;
  if (definition.inProject) return false;
  if (!definition.packageInProject) {
    if (definition.declaringTrait === undefined) return true;
    const selfType = rustProvenStdReceiverTypeName(call, definition.name, ctx);
    return !rustProjectImplDeclaresTraitMember(definition.declaringTrait, definition.name, ctx, selfType);
  }
  return (
    definition.kind === "callable" &&
    definition.implTrait !== undefined &&
    RUST_DERIVABLE_TRAITS.has(definition.implTrait)
  );
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

/** Whether the compiler — the driver, else SCIP — proves the call's target lives outside the project. */
export function rustCallSiteProvesExternal(call: CallRef, ctx: CallContext): boolean {
  const definition = rustCallSiteDefinitionOf(call, ctx);
  return definition !== null && rustScipDefinitionIsExternal(definition, call, ctx);
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
 * Whether the compiler — the driver, else SCIP — proves no project callable is
 * the call's target although one may share its name: an in-project type or
 * local — a tuple-struct / tuple-variant constructor or a closure variable
 * (bd s3i8m.6 R3b) — or a derived impl (bd s3i8m T7).
 */
export function rustCallSiteProvesNoProjectCallable(call: CallRef, ctx: CallContext): boolean {
  const definition = rustCallSiteDefinitionOf(call, ctx);
  if (definition === null) return false;
  if (rustCallSiteIsDerivedImpl(definition)) return true;
  return definition.inProject && (definition.kind === "type" || definition.kind === "local");
}

/**
 * The table symbol an in-project SCIP definition names: the callee-role (or,
 * for a macro invocation, macro) candidates of the descriptor's name — never
 * the call's member, which a `use a as b` alias renames — declared in the
 * definition's file with a span containing its line; the narrowest wins. When
 * no span contains it, the file's one symbolId of that name owned by the impl's
 * self type the compiler named: an inherent method and a trait-impl method of
 * one type compose the same id, and the table keeps it once with the first
 * window. Null for a non-callable definition, no such tableSymbol, or a tie.
 */
export function mapScipDefinitionToSymbol(
  definition: RustScipDefinition,
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
    sameIdWindowOwnedBy(candidates, definition.relPath, rustImplSelfTypeName(definition.symbol))
  );
}

/**
 * The one symbolId the file declares among the candidates whose owner is the
 * impl's self type; null without an owner, for none, or for several.
 */
function sameIdWindowOwnedBy(
  candidates: readonly SymbolDefinition[],
  relPath: string,
  owner: string | null,
): SymbolResolutionTarget | null {
  if (owner === null) return null;
  const symbolIds = new Set(
    candidates
      .filter((tableSymbol) => tableSymbol.relPath === relPath && tableSymbol.scope.at(-1) === owner)
      .map((tableSymbol) => tableSymbol.symbolId),
  );
  if (symbolIds.size !== 1) return null;
  const [targetSymbolId] = symbolIds;
  return { targetRelPath: relPath, targetSymbolId };
}

/**
 * The self type's short name of the impl a compiler path names, generic
 * arguments dropped: `<a::Either<L, R> as AsRef<T>>::as_ref` and
 * `m::<impl From<D> for b::ConfigValue>::from` give `Either` / `ConfigValue`,
 * `a::Store::<T>::get` gives `Store`. Null when the path names no owner.
 */
export function rustImplSelfTypeName(compilerPath: string): string | null {
  const path = compilerPath.replace(/^rustc \S+ /, "");
  const qualified = /^<(.+?) as .+>::[^:]+$/.exec(path);
  const inherentBlock = /<impl .+ for (.+)>::[^:]+$/.exec(path);
  const owner = qualified?.[1] ?? inherentBlock?.[1] ?? path.split("::").slice(0, -1).join("::");
  const lastSegment = owner.replace(/<.*$/, "").replace(/::$/, "").split("::").at(-1) ?? "";
  return /^[A-Z][A-Za-z0-9_]*$/.test(lastSegment) ? lastSegment : null;
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
