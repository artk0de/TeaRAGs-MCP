/**
 * Ruby class-body macro expansion — turns a class-body DSL macro call into the
 * synthetic methods it declares (`attr_accessor :a` → `a`/`a=`; `has_many :posts`
 * → `posts`/`posts=`/`post_ids`/…). Consumed by the CODEGRAPH alone
 * (`walker/name-of.ts` → `cg_symbols`), so bare calls onto these runtime-defined
 * methods resolve. The chunker does NOT expand macros to per-method chunks — it
 * represents class-body DSL through category grouping (`class-body-chunker.ts`).
 *
 * Per-macro argument extraction (which symbols a call declares) lives HERE, not
 * in the pure-data `dsl/` catalogue: it needs the tree-sitter `AstNode`. The
 * catalogue hands an already-parsed `base` via `RubyDslEntry.declares`.
 */
import type { AstNode } from "../../../../contracts/types/ast.js";
import { RUBY_DSL, type DslCategory, type MethodKind } from "../dsl/index.js";

/** A synthetic method a class-body macro declares, with provenance category + span. */
export interface DeclaredMethod {
  name: string;
  kind: MethodKind;
  category: DslCategory;
  startLine: number;
  endLine: number;
}

/**
 * Expand a class-body macro `call` / `method_call` node into the methods it
 * declares. Returns `[]` for receiver-qualified calls and non-macro names.
 */
export function expandClassBodyMacros(node: AstNode): DeclaredMethod[] {
  if (node.type !== "call" && node.type !== "method_call") return [];
  // Receiver-qualified (`obj.attr_accessor :x`) is a normal invocation, not DSL.
  if (node.childForFieldName("receiver")) return [];
  const methodNode = node.childForFieldName("method") ?? node.children.find((c) => c.type === "identifier");
  if (!methodNode) return [];
  const macroName = methodNode.text;
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;
  const mk = (name: string, kind: MethodKind, category: DslCategory): DeclaredMethod => ({
    name,
    kind,
    category,
    startLine,
    endLine,
  });
  const args = node.childForFieldName("arguments") ?? node.children.find((c) => c.type === "argument_list");

  // define_method(:foo) / define_method("foo") — literal symbol/string arg only.
  if (macroName === "define_method") {
    const first = args?.namedChildren[0];
    const name = first ? literalNameFromArg(first) : null;
    return name ? [mk(name, "instance", "dynamic-method")] : [];
  }
  // alias_method :new, :old — only the NEW name (first symbol) is declared.
  if (macroName === "alias_method") {
    const first = args?.namedChildren[0];
    if (first?.type !== "simple_symbol") return [];
    const name = stripSymbolColon(first.text);
    return name.length > 0 ? [mk(name, "instance", "alias")] : [];
  }
  // delegate :a, :b, to: :other — leading symbols, STOP at the first non-symbol
  // (the `to:` / `prefix:` kwarg pair), which is a receiver/option, not a name.
  if (macroName === "delegate") {
    if (!args) return [];
    const out: DeclaredMethod[] = [];
    for (const arg of args.namedChildren) {
      if (arg.type !== "simple_symbol") break;
      const base = stripSymbolColon(arg.text);
      if (base.length > 0) out.push(mk(base, "instance", "delegation"));
    }
    return out;
  }

  // Generic: project each leading symbol arg through the catalogue `declares`.
  const entry = RUBY_DSL[macroName];
  if (!entry?.declares || !args) return [];
  const builder = entry.declares;
  const { category } = entry;
  const bases: string[] = [];
  for (const arg of args.namedChildren) {
    if (arg.type !== "simple_symbol") continue;
    const base = stripSymbolColon(arg.text);
    if (base.length > 0) bases.push(base);
  }
  if (bases.length === 0) return [];
  // First-symbol-only macros: `scope :active, -> { ... }` (rest is the lambda)
  // and `attribute :name, :string` (2nd positional symbol is the cast type, not
  // a second attribute name).
  if (macroName === "scope" || macroName === "attribute") {
    return builder(bases[0]).map((m) => mk(m.name, m.kind, category));
  }
  const out: DeclaredMethod[] = [];
  for (const base of bases) {
    for (const m of builder(base)) out.push(mk(m.name, m.kind, category));
  }
  return out;
}

/**
 * `alias new_name old_name` keyword form — a distinct AST node (`alias`), not a
 * `call`. The first `identifier` child is the new method name.
 */
export function expandAliasKeyword(node: AstNode): DeclaredMethod[] {
  if (node.type !== "alias") return [];
  const newName = node.children.filter((c) => c.type === "identifier")[0]?.text;
  if (!newName) return [];
  return [
    {
      name: newName,
      kind: "instance",
      category: "alias",
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    },
  ];
}

function stripSymbolColon(text: string): string {
  return text.startsWith(":") ? text.slice(1) : text;
}

function literalNameFromArg(arg: AstNode): string | null {
  if (arg.type === "simple_symbol") return stripSymbolColon(arg.text);
  if (arg.type === "string" || arg.type === "string_literal") {
    const inner = arg.namedChildren.find((c) => c.type === "string_content");
    const text = inner ? inner.text : arg.text.replace(/^["']|["']$/g, "");
    return text.length > 0 ? text : null;
  }
  return null;
}
