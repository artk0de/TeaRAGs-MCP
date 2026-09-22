/**
 * Symbol lookups restricted to SWIFT declarations — the ONLY table entry points
 * the Swift resolver may use (`.claude/rules/resolver-architecture.md` §2).
 *
 * One symbol table is built per run over every `CODEGRAPH_LANGUAGES` extension
 * and `SymbolDefinition` carries no `language` field, so a bare
 * `lookup("Store#save")` answers with any file that declares that id. Swift
 * makes this sharper than most: an iOS repository ordinarily ships a
 * TypeScript or Ruby backend beside it, and Swift's member vocabulary —
 * `init`, `run`, `format`, `value`, `description` — collides with those
 * languages constantly. It goes wrong both ways: a PICK SITE selects the
 * foreign method outright, and a CARDINALITY GATE reads a foreign namesake as
 * ambiguity and drops a real Swift edge.
 *
 * Wrapping the table rather than filtering per site is what keeps the guard
 * from being forgotten at the next one. The extension is the axis for the same
 * reason as Go's, Python's and Ruby's helpers: it is all a definition carries.
 *
 * The short-name entry point carries a second guard for the same reason —
 * {@link collapseReopenedTypeDeclarations}, which folds the several
 * declarations of ONE re-opened Swift type back into one candidate.
 */

import type { CallContext, SymbolDefinition, SymbolLookupOptions } from "../../../../contracts/types/codegraph.js";
import { hasSwiftOverloadSuffix, isSwiftTypeDeclarationId, stripSwiftOverloadSuffix } from "./swift-type-name.js";

const SWIFT_SOURCE_EXTENSION = ".swift";

/** Whether a definition's file is Swift source. */
export function isSwiftSourcePath(relPath: string): boolean {
  return relPath.endsWith(SWIFT_SOURCE_EXTENSION);
}

/** Exact-id lookup (`Store`, `Store#save`, `Store.make`) over Swift declarations only. */
export function lookupSwiftSymbols(ctx: CallContext, symbolId: string): SymbolDefinition[] {
  return ctx.symbolTable.lookup(symbolId).filter((def) => isSwiftSourcePath(def.relPath));
}

/**
 * Short-name lookup over Swift declarations only, with a type re-opened in one
 * file counted ONCE.
 */
export function lookupSwiftSymbolsByShortName(
  ctx: CallContext,
  name: string,
  options?: SymbolLookupOptions,
): SymbolDefinition[] {
  const swiftDefs = ctx.symbolTable.lookupByShortName(name, options).filter((def) => isSwiftSourcePath(def.relPath));
  return collapseReopenedTypeDeclarations(swiftDefs);
}

/**
 * Drop the extra declarations a same-file `extension` adds to ONE type
 * (bd tea-rags-mcp-sg35c).
 *
 * tree-sitter-swift parses `extension Invoice` as a second `class_declaration`
 * carrying the extended type's name, so a file holding `struct Invoice` beside
 * `extension Invoice: Codable` composes `Invoice` AND `Invoice~2`. Its MEMBERS
 * are already attributed correctly — `collectSymbols` scopes them under
 * `Invoice`, never `Invoice~2` — and only the extension's own container node
 * gets a second id. `lastSegment` strips the `~N`, so both answer the short
 * name `Invoice`, and the strict cardinality gate then reads one logical type
 * as ambiguity and drops every construction edge into it. Same-file conformance
 * extensions are ordinary Swift, so that is a real cost on any corpus.
 *
 * The fold is deliberately narrow, and each condition is load-bearing:
 *
 *   - **Only a `~N`-suffixed id is ever dropped.** The base declaration — the
 *     one carrying the type's own body — is what survives.
 *   - **Only when the base id is in the SAME FILE.** Two files each declaring
 *     `Invoice` are a genuine cross-file ambiguity (a type and an extension in
 *     separate files compose the identical id, and nothing here says which is
 *     which), so they stay ambiguous and emit no edge.
 *   - **Only when the base id names a TYPE** ({@link isSwiftTypeDeclarationId}).
 *     `Invoice#init` / `Invoice#init~2` and `Invoice.empty` / `Invoice.empty~2`
 *     are genuine overloads with distinct bodies — collapsing them to the first
 *     would be a coin flip, which is exactly what `disambiguateOverloads` was
 *     turned on to avoid.
 *
 * So this removes a DUPLICATE, it does not pick a winner: after the fold the
 * cardinality gate still sees every distinct declaration the file holds.
 */
function collapseReopenedTypeDeclarations(defs: SymbolDefinition[]): SymbolDefinition[] {
  return defs.filter((def) => {
    if (!hasSwiftOverloadSuffix(def.symbolId) || !isSwiftTypeDeclarationId(def.symbolId)) return true;
    const base = stripSwiftOverloadSuffix(def.symbolId);
    return !defs.some((other) => other.symbolId === base && other.relPath === def.relPath);
  });
}
