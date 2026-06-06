/**
 * Direct unit tests for `extractRubyMacroSymbols` — the pure helper that
 * synthesises method symbols from Ruby class-body DSL macros
 * (`attr_*`, `cattr_*`, `mattr_*`, `delegate`, `define_method`,
 * `alias_method`, `alias`).
 *
 * The walker integration tests in `ruby-walker.test.ts` cover the
 * end-to-end emission path (chunk metadata, synthetic CallRef edges),
 * but they don't exercise every macro/argument-shape branch in
 * `ruby-macros.ts`. These tests target the macro extractor itself with
 * a parsed `class`/`module` container node — same shape the chunker
 * passes in at runtime.
 *
 * Convention: instance methods join with `#`, class/module methods join
 * with `.`. Setters get a `=` suffix per
 * `.claude/rules/symbolid-convention.md`.
 */

import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { extractRubyMacroSymbols } from "../../../../../../src/core/domains/language/ruby/walker/macros.js";

function parse(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(RbLang as unknown as Parser.Language);
  return parser.parse(src);
}

function findContainer(tree: Parser.Tree, type: "class" | "module"): Parser.SyntaxNode {
  const node = tree.rootNode.namedChildren.find((c) => c.type === type);
  if (!node) throw new Error(`No ${type} node found`);
  return node;
}

describe("extractRubyMacroSymbols — attr_* family", () => {
  it("attr_accessor emits getter + setter as instance methods", () => {
    const tree = parse("class Foo\n  attr_accessor :name\nend\n");
    const out = extractRubyMacroSymbols(findContainer(tree, "class"));
    expect(out.map((m) => `${m.name}/${m.kind}`)).toEqual(["name/instance", "name=/instance"]);
  });

  it("attr_reader emits getter only", () => {
    const tree = parse("class Foo\n  attr_reader :id\nend\n");
    const out = extractRubyMacroSymbols(findContainer(tree, "class"));
    expect(out.map((m) => `${m.name}/${m.kind}`)).toEqual(["id/instance"]);
  });

  it("attr_writer emits setter only (with = suffix)", () => {
    const tree = parse("class Foo\n  attr_writer :data\nend\n");
    const out = extractRubyMacroSymbols(findContainer(tree, "class"));
    expect(out.map((m) => `${m.name}/${m.kind}`)).toEqual(["data=/instance"]);
  });

  it("attr_accessor with multiple symbols emits all pairs", () => {
    const tree = parse("class Foo\n  attr_accessor :a, :b\nend\n");
    const out = extractRubyMacroSymbols(findContainer(tree, "class"));
    expect(out.map((m) => m.name)).toEqual(["a", "a=", "b", "b="]);
  });
});

describe("extractRubyMacroSymbols — class/module-level accessors", () => {
  it("cattr_accessor emits static (.) getter + setter", () => {
    const tree = parse("class Foo\n  cattr_accessor :timeout\nend\n");
    const out = extractRubyMacroSymbols(findContainer(tree, "class"));
    expect(out.map((m) => `${m.name}/${m.kind}`)).toEqual(["timeout/static", "timeout=/static"]);
  });

  it("cattr_reader emits static getter only", () => {
    const tree = parse("class Foo\n  cattr_reader :pool\nend\n");
    const out = extractRubyMacroSymbols(findContainer(tree, "class"));
    expect(out).toEqual([expect.objectContaining({ name: "pool", kind: "static" })]);
  });

  it("cattr_writer emits static setter only", () => {
    const tree = parse("class Foo\n  cattr_writer :backend\nend\n");
    const out = extractRubyMacroSymbols(findContainer(tree, "class"));
    expect(out).toEqual([expect.objectContaining({ name: "backend=", kind: "static" })]);
  });

  it("mattr_accessor / mattr_reader / mattr_writer mirror cattr_* on modules", () => {
    const tree = parse("module M\n  mattr_accessor :defaults\n  mattr_reader :config\n  mattr_writer :logger\nend\n");
    const out = extractRubyMacroSymbols(findContainer(tree, "module"));
    expect(out.map((m) => `${m.name}/${m.kind}`)).toEqual([
      "defaults/static",
      "defaults=/static",
      "config/static",
      "logger=/static",
    ]);
  });
});

describe("extractRubyMacroSymbols — delegate", () => {
  it("collects leading symbol args before the `to:` kwarg as instance methods", () => {
    const tree = parse("class Foo\n  delegate :name, :email, to: :user\nend\n");
    const out = extractRubyMacroSymbols(findContainer(tree, "class"));
    expect(out.map((m) => `${m.name}/${m.kind}`)).toEqual(["name/instance", "email/instance"]);
  });

  it("stops collecting at first non-symbol arg (the `to:` kwarg pair)", () => {
    // The `to: :user` arg is a pair node, not a simple_symbol — the
    // collector breaks at the first non-simple_symbol entry.
    const tree = parse("class Foo\n  delegate :one, to: :other\nend\n");
    const out = extractRubyMacroSymbols(findContainer(tree, "class"));
    expect(out.map((m) => m.name)).toEqual(["one"]);
  });
});

