/**
 * What the rust-analyzer SCIP index says about one call site (bd s3i8m.6 R3):
 * the definition its member token names, whether that definition is the
 * project's own callable — and which table symbol it is — or provably outside
 * the project. Shared by the chain's last strategy and the miss classifier's
 * external gate, so both read the index the same way. Absence of evidence is
 * never a verdict: no index, no member position or no occurrence answers null.
 */
import type { CallContext, CallRef, SymbolResolutionTarget } from "../../../../contracts/types/codegraph.js";
import type { RustScipDefinition, TypeRef } from "../../../../contracts/types/language.js";
import { rustTextIsStdSmartPointer, rustTextIsStdType } from "../vocabulary/std-prelude.js";
import { rustAnalyzerScipOf } from "./resolve-environment.js";
import { projectDeclaresType, rustStdSmartPointerTarget } from "./std-type-hops.js";
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

/** The definition SCIP records for the call's member token; null without an index, a position or an occurrence. */
export function rustScipDefinitionOf(call: CallRef, ctx: CallContext): RustScipDefinition | null {
  const index = rustAnalyzerScipOf(ctx);
  if (index === undefined || call.memberStartLine === undefined || call.memberStartColumn === undefined) return null;
  return index.definitionAt(ctx.callerFile, call.memberStartLine, call.memberStartColumn);
}

/**
 * Whether the definition is provably outside the project's own code: std,
 * core, alloc or a dependency, or a derive-generated impl in a workspace
 * crate. Any other workspace symbol without a definition gets no verdict.
 * An external trait's DECLARATION member proves the trait, not the impl the
 * call dispatches to: it is external only when no project impl of that trait
 * declares the member — a provided method nobody overrides (bd s3i8m.6 R3c).
 * On a receiver proven to be a std type only a project impl of the trait FOR
 * that type counts (bd s3i8m.6 R3d): `usize::from(b)` dispatches to std's
 * `impl From<u8> for usize`, whatever `impl From<_> for X` the project writes.
 */
export function rustScipDefinitionIsExternal(definition: RustScipDefinition, call: CallRef, ctx: CallContext): boolean {
  if (definition.inProject || definition.kind === "local") return false;
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

/** Whether SCIP proves the call's target lives outside the project. */
export function rustScipProvesExternal(call: CallRef, ctx: CallContext): boolean {
  const definition = rustScipDefinitionOf(call, ctx);
  return definition !== null && rustScipDefinitionIsExternal(definition, call, ctx);
}

/**
 * Whether SCIP proves the call's target an in-project type or local — a
 * tuple-struct / tuple-variant constructor or a closure variable, never a
 * callable a same-named table symbol could be (bd s3i8m.6 R3b).
 */
export function rustScipProvesInProjectNonCallable(call: CallRef, ctx: CallContext): boolean {
  const definition = rustScipDefinitionOf(call, ctx);
  return definition !== null && definition.inProject && (definition.kind === "type" || definition.kind === "local");
}

/**
 * The table symbol an in-project SCIP definition names: the callee-role (or,
 * for a macro invocation, macro) candidates of the descriptor's name — never
 * the call's member, which a `use a as b` alias renames — declared in the
 * definition's file with a span containing its line; the narrowest wins. Null
 * for a non-callable definition, no containing tableSymbol, or a tie.
 */
export function mapScipDefinitionToSymbol(
  definition: RustScipDefinition,
  call: CallRef,
  ctx: CallContext,
): SymbolResolutionTarget | null {
  const isMacro = rustCallIsMacroInvocation(call);
  if (!definition.inProject || definition.relPath === undefined || definition.line === undefined) return null;
  if (definition.kind !== (isMacro ? "macro" : "callable")) return null;
  const { relPath, line } = definition;
  const candidates = (
    isMacro ? rustMacroShortNameCandidates(ctx, definition.name) : rustCalleeShortNameCandidates(ctx, definition.name)
  ).filter(
    (tableSymbol) =>
      tableSymbol.relPath === relPath &&
      tableSymbol.startLine !== undefined &&
      tableSymbol.endLine !== undefined &&
      tableSymbol.startLine <= line &&
      line <= tableSymbol.endLine,
  );
  const span = (tableSymbol: (typeof candidates)[number]) => (tableSymbol.endLine ?? 0) - (tableSymbol.startLine ?? 0);
  const narrowest = Math.min(...candidates.map(span));
  const hits = candidates.filter((tableSymbol) => span(tableSymbol) === narrowest);
  if (hits.length !== 1) return null;
  return { targetRelPath: relPath, targetSymbolId: hits[0].symbolId };
}
