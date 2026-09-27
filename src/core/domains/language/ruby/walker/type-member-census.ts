/**
 * Ruby type member census (bd tea-rags-mcp-ffxfc) — how many of the members a
 * class or module body writes are BEHAVIOUR and how many are DATA, for
 * `FileExtraction.typeMemberCensus`. The class-hierarchy walk calls it on each
 * body it records, over the same flattened statements its mixin reader sees
 * (`class << self` and self-scoped blocks such as `included do` pulled up).
 *
 *   | statement                                                    | counts as    |
 *   | ------------------------------------------------------------ | ------------ |
 *   | `def x`, `def self.x`, a `def` passed to a macro             | method       |
 *   | (`private def x`, `module_function def x`)                   |              |
 *   | each name an `accessor`-category DSL macro declares           | field        |
 *   | (`attr_accessor`, `attribute`, `store_accessor`, `cattr_*`) |              |
 *   | each symbol of a `Struct.new(…)` / `Data.define(…)` base     | field        |
 *   | `def x` / `def x=` re-implementing a field of the body       | (that field) |
 *   | any other macro (`has_many`, `scope`, `delegate`)            | —            |
 *
 * Which macro declares data is the DSL catalogue's `accessor` category, read
 * through the same gem-gated `expandClassBodyMacros` the codegraph uses, so a
 * macro the project's Gemfile does not activate declares nothing here either.
 * An accessor declares ONE field: `cg_symbols` records `attr_accessor :a` as a
 * reader and a writer method, which is what the resolver needs to land `obj.a`
 * and `obj.a = 1`, and which made data classes read as behaviour. That table is
 * not touched here. Other categories declare members whose kind is the DSL's —
 * an association is neither a plain field nor behaviour — so they are not
 * counted either way. A singleton member (`def self.x`, `cattr_accessor :x`) is
 * its own name (`.x`), so it never merges with an instance `x`.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import { FULL_RUBY_CATALOGUE, type RubyDslCatalogue } from "../dsl/index.js";
import { expandClassBodyMacros } from "./macro-expansion.js";

export interface RubyMemberCounts {
  methodCount: number;
  fieldCount: number;
}

/** `Struct.new(…)` / `Data.define(…)` — the receiver constant and the method that builds a value class. */
const VALUE_CLASS_BUILDERS: ReadonlyMap<string, string> = new Map([
  ["Struct", "new"],
  ["Data", "define"],
]);

function callArguments(call: AstNode): readonly AstNode[] {
  return call.childForFieldName("arguments")?.namedChildren ?? [];
}

/**
 * The member names a `Struct.new(:a, :b)` / `Data.define(:a, :b)` call declares,
 * or null when `node` is no such call. A `Struct.new("Name", :a)` class-name
 * string and a `keyword_init: true` pair are not members.
 */
export function valueClassMemberNames(node: AstNode | null | undefined): string[] | null {
  if (node?.type !== "call") return null;
  const receiver = node.childForFieldName("receiver")?.text.replace(/^::/, "");
  const method = node.childForFieldName("method")?.text;
  if (receiver === undefined || method === undefined || VALUE_CLASS_BUILDERS.get(receiver) !== method) return null;
  return callArguments(node)
    .filter((arg) => arg.type === "simple_symbol")
    .map((arg) => arg.text.slice(1));
}

/** The name a `def` declares: `x` for an instance method, `.x` for a singleton one. */
function definedName(node: AstNode): string | null {
  const name = node.childForFieldName("name")?.text;
  if (name === undefined) return null;
  return node.type === "singleton_method" ? `.${name}` : name;
}

/**
 * The census of one class / module body. `statements` is the body as the
 * class-hierarchy walk flattens it; `baseFields` are the members a value-class
 * superclass (`< Struct.new(:x)`) or builder call already declares; `catalogue`
 * is the project's gem-gated DSL catalogue.
 */
export function rubyBodyMemberCounts(
  statements: readonly AstNode[],
  baseFields: readonly string[] = [],
  catalogue: RubyDslCatalogue = FULL_RUBY_CATALOGUE,
): RubyMemberCounts {
  const fields = new Set<string>(baseFields);
  const methods = new Set<string>();
  const recordDef = (node: AstNode): void => {
    const name = definedName(node);
    if (name !== null) methods.add(name);
  };
  for (const stmt of statements) {
    if (stmt.type === "method" || stmt.type === "singleton_method") {
      recordDef(stmt);
      continue;
    }
    if (stmt.type !== "call" || stmt.childForFieldName("receiver")) continue;
    for (const arg of callArguments(stmt)) {
      if (arg.type === "method" || arg.type === "singleton_method") recordDef(arg);
    }
    for (const declared of expandClassBodyMacros(stmt, catalogue)) {
      if (declared.category !== "accessor") continue;
      const name = declared.name.endsWith("=") ? declared.name.slice(0, -1) : declared.name;
      fields.add(declared.kind === "static" ? `.${name}` : name);
    }
  }
  let methodCount = 0;
  for (const name of methods) {
    if (!fields.has(name.endsWith("=") ? name.slice(0, -1) : name)) methodCount++;
  }
  return { methodCount, fieldCount: fields.size };
}
