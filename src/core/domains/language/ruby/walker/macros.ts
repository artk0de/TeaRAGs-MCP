/**
 * Ruby class-body DSL macros that synthesise instance / class methods.
 *
 * Several Ruby idioms declare methods without `def`:
 *
 *   - `attr_accessor :foo` / `attr_reader :foo` / `attr_writer :foo` — Ruby
 *     builtins. Accessor → getter + setter; reader → getter only; writer →
 *     setter only (`foo=`).
 *   - `cattr_accessor :x` / `mattr_accessor :x` (and `_reader` / `_writer`
 *     variants) — ActiveSupport class-level / module-level accessors. Emit
 *     methods at class scope (`Class.x`, separator `.`).
 *   - `delegate :a, :b, to: :other` — Forwardable / ActiveSupport delegation.
 *     Each leading symbol argument before the first hash argument becomes a
 *     forwarder instance method.
 *   - `define_method(:name) { ... }` — runtime method definition. When the
 *     first arg is a literal symbol / string, the name is statically known
 *     and we treat the call as a regular instance method declaration.
 *
 * The chunker (which writes Qdrant payload `symbolId`) and the codegraph
 * provider (which writes `cg_symbols.symbol_id` in DuckDB) MUST agree on the
 * synthetic-method symbols emitted from these macros. Per
 * `.claude/rules/symbolid-convention.md` the convention is universal; the
 * codegraph side lives in
 * `src/core/domains/trajectory/codegraph/symbols/provider.ts`
 * (`rubyMacroEmission` + `rubyDefineMethodEmission`) — keep both in lockstep
 * when adding macro coverage.
 *
 * Without this helper, bare-id call resolution in the Ruby walker (bd
 * tea-rags-mcp-hbie) cannot land on `Class#attr` / `Class#delegated_method`,
 * and `get_callers` / `get_callees` produce empty results on Rails code that
 * uses these idioms heavily (bd tea-rags-mcp-3nf3 + tea-rags-mcp-zy3f).
 */

import type Parser from "tree-sitter";

import type { MacroSymbol } from "../../../../contracts/types/chunker.js";

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

/** Builder type: turn a base symbol name into one or more synthetic methods. */
type MacroBuilder = (base: string) => { name: string; kind: "instance" | "static" }[];

/**
 * Macro name → builder mapping. Only macros whose effect is "declare these
 * named methods on the enclosing class" appear here. AR associations
 * (`has_many`, `belongs_to`) intentionally live ONLY in the codegraph
 * provider for now — the chunker emits one chunk per macro NAME (not per
 * accessor), and AR association expansion would inflate accessor count
 * without changing chunk content semantics. The codegraph layer needs them
 * for symbol resolution, the chunker does not.
 */
const RUBY_DSL_MACROS: Record<string, MacroBuilder> = {
  attr_accessor: (b) => [
    { name: b, kind: "instance" },
    { name: `${b}=`, kind: "instance" },
  ],
  attr_reader: (b) => [{ name: b, kind: "instance" }],
  attr_writer: (b) => [{ name: `${b}=`, kind: "instance" }],
  // ActiveSupport class-level accessors — declare class methods.
  cattr_accessor: (b) => [
    { name: b, kind: "static" },
    { name: `${b}=`, kind: "static" },
  ],
  cattr_reader: (b) => [{ name: b, kind: "static" }],
  cattr_writer: (b) => [{ name: `${b}=`, kind: "static" }],
  mattr_accessor: (b) => [
    { name: b, kind: "static" },
    { name: `${b}=`, kind: "static" },
  ],
  mattr_reader: (b) => [{ name: b, kind: "static" }],
  mattr_writer: (b) => [{ name: `${b}=`, kind: "static" }],
};

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
export function extractRubyMacroSymbols(containerNode: Parser.SyntaxNode): RubyMacroSymbol[] {
  if (containerNode.type !== "class" && containerNode.type !== "module") return [];
  const body = containerNode.childForFieldName("body");
  // tree-sitter-ruby sometimes attaches body statements directly under the
  // class node when the grammar version doesn't expose a `body` field —
  // mirror the tolerant pattern from ruby-walker.ts `collectRubyClassAncestors`.
  const stmts = body ? body.children : containerNode.children;
  const out: RubyMacroSymbol[] = [];
  for (const stmt of stmts) {
    pushMacroSymbols(stmt, out);
    // `alias new old` keyword form is a distinct AST node, NOT a `call`.
    // Handle it alongside the macro-call recognition so both alias forms
    // emit identical synthetic instance-method symbols on the enclosing
    // class.
    pushAliasKeywordSymbol(stmt, out);
  }
  return out;
}

