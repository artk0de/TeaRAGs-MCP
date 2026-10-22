/**
 * What the rust-analyzer SCIP index says about one call site (bd s3i8m.6 R3):
 * the definition its member token names, whether that definition is the
 * project's own callable — and which table symbol it is — or provably outside
 * the project. Shared by the chain's last strategy and the miss classifier's
 * external gate, so both read the index the same way. Absence of evidence is
 * never a verdict: no index, no member position or no occurrence answers null.
 */
import type { CallContext, CallRef, SymbolResolutionTarget } from "../../../../contracts/types/codegraph.js";
import type { RustScipDefinition } from "../../../../contracts/types/language.js";
import { rustAnalyzerScipOf } from "./resolve-environment.js";
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
 */
export function rustScipDefinitionIsExternal(definition: RustScipDefinition): boolean {
  if (definition.inProject || definition.kind === "local") return false;
  if (!definition.packageInProject) return true;
  return (
    definition.kind === "callable" &&
    definition.implTrait !== undefined &&
    RUST_DERIVABLE_TRAITS.has(definition.implTrait)
  );
}

/** Whether SCIP proves the call's target lives outside the project. */
export function rustScipProvesExternal(call: CallRef, ctx: CallContext): boolean {
  const definition = rustScipDefinitionOf(call, ctx);
  return definition !== null && rustScipDefinitionIsExternal(definition);
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
