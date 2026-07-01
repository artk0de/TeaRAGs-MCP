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

describe("rbNameOf — AR association macros (catalogue-synthesised)", () => {
  it("rbNameOf emits has_many collection accessors + id collection", () => {
    const tree = parse("class Order\n  has_many :products\nend\n");
    const node = findMacroCall(tree, "has_many");
    expect(rbNameOf(node)).toEqual([
      { name: "products", descendsInto: false, methodKind: "instance" },
      { name: "products=", descendsInto: false, methodKind: "instance" },
      { name: "product_ids", descendsInto: false, methodKind: "instance" },
      { name: "product_ids=", descendsInto: false, methodKind: "instance" },
    ]);
  });

  it("rbNameOf emits belongs_to reader/writer, build/create, id reader/writer", () => {
    const tree = parse("class Product\n  belongs_to :order\nend\n");
    const node = findMacroCall(tree, "belongs_to");
    expect(rbNameOf(node)).toEqual([
      { name: "order", descendsInto: false, methodKind: "instance" },
      { name: "order=", descendsInto: false, methodKind: "instance" },
      { name: "build_order", descendsInto: false, methodKind: "instance" },
      { name: "create_order", descendsInto: false, methodKind: "instance" },
      { name: "order_id", descendsInto: false, methodKind: "instance" },
      { name: "order_id=", descendsInto: false, methodKind: "instance" },
    ]);
  });

  it("rbNameOf emits has_one reader/writer + build/create", () => {
    const tree = parse("class Order\n  has_one :invoice\nend\n");
    const node = findMacroCall(tree, "has_one");
    expect(rbNameOf(node)).toEqual([
      { name: "invoice", descendsInto: false, methodKind: "instance" },
      { name: "invoice=", descendsInto: false, methodKind: "instance" },
      { name: "build_invoice", descendsInto: false, methodKind: "instance" },
      { name: "create_invoice", descendsInto: false, methodKind: "instance" },
    ]);
  });

  it("rbNameOf emits has_and_belongs_to_many collection accessors + id collection", () => {
    const tree = parse("class Order\n  has_and_belongs_to_many :tags\nend\n");
    const node = findMacroCall(tree, "has_and_belongs_to_many");
    expect(rbNameOf(node)).toEqual([
      { name: "tags", descendsInto: false, methodKind: "instance" },
      { name: "tags=", descendsInto: false, methodKind: "instance" },
      { name: "tag_ids", descendsInto: false, methodKind: "instance" },
      { name: "tag_ids=", descendsInto: false, methodKind: "instance" },
    ]);
  });

  it("rbNameOf emits multiple accessor sets for has_many with several symbol args", () => {
    const tree = parse("class Order\n  has_many :products, :coupons\nend\n");
    const node = findMacroCall(tree, "has_many");
    expect(rbNameOf(node)).toEqual([
      { name: "products", descendsInto: false, methodKind: "instance" },
      { name: "products=", descendsInto: false, methodKind: "instance" },
      { name: "product_ids", descendsInto: false, methodKind: "instance" },
      { name: "product_ids=", descendsInto: false, methodKind: "instance" },
      { name: "coupons", descendsInto: false, methodKind: "instance" },
      { name: "coupons=", descendsInto: false, methodKind: "instance" },
      { name: "coupon_ids", descendsInto: false, methodKind: "instance" },
      { name: "coupon_ids=", descendsInto: false, methodKind: "instance" },
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

describe("rbNameOf — toStaticKind array branch (macro inside class << self)", () => {
  it("association array result is converted to all-static via toStaticKind", () => {
    // has_many :posts inside class << self → the association builder returns an
    // ARRAY (not a single NamedSymbol) → toStaticKind must handle the array branch.
    const tree = parse("class Foo\n  class << self\n    has_many :posts\n  end\nend\n");
    const node = findMacroCall(tree, "has_many");
    const result = rbNameOf(node);
    // Should be an array of NamedSymbols, all with methodKind === 'static'.
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result.every((s) => s.methodKind === "static")).toBe(true);
      expect(result.map((s) => s.name)).toEqual(["posts", "posts=", "post_ids", "post_ids="]);
    }
  });

  it("alias keyword inside class << self uses toStaticKind on single NamedSymbol", () => {
    // rubyAliasKeywordEmission returns a single NamedSymbol → toStaticKind non-array branch.
    const tree = parse("class Foo\n  class << self\n    alias fresh stale\n  end\nend\n");
    const node = findFirst(tree, "alias");
    const result = rbNameOf(node);
    expect(result).toMatchObject({ name: "fresh", methodKind: "static" });
  });
});

describe("rbNameOf — rubyMacroEmission guard: no args → null", () => {
  it("macro call with no argument list returns null for catalogue-based macro", () => {
    // `attr_reader` alone with no parens and no symbols → args absent → rubyMacroEmission returns null.
    const tree = parse("class C\n  attr_reader\nend\n");
    // The node may parse as identifier, not a call — either way rbNameOf returns null.
    const body = findFirst(tree, "class").childForFieldName("body");
    const stmt = body ? body.namedChildren[0] : null;
    if (!stmt) return;
    const result = rbNameOf(stmt);
    // Either null or empty array — never a populated result.
    if (Array.isArray(result)) {
      expect(result).toEqual([]);
    } else {
      expect(result).toBeNull();
    }
  });
});

describe("rbNameOf — class with no name node returns null", () => {
  it("class node without a name field returns null (defensive)", () => {
    // Can't produce this via normal Ruby syntax; test that rbNameOf handles
    // a `class` node gracefully when nameNode is missing — verified via
    // normal parse: a plain `class << self` has no name field.
    const tree = parse("class Foo\n  class << self\n  end\nend\n");
    const sc = findFirst(tree, "singleton_class");
    // singleton_class has no `name` field → rbNameOf returns null at the class/module branch.
    expect(rbNameOf(sc)).toBeNull();
  });
});

describe("rbNameOf — scopeResolutionText with deep nesting (A::B::C)", () => {
  it("rbNameOf composes a 3-level scope_resolution class name without empty segment", () => {
    // Exercises scopeResolutionText recursive path where left is another scope_resolution.
    const tree = parse("class A::B::C\nend\n");
    const node = findFirst(tree, "class");
    expect(rbNameOf(node)).toEqual({ name: "A::B::C", descendsInto: true });
  });
});

/**
 * Grammar-compat synthetic AstNode tests.
 * These cover the `children.find(...)` fallback paths in `macroNameOf` and
 * `expandClassBodyMacros` that fire when the grammar does not expose explicit
 * field names — i.e. when `childForFieldName("method")` / `childForFieldName("arguments")`
 * return null (older grammar versions, or non-standard node shapes). We construct
 * a minimal fake node where `childForFieldName` always returns null so the
 * `?? node.children.find(...)` arm is forced.
 */
describe("rbNameOf — grammar-compat children.find fallback paths", () => {
  function fakeNode(
    type: string,
    text: string,
    children: ReturnType<typeof fakeNode>[] = [],
    namedChildren: ReturnType<typeof fakeNode>[] = [],
  ) {
    return {
      type,
      text,
      children: children as unknown as readonly ReturnType<typeof fakeNode>[],
      namedChildren: namedChildren as unknown as readonly ReturnType<typeof fakeNode>[],
      startPosition: { row: 0, column: 0 },
      endPosition: { row: 0, column: text.length },
      parent: null,
      previousNamedSibling: null,
      // childForFieldName always returns null to force the children.find fallback.
      childForFieldName: (_field: string) => null,
      child: (_i: number) => null,
      namedChild: (_i: number) => null,
    };
  }

  it("macroNameOf uses children.find for method identifier when childForFieldName returns null", () => {
    // Synthetic `define_method(:dynamic) { }` call node where ALL field lookups
    // return null, so expandClassBodyMacros and macroNameOf fall back to
    // `node.children.find(c => c.type === "identifier")` and
    // `node.children.find(c => c.type === "argument_list")` respectively.
    const identNode = fakeNode("identifier", "define_method");
    const symArg = fakeNode("simple_symbol", ":dynamic");
    const argList = fakeNode("argument_list", "(:dynamic)", [], [symArg]);
    const callNode = fakeNode("call", "define_method(:dynamic) { }", [identNode, argList], []);

    // rbNameOf → expandClassBodyMacros uses children.find for method (fallback line 70)
    // and for arguments (fallback line 82); macroNameOf uses children.find for method.
    const result = rbNameOf(callNode as never);
    expect(result).toMatchObject({ name: "dynamic", descendsInto: false, methodKind: "instance" });
  });

  it("rbNameOf returns null for a call node with only non-identifier children (no method found)", () => {
    // children has no `identifier` node → macroNameOf returns undefined → expandClassBodyMacros
    // finds macroName="" → entry not in RUBY_DSL → returns []. rbNameOf emits null.
    const nonIdentChild = fakeNode("integer", "42");
    const callNode = fakeNode("call", "42", [nonIdentChild], []);
    expect(rbNameOf(callNode as never)).toBeNull();
  });
});

/**
 * Grammar-compat synthetic AstNode tests for the two Ruby-only container
 * detectors: `rubyMethodInsideClassMethodsBlock` and
 * `rubyMethodInsideExtendSelfModule`. Both walk `methodNode.parent` and, for
 * the enclosing `call` node, read the method identifier (and, for `extend
 * self`, the argument list) via `childForFieldName(...) ?? children.find(...)`.
 * Real tree-sitter-ruby always exposes the `method`/`arguments` fields, so the
 * `children.find` arm is a forward-compat fallback that real-grammar parses
 * never exercise — mirrors the `fakeNode` convention in the describe block
 * above, scoped to a local builder that also wires `parent` + field lookups.
 */
describe("rbNameOf — grammar-compat children.find fallback paths (class_methods / extend self detectors)", () => {
  type FakeRubyNode = {
    type: string;
    text: string;
    children: readonly FakeRubyNode[];
    namedChildren: readonly FakeRubyNode[];
    startPosition: { row: number; column: number };
    endPosition: { row: number; column: number };
    parent: FakeRubyNode | null;
    previousNamedSibling: FakeRubyNode | null;
    childForFieldName: (field: string) => FakeRubyNode | null;
    child: (i: number) => FakeRubyNode | null;
    namedChild: (i: number) => FakeRubyNode | null;
  };

  function fakeRubyNode(
    type: string,
    text: string,
    opts: {
      children?: FakeRubyNode[];
      namedChildren?: FakeRubyNode[];
      fields?: Record<string, FakeRubyNode>;
      parent?: FakeRubyNode | null;
    } = {},
  ): FakeRubyNode {
    return {
      type,
      text,
      children: opts.children ?? [],
      namedChildren: opts.namedChildren ?? [],
      startPosition: { row: 0, column: 0 },
      endPosition: { row: 0, column: text.length },
      parent: opts.parent ?? null,
      previousNamedSibling: null,
      // Only fields explicitly wired below resolve; everything else is null,
      // forcing the `?? children.find(...)` fallback arm.
      childForFieldName: (field: string) => opts.fields?.[field] ?? null,
      child: () => null,
      namedChild: () => null,
    };
  }

  it("rubyMethodInsideClassMethodsBlock falls back to children.find for the class_methods call's method identifier", () => {
    // Synthetic `class_methods do; def find_tracked; end; end` where the
    // enclosing `call` node has NO "method" field wired — forces
    // `call.children.find((c) => c.type === "identifier")`.
    const methodName = fakeRubyNode("identifier", "find_tracked");
    const methodNode = fakeRubyNode("method", "def find_tracked; end", { fields: { name: methodName } });
    const classMethodsIdent = fakeRubyNode("identifier", "class_methods");
    const doBlock = fakeRubyNode("do_block", "do\n  def find_tracked; end\nend", { children: [methodNode] });
    const call = fakeRubyNode("call", "class_methods do ... end", { children: [classMethodsIdent, doBlock] });
    methodNode.parent = doBlock;
    doBlock.parent = call;

    expect(rbNameOf(methodNode as never)).toEqual({
      name: "find_tracked",
      descendsInto: false,
      methodKind: "static",
    });
  });

  it("rubyMethodInsideExtendSelfModule falls back to children.find for the extend call's method identifier and argument_list", () => {
    // Synthetic `module M; extend self; def helper; end; end` where the
    // `extend self` call node has NO "method"/"arguments" fields wired —
    // forces BOTH `children.find((c) => c.type === "identifier")` and
    // `children.find((c) => c.type === "argument_list")`.
    const extendIdent = fakeRubyNode("identifier", "extend");
    const selfArg = fakeRubyNode("self", "self");
    const argList = fakeRubyNode("argument_list", "(self)", { namedChildren: [selfArg] });
    const extendCall = fakeRubyNode("call", "extend self", { children: [extendIdent, argList] });
    const methodName = fakeRubyNode("identifier", "helper");
    const methodNode = fakeRubyNode("method", "def helper; end", { fields: { name: methodName } });
    const moduleNode = fakeRubyNode("module", "module M\n  extend self\n  def helper\n  end\nend", {
      children: [extendCall],
    });
    methodNode.parent = moduleNode;

    expect(rbNameOf(methodNode as never)).toEqual([
      { name: "helper", descendsInto: false, methodKind: "instance" },
      { name: "helper", descendsInto: false, methodKind: "static" },
    ]);
  });
});

describe("rbNameOf — ActiveSupport::Concern class_methods block (bd tea-rags-mcp-82o24)", () => {
  it("`class_methods do; def find_tracked; end; end` → STATIC (class method of the includer)", () => {
    const tree = parse("module Trackable\n  class_methods do\n    def find_tracked; end\n  end\nend\n");
    const def = findFirst(tree, "method");
    expect(rbNameOf(def)).toEqual({ name: "find_tracked", descendsInto: false, methodKind: "static" });
  });

  it("`class_methods { def x; end }` brace-block form → STATIC", () => {
    const tree = parse("module M\n  class_methods { def x; end }\nend\n");
    const def = findFirst(tree, "method");
    expect(rbNameOf(def)).toEqual({ name: "x", descendsInto: false, methodKind: "static" });
  });

  it("`included do; def track; end; end` → INSTANCE (regular instance method, NOT static)", () => {
    const tree = parse("module Trackable\n  included do\n    def track; end\n  end\nend\n");
    const def = findFirst(tree, "method");
    expect(rbNameOf(def)).toEqual({ name: "track", descendsInto: false, methodKind: "instance" });
  });
});