describe("extractRubyMacroSymbols — define_method", () => {
  it("define_method with a literal symbol arg emits the method", () => {
    const tree = parse("class Foo\n  define_method(:bar) { 1 }\nend\n");
    const out = extractRubyMacroSymbols(findContainer(tree, "class"));
    expect(out).toEqual([expect.objectContaining({ name: "bar", kind: "instance" })]);
  });

  it("define_method with a literal string arg emits the method", () => {
    const tree = parse('class Foo\n  define_method("baz") { 1 }\nend\n');
    const out = extractRubyMacroSymbols(findContainer(tree, "class"));
    expect(out).toEqual([expect.objectContaining({ name: "baz", kind: "instance" })]);
  });

  it("define_method with a dynamic arg (variable) emits nothing — name not statically known", () => {
    const tree = parse("class Foo\n  define_method(method_name) { 1 }\nend\n");
    const out = extractRubyMacroSymbols(findContainer(tree, "class"));
    expect(out).toEqual([]);
  });
});

describe("extractRubyMacroSymbols — alias_method", () => {
  it("alias_method emits the FIRST symbol (new name) as an instance method", () => {
    const tree = parse("class Foo\n  alias_method :new_name, :old_name\nend\n");
    const out = extractRubyMacroSymbols(findContainer(tree, "class"));
    expect(out).toEqual([expect.objectContaining({ name: "new_name", kind: "instance" })]);
  });

  it("alias_method with non-symbol first arg emits nothing", () => {
    const tree = parse("class Foo\n  alias_method method_var, :old_name\nend\n");
    const out = extractRubyMacroSymbols(findContainer(tree, "class"));
    expect(out).toEqual([]);
  });
});

describe("extractRubyMacroSymbols — alias keyword", () => {
  it("`alias new_name old_name` keyword form emits new_name as instance method", () => {
    const tree = parse("class Foo\n  def old_name; end\n  alias new_name old_name\nend\n");
    const out = extractRubyMacroSymbols(findContainer(tree, "class"));
    // Only the alias-derived symbol is in `out` — `def old_name` does
    // NOT go through extractRubyMacroSymbols, it's a `method` node.
    expect(out).toEqual([expect.objectContaining({ name: "new_name", kind: "instance" })]);
  });
});

describe("extractRubyMacroSymbols — guard clauses (ignored shapes)", () => {
  it("receiver-qualified macro call (`obj.attr_accessor :x`) is NOT a class-body DSL — emit nothing", () => {
    // The guard `node.childForFieldName("receiver")` causes the
    // macro to be skipped. We test this through a module body so
    // the outer DSL behaviour is asserted separately.
    const tree = parse("class Foo\n  obj.attr_accessor :ignored\nend\n");
    const out = extractRubyMacroSymbols(findContainer(tree, "class"));
    expect(out).toEqual([]);
  });

  it("unknown macro name emits nothing", () => {
    const tree = parse("class Foo\n  some_other_macro :x\nend\n");
    const out = extractRubyMacroSymbols(findContainer(tree, "class"));
    expect(out).toEqual([]);
  });

  it("returns empty array when given a non-class / non-module node", () => {
    // A bare method body — not a container — should short-circuit.
    const tree = parse("def foo; end\n");
    const method = tree.rootNode.namedChildren[0];
    expect(extractRubyMacroSymbols(method)).toEqual([]);
  });

  it("empty class body emits nothing", () => {
    const tree = parse("class Foo\nend\n");
    const out = extractRubyMacroSymbols(findContainer(tree, "class"));
    expect(out).toEqual([]);
  });
});

describe("extractRubyMacroSymbols — startLine / endLine", () => {
  it("attaches 1-based startLine and endLine to each emitted symbol", () => {
    const tree = parse("class Foo\n  attr_reader :id\nend\n");
    const out = extractRubyMacroSymbols(findContainer(tree, "class"));
    expect(out).toHaveLength(1);
    expect(out[0].startLine).toBe(2);
    expect(out[0].endLine).toBe(2);
  });
});

