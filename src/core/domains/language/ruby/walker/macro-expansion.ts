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
import {
  FULL_RUBY_CATALOGUE,
  type DslCategory,
  type DslOperandsShape,
  type MethodKind,
  type RubyDslCatalogue,
} from "../dsl/index.js";
import { STRUCTURED_MACROS } from "./structured/index.js";
import { literalNameFromArg, stripSymbolColon, type DeclaredMethod } from "./structured/types.js";

export type { DeclaredMethod } from "./structured/types.js";

/**
 * Expand a class-body macro `call` / `method_call` node into the methods it
 * declares. Returns `[]` for receiver-qualified calls and non-macro names.
 *
 * A `declaresFixed` macro invoked BARE (no args, e.g. `has_paper_trail`) parses
 * as a lone `identifier`, not a `call` — handled by {@link expandBareFixedMacro}
 * so the fixed method set is synthesised for the common argument-less form.
 *
 * `catalogue` is the per-project gem-gated DSL catalogue (default
 * FULL_RUBY_CATALOGUE — every grammar active, byte-identical to pre-gating). A
 * gem-gated declaring macro (`mount_uploader`) or structured macro (`aasm`)
 * expands ONLY when its gem is in the catalogue's active set (bd tea-rags-mcp-o5kwh).
 */
export function expandClassBodyMacros(
  node: AstNode,
  catalogue: RubyDslCatalogue = FULL_RUBY_CATALOGUE,
): DeclaredMethod[] {
  // Bare receiver-less fixed-macro invocation (`has_paper_trail` with no args)
  // parses as a lone `identifier`, not a `call`; it still declares its fixed set.
  if (node.type === "identifier") return expandBareFixedMacro(node, catalogue);
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

  // Structural macros (enum, aasm) — walk the AST for their inner declarations,
  // but ONLY when the gem owning the structured macro is active in this project's
  // catalogue (enum unconditional; aasm gem-gated). Gated off → [].
  const structured = STRUCTURED_MACROS.find((e) => e.macroName === macroName);
  if (structured) {
    return catalogue.activeStructuredMacros.has(macroName) ? structured.expand(node, startLine, endLine) : [];
  }

  // Generic declarative dispatch: look up the operands shape from the catalogue
  // entry and project each extracted base through `declares`.
  const entry = catalogue.entries[macroName];
  if (!entry) return [];
  const { declares, declaresFixed, category, operands } = entry;
  // Operand-LESS fixed declaration: the macro declares a CONSTANT method set
  // regardless of its arguments (`has_paper_trail` → versions/…; `geocoded_by
  // :col` → geocode). Emit the fixed names verbatim — no operand extraction.
  if (declaresFixed) {
    return declaresFixed.map((m) => mk(m.name, m.kind, category));
  }
  if (!declares || !args) return [];
  const shape = operands ?? "leading-symbols";
  const bases = extractOperands(args, shape);
  return bases.flatMap((b) => declares(b)).map((m) => mk(m.name, m.kind, category));
}

/**
 * Expand a BARE (argument-less) `declaresFixed` macro that parses as a lone
 * `identifier` statement (`has_paper_trail`). Fires ONLY when the identifier is a
 * standalone class/module-body statement (parent `body_statement`) — NOT when it
 * is a call's method-name child (parent `call`), which the call branch of
 * {@link expandClassBodyMacros} already expanded, so double emission is avoided.
 * Gated by the per-project catalogue exactly as the call form.
 */
function expandBareFixedMacro(node: AstNode, catalogue: RubyDslCatalogue): DeclaredMethod[] {
  // A bare macro statement's identifier sits directly under a `body_statement`;
  // an identifier that is a call's method name sits under the `call` node itself.
  if (node.parent?.type !== "body_statement") return [];
  const entry = catalogue.entries[node.text];
  if (!entry?.declaresFixed) return [];
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;
  return entry.declaresFixed.map((m) => ({
    name: m.name,
    kind: m.kind,
    category: entry.category,
    startLine,
    endLine,
  }));
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

/**
 * Extract base symbol names from a macro call's argument list according to the
 * declarative `shape` descriptor attached to the catalogue `RubyDslEntry`.
 *
 * | Shape                                          | Semantics                                          |
 * |------------------------------------------------|----------------------------------------------------|
 * | `'literal-name'`                               | First arg: `simple_symbol` OR string literal       |
 * | `'first-symbol'`                               | First namedChild if `simple_symbol`, else `[]`     |
 * | `'skip-first'`                                 | All `simple_symbol`s, skipping the first           |
 * | `'leading-symbols'`                            | All `simple_symbol`s, CONTINUE past non-symbols    |
 * | `{ kind: 'leading-symbols', stopAtKwarg: true }` | All `simple_symbol`s, BREAK at first non-symbol  |
 *
 * Returns `[]` when `args` is `null`.
 */
export function extractOperands(args: AstNode | null, shape: DslOperandsShape): string[] {
  if (!args) return [];
  if (shape === "literal-name") {
    const first = args.namedChildren[0];
    const name = first ? literalNameFromArg(first) : null;
    return name ? [name] : [];
  }
  if (shape === "first-symbol") {
    const first = args.namedChildren[0];
    if (first?.type !== "simple_symbol") return [];
    const name = stripSymbolColon(first.text);
    return name.length > 0 ? [name] : [];
  }
  if (shape === "skip-first") {
    const syms: string[] = [];
    for (const arg of args.namedChildren) {
      if (arg.type !== "simple_symbol") continue;
      const base = stripSymbolColon(arg.text);
      if (base.length > 0) syms.push(base);
    }
    return syms.slice(1);
  }
  // 'leading-symbols' (string) or { kind: 'leading-symbols', stopAtKwarg: true }
  const stopAtKwarg = typeof shape === "object" && shape.stopAtKwarg;
  const out: string[] = [];
  for (const arg of args.namedChildren) {
    if (arg.type !== "simple_symbol") {
      if (stopAtKwarg) break;
      continue;
    }
    const base = stripSymbolColon(arg.text);
    if (base.length > 0) out.push(base);
  }
  return out;
}
