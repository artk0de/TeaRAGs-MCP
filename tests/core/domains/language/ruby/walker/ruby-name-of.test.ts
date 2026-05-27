/**
 * Direct unit tests for `rbNameOf` — the codegraph-side Ruby `nameOf`
 * (src/core/domains/language/ruby/walker/name-of.ts). The provider tests in
 * `domains/trajectory/codegraph/symbols/provider.test.ts` exercise the
 * end-to-end symbol-table emission, but they route through
 * `provider.buildFileSignals`. These tests call `rbNameOf` directly on a parsed
 * macro `call` node — the same shape `collectSymbols` passes in at runtime —
 * to pin the DSL-macro emission contract.
 *
 * Convention mirrors the sibling chunker test `ruby-macros.test.ts`: Parser +
 * RbLang, a `parse()` helper, a container finder. `rbNameOf` returns
 * `NamedSymbol[]` with shape `{ name, descendsInto, methodKind }` (NOT the
 * chunker's `{ name, kind, startLine, endLine }`).
 */

import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { rbNameOf } from "../../../../../../src/core/domains/language/ruby/walker/name-of.js";

function parse(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(RbLang as unknown as Parser.Language);
  return parser.parse(src);
}

/**
 * Find the first `call` / `method_call` node whose method identifier text
 * matches `macroName`, searching the body of the first `class`/`module`
 * container in the tree. This is the macro-call node `collectSymbols` would
 * hand to `rbNameOf`.
 */
function findMacroCall(tree: Parser.Tree, macroName: string): Parser.SyntaxNode {
  const stack: Parser.SyntaxNode[] = [tree.rootNode];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "call" || node.type === "method_call") {
      const methodField = node.childForFieldName("method");
      const methodNode = methodField ?? node.children.find((c) => c.type === "identifier");
      if (methodNode?.text === macroName) return node;
    }
    for (const child of node.namedChildren) stack.push(child);
  }
  throw new Error(`No ${macroName} call node found`);
}

/** Find the first node of a given tree-sitter `type` (depth-first). */
function findFirst(tree: Parser.Tree, type: string): Parser.SyntaxNode {
  const stack: Parser.SyntaxNode[] = [tree.rootNode];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === type) return node;
    for (const child of node.namedChildren) stack.push(child);
  }
  throw new Error(`No ${type} node found`);
}

describe("rbNameOf — class/module-level accessor macros (catalogue-derived)", () => {
  it("rbNameOf emits cattr_accessor as static class-level accessors (catalogue-derived)", () => {
    const tree = parse("class C\n  cattr_accessor :shared\nend\n");
    const node = findMacroCall(tree, "cattr_accessor");
    expect(rbNameOf(node)).toEqual([
      { name: "shared", descendsInto: false, methodKind: "static" },
      { name: "shared=", descendsInto: false, methodKind: "static" },
    ]);
  });

  it("rbNameOf emits mattr_accessor as static class-level accessors (catalogue-derived)", () => {
    const tree = parse("module M\n  mattr_accessor :defaults\nend\n");
    const node = findMacroCall(tree, "mattr_accessor");
    expect(rbNameOf(node)).toEqual([
      { name: "defaults", descendsInto: false, methodKind: "static" },
      { name: "defaults=", descendsInto: false, methodKind: "static" },
    ]);
  });
});

describe("rbNameOf — macros inside class << self (singleton_class)", () => {
  // Bug tea-rags-mcp-zz7d: a macro inside `class << self` declares a
  // CLASS-level method → STATIC (`Foo.method`) per
  // .claude/rules/symbolid-convention.md — NOT instance, even though the
  // macro itself is a plain attr_accessor that is instance-level at class body.
  it("rbNameOf emits attr_accessor inside class << self as static", () => {
    const tree = parse("class Foo\n  class << self\n    attr_accessor :registry\n  end\nend\n");
    const node = findMacroCall(tree, "attr_accessor");
    expect(rbNameOf(node)).toEqual([
      { name: "registry", descendsInto: false, methodKind: "static" },
      { name: "registry=", descendsInto: false, methodKind: "static" },
    ]);
  });
});

