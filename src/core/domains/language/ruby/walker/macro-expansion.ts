/**
 * Unified Ruby class-body macro expansion — the SINGLE site that turns a
 * class-body DSL macro call into the synthetic methods it declares. Both
 * consumers read it:
 *   - chunker `macros.ts` → `MacroSymbol[]` (Qdrant chunk payload), applying its
 *     own category-policy filter;
 *   - codegraph `name-of.ts` → `NamedSymbol[]` (`cg_symbols`), taking all.
 *
 * One engine means the chunker and codegraph cannot silently disagree on which
 * synthetic methods a macro declares — the lockstep the symbolId convention
 * requires (`.claude/rules/symbolid-convention.md`).
 *
 * Per-macro argument extraction (which symbols a call declares) lives HERE, not
 * in the pure-data `dsl/` catalogue: it needs the tree-sitter `AstNode`. The
 * catalogue hands an already-parsed `base` via `RubyDslEntry.declares`.
 */
import type { AstNode } from "../../../../contracts/types/ast.js";
import { RUBY_DSL, type DeclaredMethodSpec, type DslCategory, type MethodKind } from "../dsl/index.js";

/** A synthetic method a class-body macro declares, with provenance category + span. */
export interface DeclaredMethod {
  name: string;
  kind: MethodKind;
  category: DslCategory;
  startLine: number;
  endLine: number;
}

/**
 * AR-association macros the CODEGRAPH synthesises but the shared catalogue keeps
 * GROUP-ONLY at Phase B (no `declares`). TRANSITIONAL: Phase C moves these into
 * the `rails.ts` module's `declares` and deletes this map. Until then the engine
 * consults it so codegraph output is unchanged while the duplicated expansion
 * logic is consolidated here. The chunker filters these categories out (it never
 * emitted association/scope accessors) — see `macros.ts`.
 *
 * Out of scope (intentional, both layers): method_missing, dynamically built
 * names, `included do` Concern mixin merge.
 */
const AR_ASSOCIATION_MACROS: Record<string, (base: string) => DeclaredMethodSpec[]> = {
  has_many: (b) => [
    { name: b, kind: "instance" },
    { name: `${b}=`, kind: "instance" },
  ],
  has_one: (b) => [
    { name: b, kind: "instance" },
    { name: `${b}=`, kind: "instance" },
  ],
  has_and_belongs_to_many: (b) => [
    { name: b, kind: "instance" },
    { name: `${b}=`, kind: "instance" },
  ],
  belongs_to: (b) => [
    { name: b, kind: "instance" },
    { name: `${b}=`, kind: "instance" },
    { name: `${b}_id`, kind: "instance" },
    { name: `${b}_id=`, kind: "instance" },
  ],
  scope: (b) => [{ name: b, kind: "static" }],
};

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

  // Generic: catalogue `declares` (or the transitional AR-association builder).
  const entry = RUBY_DSL[macroName];
  const builder = AR_ASSOCIATION_MACROS[macroName] ?? entry?.declares;
  if (!builder || !args) return [];
  const category = entry?.category ?? "association";
  const bases: string[] = [];
  for (const arg of args.namedChildren) {
    if (arg.type !== "simple_symbol") continue;
    const base = stripSymbolColon(arg.text);
    if (base.length > 0) bases.push(base);
  }
  if (bases.length === 0) return [];
  // `scope :active, -> { ... }` — only the first symbol names the method.
  if (macroName === "scope") {
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
