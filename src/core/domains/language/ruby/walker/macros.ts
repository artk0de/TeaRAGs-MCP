/**
 * Chunker-side Ruby class-body macro emission. Walks the immediate body of a
 * class / module node and collects every synthetic method symbol its DSL macros
 * declare, for the chunker's Qdrant `symbolId` payload.
 *
 * The actual expansion (which methods a macro declares) lives in the SINGLE
 * shared engine `./macro-expansion.ts` — the same engine the codegraph
 * `name-of.ts` calls — so chunker `symbolId`s match `cg_symbols` rows by
 * construction (`.claude/rules/symbolid-convention.md`). This file only applies
 * the chunker's EMISSION POLICY on top of the engine's full declared-method set.
 *
 * Without these symbols, bare-id call resolution in the Ruby walker (bd
 * tea-rags-mcp-hbie) cannot land on `Class#attr` / `Class#delegated_method`,
 * and `get_callers` / `get_callees` produce empty results on Rails code that
 * uses these idioms heavily (bd tea-rags-mcp-3nf3 + tea-rags-mcp-zy3f).
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { MacroSymbol } from "../../../../contracts/types/chunker.js";
import { expandAliasKeyword, expandClassBodyMacros, type DeclaredMethod } from "./macro-expansion.js";

/**
 * A synthesised method symbol emitted by a Ruby DSL macro. The chunker
 * wraps these into `CodeChunk` entries with `chunkType="function"`, the
 * appropriate `parentSymbolId`, and `symbolId = parent #|. name` so they
 * look identical to a regular `def`-emitted method symbol.
 *
 * Alias of the language-neutral `MacroSymbol` contract (relocated there so the
 * chunker engine reaches macro emission via the `LanguageChunkerHooks.macroSymbols`
 * capability, not a `domains/language/` import). Same shape.
 */
export type RubyMacroSymbol = MacroSymbol;

/**
 * Chunker emission policy — categories the engine synthesises for the codegraph
 * call-graph but the chunker does NOT emit as chunk symbols: association /
 * `scope` accessors would inflate a chunk's accessor count without changing
 * chunk semantics. This preserves the pre-unification chunker behaviour (which
 * never consulted the codegraph-only AR-association builders). The opt-out seam
 * lives HERE (consumer policy), not in the engine or the catalogue.
 */
const CHUNKER_SKIP_CATEGORIES = new Set<DeclaredMethod["category"]>(["association", "scope"]);

/**
 * Walk the immediate body of a class / module node and collect every
 * synthetic method that its DSL macros declare. Recursion into nested
 * containers is the caller's job — they recurse via the chunker's normal
 * class/module traversal, and re-invoke this function at each level.
 *
 * Currently the walk goes one step deep — `body_statement` children of the
 * container — which matches how the codegraph provider's `walkRubyTopLevel`
 * visits direct body members. Macros nested inside `if` / `unless` blocks
 * or inside `included do … end` (ActiveSupport::Concern) are NOT picked up;
 * the codegraph provider has the same limitation today and a unified fix
 * is tracked in the Concern follow-up bead.
 */
export function extractRubyMacroSymbols(containerNode: AstNode): RubyMacroSymbol[] {
  if (containerNode.type !== "class" && containerNode.type !== "module" && containerNode.type !== "singleton_class") {
    return [];
  }
  const body = containerNode.childForFieldName("body");
  // tree-sitter-ruby sometimes attaches body statements directly under the
  // class node when the grammar version doesn't expose a `body` field —
  // mirror the tolerant pattern from ruby-walker.ts `collectRubyClassAncestors`.
  const stmts = body ? body.children : containerNode.children;
  const out: RubyMacroSymbol[] = [];
  for (const stmt of stmts) {
    for (const m of expandClassBodyMacros(stmt)) {
      if (CHUNKER_SKIP_CATEGORIES.has(m.category)) continue; // chunker policy
      out.push({ name: m.name, kind: m.kind, startLine: m.startLine, endLine: m.endLine });
    }
    // `alias new old` keyword form is a distinct AST node, NOT a `call`.
    for (const m of expandAliasKeyword(stmt)) {
      out.push({ name: m.name, kind: m.kind, startLine: m.startLine, endLine: m.endLine });
    }
  }
  // Macros inside `class << self` declare CLASS-level methods → static
  // (`Foo.method`, `.` separator) per .claude/rules/symbolid-convention.md.
  if (containerNode.type === "singleton_class") {
    return out.map((s) => ({ ...s, kind: "static" as const }));
  }
  return out;
}