describe("extractRubyMacroSymbols — defensive arg-shape guards", () => {
  it("delegate without arguments → no emission (defensive)", () => {
    const tree = parse("class Foo\n  delegate\nend\n");
    const out = extractRubyMacroSymbols(findContainer(tree, "class"));
    expect(out).toEqual([]);
  });

  it("delegate with non-symbol leading arg → stops at first non-symbol", () => {
    const tree = parse("class Foo\n  delegate var, to: :other\nend\n");
    const out = extractRubyMacroSymbols(findContainer(tree, "class"));
    // First arg is identifier `var`, not simple_symbol — break loop immediately.
    expect(out).toEqual([]);
  });

  it("alias_method without arguments → no emission", () => {
    const tree = parse("class Foo\n  alias_method\nend\n");
    const out = extractRubyMacroSymbols(findContainer(tree, "class"));
    expect(out).toEqual([]);
  });

  it("alias_method first arg not a symbol → no emission", () => {
    const tree = parse("class Foo\n  alias_method var, :old_name\nend\n");
    const out = extractRubyMacroSymbols(findContainer(tree, "class"));
    expect(out).toEqual([]);
  });

  it("define_method without arguments → no emission", () => {
    const tree = parse("class Foo\n  define_method\nend\n");
    const out = extractRubyMacroSymbols(findContainer(tree, "class"));
    expect(out).toEqual([]);
  });

  it("define_method first arg is dynamic identifier → no emission", () => {
    const tree = parse("class Foo\n  define_method(verb) { 1 }\nend\n");
    const out = extractRubyMacroSymbols(findContainer(tree, "class"));
    expect(out).toEqual([]);
  });

  it("define_method with string literal arg → emits the string as the method name", () => {
    const tree = parse('class Foo\n  define_method("dynamic_method") { 1 }\nend\n');
    const out = extractRubyMacroSymbols(findContainer(tree, "class"));
    expect(out).toEqual([{ name: "dynamic_method", kind: "instance", startLine: 2, endLine: 2 }]);
  });

  it("attr_reader without arguments → no emission", () => {
    const tree = parse("class Foo\n  attr_reader\nend\n");
    const out = extractRubyMacroSymbols(findContainer(tree, "class"));
    expect(out).toEqual([]);
  });

  it("attr_reader with non-symbol arg → skipped, only symbols emit", () => {
    const tree = parse("class Foo\n  attr_reader var_ref, :real_attr\nend\n");
    const out = extractRubyMacroSymbols(findContainer(tree, "class"));
    expect(out.map((s) => s.name)).toEqual(["real_attr"]);
  });
});

// extractRubyMacroSymbols — singleton_class (`class << self`) container
// Macros inside `class << self` declare CLASS-level (static) methods.
describe("extractRubyMacroSymbols — singleton_class (class << self)", () => {
  function findSingletonClass(tree: Parser.Tree): Parser.SyntaxNode {
    const cls = tree.rootNode.namedChildren.find((n) => n.type === "class");
    if (!cls) throw new Error("class not found");
    const body = cls.childForFieldName("body");
    const stmts = body ? body.namedChildren : cls.namedChildren;
    const sc = stmts.find((n) => n.type === "singleton_class");
    if (!sc) throw new Error("singleton_class not found");
    return sc;
  }

  it("attr_reader inside class << self emits static (class-level) getter", () => {
    const tree = parse("class Foo\n  class << self\n    attr_reader :setting\n  end\nend\n");
    const sc = findSingletonClass(tree);
    const out = extractRubyMacroSymbols(sc);
    expect(out).toEqual([{ name: "setting", kind: "static", startLine: 3, endLine: 3 }]);
  });

  it("attr_accessor inside class << self emits static getter AND setter", () => {
    const tree = parse("class Foo\n  class << self\n    attr_accessor :config\n  end\nend\n");
    const sc = findSingletonClass(tree);
    const out = extractRubyMacroSymbols(sc);
    expect(out.map((s) => ({ name: s.name, kind: s.kind }))).toEqual([
      { name: "config", kind: "static" },
      { name: "config=", kind: "static" },
    ]);
  });

  it("non-class/module/singleton_class container returns empty array immediately", () => {
    const tree = parse("def foo\nend\n");
    const methodNode = tree.rootNode.namedChildren.find((n) => n.type === "method");
    if (!methodNode) throw new Error("method node not found");
    const out = extractRubyMacroSymbols(methodNode);
    expect(out).toEqual([]);
  });
});

// literalNameFromArg — string branch with empty content → null (no emission)
describe("extractRubyMacroSymbols — literalNameFromArg empty string guard", () => {
  it("define_method with empty string arg emits nothing", () => {
    const tree = parse('class Foo\n  define_method("") { 1 }\nend\n');
    const cls = tree.rootNode.namedChildren.find((n) => n.type === "class");
    if (!cls) throw new Error("class not found");
    const out = extractRubyMacroSymbols(cls);
    expect(out).toEqual([]);
  });
});