function pushMacroSymbols(node: Parser.SyntaxNode, out: RubyMacroSymbol[]): void {
  if (node.type !== "call" && node.type !== "method_call") return;
  // Receiver-qualified calls (`obj.attr_accessor :x`) are normal method
  // invocations, not class-body DSL. Same guard as
  // codegraph/symbols/provider.ts:rubyMacroEmission — keep behaviour in
  // lockstep so chunker symbolIds match cg_symbols rows.
  if (node.childForFieldName("receiver")) return;
  const methodField = node.childForFieldName("method");
  const methodNode = methodField ?? node.children.find((c) => c.type === "identifier");
  if (!methodNode) return;
  const macroName = methodNode.text;
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  // delegate :a, :b, to: :other — collect leading symbol args UNTIL the
  // first non-`simple_symbol` arg (usually a `pair` for the `to:` kwarg).
  // The `to:` value and any other kwargs are receivers / options, never
  // method names.
  if (macroName === "delegate") {
    const args = node.childForFieldName("arguments") ?? node.children.find((c) => c.type === "argument_list");
    if (!args) return;
    for (const arg of args.namedChildren) {
      if (arg.type !== "simple_symbol") break;
      const base = stripSymbolColon(arg.text);
      if (base.length === 0) continue;
      out.push({ name: base, kind: "instance", startLine, endLine });
    }
    return;
  }

  // `alias_method :new_name, :old_name` — declares a new instance method
  // `new_name` aliased to the existing `old_name` on the enclosing class.
  // Only the first symbol argument (the new method name) becomes a
  // synthetic symbol; the second symbol is the target of the alias and
  // is emitted as a synthetic CallRef by the walker (bd tea-rags-mcp-y2z5).
  if (macroName === "alias_method") {
    const args = node.childForFieldName("arguments") ?? node.children.find((c) => c.type === "argument_list");
    if (!args) return;
    const firstArg = args.namedChildren[0];
    if (firstArg?.type !== "simple_symbol") return;
    const name = stripSymbolColon(firstArg.text);
    if (name.length === 0) return;
    out.push({ name, kind: "instance", startLine, endLine });
    return;
  }

  // define_method(:name) — only fires for literal symbol / string arg.
  if (macroName === "define_method") {
    const args = node.childForFieldName("arguments") ?? node.children.find((c) => c.type === "argument_list");
    if (!args) return;
    const firstArg = args.namedChildren[0];
    if (!firstArg) return;
    const name = literalNameFromArg(firstArg);
    if (!name) return;
    out.push({ name, kind: "instance", startLine, endLine });
    return;
  }

  const builder = RUBY_DSL_MACROS[macroName];
  if (!builder) return;
  const args = node.childForFieldName("arguments") ?? node.children.find((c) => c.type === "argument_list");
  if (!args) return;
  for (const arg of args.namedChildren) {
    if (arg.type !== "simple_symbol") continue;
    const base = stripSymbolColon(arg.text);
    if (base.length === 0) continue;
    for (const m of builder(base)) {
      out.push({ name: m.name, kind: m.kind, startLine, endLine });
    }
  }
}

/**
 * `alias new_name old_name` — Ruby keyword form (not a call). The
 * tree-sitter `alias` node carries two `identifier` children: the new
 * method name then the old method name. Emit the new name as a synthetic
 * instance method on the enclosing class so the chunker and provider
 * agree on the symbolId for the alias.
 */
function pushAliasKeywordSymbol(node: Parser.SyntaxNode, out: RubyMacroSymbol[]): void {
  if (node.type !== "alias") return;
  // Skip the leading `alias` keyword child and pick up the first
  // identifier — that's the new method name.
  const idents = node.children.filter((c) => c.type === "identifier");
  const newName = idents[0]?.text;
  if (!newName) return;
  out.push({
    name: newName,
    kind: "instance",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  });
}

function stripSymbolColon(text: string): string {
  return text.startsWith(":") ? text.slice(1) : text;
}

function literalNameFromArg(arg: Parser.SyntaxNode): string | null {
  if (arg.type === "simple_symbol") {
    return stripSymbolColon(arg.text);
  }
  if (arg.type === "string" || arg.type === "string_literal") {
    const inner = arg.namedChildren.find((c) => c.type === "string_content");
    const text = inner ? inner.text : arg.text.replace(/^["']|["']$/g, "");
    return text.length > 0 ? text : null;
  }
  return null;
}