describe("rbNameOf — method nodes (classifyMethod routing)", () => {
  it("rbNameOf emits a plain instance method with `#` kind", () => {
    const tree = parse("class C\n  def greet\n  end\nend\n");
    const node = findFirst(tree, "method");
    expect(rbNameOf(node)).toEqual({ name: "greet", descendsInto: false, methodKind: "instance" });
  });

  it("rbNameOf emits a `def self.foo` singleton_method as static", () => {
    const tree = parse("class C\n  def self.build\n  end\nend\n");
    const node = findFirst(tree, "singleton_method");
    expect(rbNameOf(node)).toEqual({ name: "build", descendsInto: false, methodKind: "static" });
  });

  it("rbNameOf emits a method inside `class << self` as static", () => {
    const tree = parse("class C\n  class << self\n    def make\n    end\n  end\nend\n");
    const node = findFirst(tree, "method");
    expect(rbNameOf(node)).toEqual({ name: "make", descendsInto: false, methodKind: "static" });
  });
});

describe("rbNameOf — `extend self` module promotion (bd tea-rags-mcp-08v2)", () => {
  it("rbNameOf emits BOTH instance and static forms for a method in an `extend self` module", () => {
    const tree = parse("module M\n  extend self\n  def helper\n  end\nend\n");
    const node = findFirst(tree, "method");
    expect(rbNameOf(node)).toEqual([
      { name: "helper", descendsInto: false, methodKind: "instance" },
      { name: "helper", descendsInto: false, methodKind: "static" },
    ]);
  });

  it("rbNameOf emits only the instance form for a method in a module WITHOUT extend self", () => {
    const tree = parse("module M\n  def helper\n  end\nend\n");
    const node = findFirst(tree, "method");
    expect(rbNameOf(node)).toEqual({ name: "helper", descendsInto: false, methodKind: "instance" });
  });

  it("rbNameOf emits only the instance form for a top-level method (no class/module ancestor)", () => {
    const tree = parse("def freestanding\nend\n");
    const node = findFirst(tree, "method");
    expect(rbNameOf(node)).toEqual({ name: "freestanding", descendsInto: false, methodKind: "instance" });
  });
});

describe("rbNameOf — class/module containers", () => {
  it("rbNameOf emits a simple class name with descendsInto", () => {
    const tree = parse("class Widget\nend\n");
    const node = findFirst(tree, "class");
    expect(rbNameOf(node)).toEqual({ name: "Widget", descendsInto: true });
  });

  it("rbNameOf composes a scope_resolution class name (Acme::Auth)", () => {
    const tree = parse("class Acme::Auth\nend\n");
    const node = findFirst(tree, "class");
    expect(rbNameOf(node)).toEqual({ name: "Acme::Auth", descendsInto: true });
  });

  it("rbNameOf composes a nested scope_resolution class name (A::B::C)", () => {
    const tree = parse("class A::B::C\nend\n");
    const node = findFirst(tree, "class");
    expect(rbNameOf(node)).toEqual({ name: "A::B::C", descendsInto: true });
  });
});

describe("rbNameOf — define_method", () => {
  it("rbNameOf emits an instance method from define_method with a symbol arg", () => {
    const tree = parse("class C\n  define_method(:dynamic) { 1 }\nend\n");
    const node = findMacroCall(tree, "define_method");
    expect(rbNameOf(node)).toEqual({ name: "dynamic", descendsInto: false, methodKind: "instance" });
  });

  it("rbNameOf emits an instance method from define_method with a string arg", () => {
    const tree = parse('class C\n  define_method("strung") { 1 }\nend\n');
    const node = findMacroCall(tree, "define_method");
    expect(rbNameOf(node)).toEqual({ name: "strung", descendsInto: false, methodKind: "instance" });
  });
});

