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
import { RUBY_DSL, type DslCategory, type DslOperandsShape, type MethodKind } from "../dsl/index.js";

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

  // enum :status, { active: 0 } / enum status: { active: 0 } / enum status: [:active]
  // — the VALUE keys (not the leading symbol) drive synthesis: the attribute
  // accessor (`status`/`status=`) plus a predicate (`active?`) and bang
  // (`active!`) per value. Scopes (`Model.active`) are intentionally omitted —
  // they are conditional (`scopes: false`) and class-level, so synthesising them
  // risks fabricating an edge target the model may not define.
  if (macroName === "enum") {
    if (!args) return [];
    const first = args.namedChildren[0];
    let enumName: string | null = null;
    let valuesNode: AstNode | null = null;
    if (first?.type === "simple_symbol") {
      enumName = stripSymbolColon(first.text);
      valuesNode = args.namedChildren[1] ?? null;
    } else if (first?.type === "pair") {
      const key = first.childForFieldName("key") ?? first.namedChildren[0];
      enumName = key ? enumKeyName(key) : null;
      valuesNode = first.childForFieldName("value") ?? first.namedChildren[1] ?? null;
    }
    const values = valuesNode ? enumValueNames(valuesNode) : [];
    if (!enumName || values.length === 0) return [];
    const out: DeclaredMethod[] = [mk(enumName, "instance", "enum"), mk(`${enumName}=`, "instance", "enum")];
    for (const value of values) {
      out.push(mk(`${value}?`, "instance", "enum"), mk(`${value}!`, "instance", "enum"));
    }
    return out;
  }

  // aasm do; state :sleeping; event :run; end — AASM state machine. Synthesise a
  // predicate (`sleeping?`) per state and the event method + bang (`run`/`run!`)
  // per event. Gated on the `aasm` macro name AND on the inner `state`/`event`
  // keywords inside ITS block, so a stray `state`/`event` elsewhere is never
  // expanded. Scopes (`Model.sleeping`) are omitted — conditional on
  // `create_scopes` and class-level; the predicate/event methods are always made.
  if (macroName === "aasm") {
    const block =
      node.childForFieldName("block") ?? node.children.find((c) => c.type === "do_block" || c.type === "block");
    if (!block) return [];
    const body = block.childForFieldName("body") ?? block;
    const out: DeclaredMethod[] = [];
    for (const stmt of body.namedChildren) {
      if (stmt.type !== "call" && stmt.type !== "method_call") continue;
      const inner = stmt.childForFieldName("method") ?? stmt.children.find((c) => c.type === "identifier");
      const innerName = inner?.text;
      if (innerName !== "state" && innerName !== "event") continue;
      const innerArgs = stmt.childForFieldName("arguments") ?? stmt.children.find((c) => c.type === "argument_list");
      const firstSym = innerArgs?.namedChildren[0];
      if (firstSym?.type !== "simple_symbol") continue;
      const base = stripSymbolColon(firstSym.text);
      if (base.length === 0) continue;
      if (innerName === "state") {
        out.push(mk(`${base}?`, "instance", "state-machine"));
      } else {
        out.push(mk(base, "instance", "state-machine"), mk(`${base}!`, "instance", "state-machine"));
      }
    }
    return out;
  }

  // Generic declarative dispatch: look up the operands shape from the catalogue
  // entry and project each extracted base through `declares`.
  const entry = RUBY_DSL[macroName];
  if (!entry) return [];
  const { declares, category, operands } = entry;
  if (!declares || !args) return [];
  const shape = operands ?? "leading-symbols";
  const bases = extractOperands(args, shape);
  return bases.flatMap((b) => declares(b)).map((m) => mk(m.name, m.kind, category));
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

/** Value names of an enum's values container — `hash` keys or `array` symbols. */
function enumValueNames(node: AstNode): string[] {
  const out: string[] = [];
  if (node.type === "hash") {
    for (const pair of node.namedChildren) {
      if (pair.type !== "pair") continue;
      const key = pair.childForFieldName("key") ?? pair.namedChildren[0];
      const name = key ? enumKeyName(key) : null;
      if (name) out.push(name);
    }
  } else if (node.type === "array") {
    for (const el of node.namedChildren) {
      const name = enumKeyName(el);
      if (name) out.push(name);
    }
  }
  return out;
}

/** A single enum key/value name from a `hash_key_symbol` / `simple_symbol` / string node. */
function enumKeyName(node: AstNode): string | null {
  if (node.type === "hash_key_symbol") {
    const text = node.text.replace(/:$/, "");
    return text.length > 0 ? text : null;
  }
  return literalNameFromArg(node);
}