describe("rbNameOf — alias_method and alias keyword", () => {
  it("rbNameOf emits the new name from alias_method as an instance method", () => {
    const tree = parse("class C\n  alias_method :fresh, :stale\nend\n");
    const node = findMacroCall(tree, "alias_method");
    expect(rbNameOf(node)).toEqual({ name: "fresh", descendsInto: false, methodKind: "instance" });
  });

  it("rbNameOf emits the new name from the `alias` keyword form", () => {
    const tree = parse("class C\n  alias fresh stale\nend\n");
    const node = findFirst(tree, "alias");
    expect(rbNameOf(node)).toEqual({ name: "fresh", descendsInto: false, methodKind: "instance" });
  });

  it("rbNameOf emits alias_method inside class << self as static", () => {
    const tree = parse("class C\n  class << self\n    alias_method :fresh, :stale\n  end\nend\n");
    const node = findMacroCall(tree, "alias_method");
    expect(rbNameOf(node)).toEqual({ name: "fresh", descendsInto: false, methodKind: "static" });
  });
});

describe("rbNameOf — AR association macros (locally synthesised)", () => {
  it("rbNameOf emits has_many reader and writer accessors", () => {
    const tree = parse("class Order\n  has_many :products\nend\n");
    const node = findMacroCall(tree, "has_many");
    expect(rbNameOf(node)).toEqual([
      { name: "products", descendsInto: false, methodKind: "instance" },
      { name: "products=", descendsInto: false, methodKind: "instance" },
    ]);
  });

  it("rbNameOf emits belongs_to reader, writer, id reader and id writer", () => {
    const tree = parse("class Product\n  belongs_to :order\nend\n");
    const node = findMacroCall(tree, "belongs_to");
    expect(rbNameOf(node)).toEqual([
      { name: "order", descendsInto: false, methodKind: "instance" },
      { name: "order=", descendsInto: false, methodKind: "instance" },
      { name: "order_id", descendsInto: false, methodKind: "instance" },
      { name: "order_id=", descendsInto: false, methodKind: "instance" },
    ]);
  });

  it("rbNameOf emits has_one reader and writer accessors", () => {
    const tree = parse("class Order\n  has_one :invoice\nend\n");
    const node = findMacroCall(tree, "has_one");
    expect(rbNameOf(node)).toEqual([
      { name: "invoice", descendsInto: false, methodKind: "instance" },
      { name: "invoice=", descendsInto: false, methodKind: "instance" },
    ]);
  });

  it("rbNameOf emits has_and_belongs_to_many reader and writer accessors", () => {
    const tree = parse("class Order\n  has_and_belongs_to_many :tags\nend\n");
    const node = findMacroCall(tree, "has_and_belongs_to_many");
    expect(rbNameOf(node)).toEqual([
      { name: "tags", descendsInto: false, methodKind: "instance" },
      { name: "tags=", descendsInto: false, methodKind: "instance" },
    ]);
  });

  it("rbNameOf emits multiple accessor sets for has_many with several symbol args", () => {
    const tree = parse("class Order\n  has_many :products, :coupons\nend\n");
    const node = findMacroCall(tree, "has_many");
    expect(rbNameOf(node)).toEqual([
      { name: "products", descendsInto: false, methodKind: "instance" },
      { name: "products=", descendsInto: false, methodKind: "instance" },
      { name: "coupons", descendsInto: false, methodKind: "instance" },
      { name: "coupons=", descendsInto: false, methodKind: "instance" },
    ]);
  });

  it("rbNameOf emits scope as a single static class method (first arg only)", () => {
    const tree = parse("class Order\n  scope :active, -> { where(active: true) }\nend\n");
    const node = findMacroCall(tree, "scope");
    expect(rbNameOf(node)).toEqual([{ name: "active", descendsInto: false, methodKind: "static" }]);
  });
});

describe("rbNameOf — non-symbol nodes return null", () => {
  it("rbNameOf returns null for an unrelated node type (integer literal)", () => {
    const tree = parse("42\n");
    const node = findFirst(tree, "integer");
    expect(rbNameOf(node)).toBeNull();
  });

  it("rbNameOf returns null for a plain method call that is not a macro/define/alias", () => {
    const tree = parse("class C\n  puts :hello\nend\n");
    const node = findMacroCall(tree, "puts");
    expect(rbNameOf(node)).toBeNull();
  });
});
