/**
 * Derived-expression bindings (`for` / `with` / tuple unpack) carry the source
 * expression text for the resolver to fold. An expression longer than the
 * walker's cap is dropped rather than persisted, and a `with` item without
 * `as` binds nothing. Also pins the constructor-field RHS shapes that do and do
 * not type a `self.<field>`, and `TYPE_CHECKING` guard detection.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import { extractFromPythonFile } from "../../../../../../src/core/domains/language/python/walker/walker.js";

function extract(src: string) {
  const parser = new Parser();
  parser.setLanguage(PyLang);
  return extractFromPythonFile({
    tree: parser.parse(src),
    code: src,
    relPath: "app/registry.py",
    language: "python",
    chunks: [{ symbolId: "Apps#run", scope: ["Apps"], startLine: 1, endLine: src.split("\n").length }],
  });
}

const LONG = "x".repeat(210);

describe("Python walker — derived-expression bindings and the length cap", () => {
  it("binds a `for` target to a short iterated expression but drops an over-long one", () => {
    const short = extract('def run(self):\n    for a in make("k"):\n        a.go()\n').chunks[0].localBindings;
    const long = extract(`def run(self):\n    for a in make("${LONG}"):\n        a.go()\n`).chunks[0].localBindings;

    expect(short?.a?.[0]).toMatchObject({ valueKind: "iterationElement", sourceExpression: 'make("k")' });
    expect(long).toBeUndefined();
  });

  it("binds only the `as` target of a `with` item; a bare `with lock:` and an over-long context bind nothing", () => {
    const bare = extract("def run(self):\n    with lock:\n        pass\n").chunks[0].localBindings;
    const named = extract("def run(self):\n    with make() as f:\n        f.go()\n").chunks[0].localBindings;
    const long = extract(`def run(self):\n    with make("${LONG}") as f:\n        f.go()\n`).chunks[0].localBindings;

    expect(bare).toBeUndefined();
    expect(named?.f).toEqual([
      { line: 2, type: "", valueKind: "contextEnter", sourceExpression: "make()", endLine: 2 },
    ]);
    expect(long).toBeUndefined();
  });

  it("binds tuple-unpack elements to the source expression and drops an over-long one", () => {
    const out = extract(`def run(self):\n    a, b = make("${LONG}")\n    c, d = make()\n`).chunks[0];

    expect(Object.keys(out.localBindings ?? {}).sort()).toEqual(["c", "d"]);
    expect(out.localBindings?.d).toEqual([
      { line: 3, type: "", valueKind: "tupleElement", sourceExpression: "make()", tupleIndex: 1, endLine: 3 },
    ]);
    expect(out.assignedLocals).toEqual(["a", "b", "c", "d"]);
  });
});

describe("Python walker — constructor field RHS shapes", () => {
  it("types a field from `x or Foo()` but not from `and` or a mixed conditional", () => {
    const src = [
      "class A:",
      "    def __init__(self):",
      "        self.a = x and Foo()",
      "        self.b = Foo() if c else 5",
      "        self.c = Foo() if c else Bar()",
      "        self.d = x or Foo()",
      "        self.e = Foo() if c else Foo()",
    ].join("\n");

    const fields = extract(src).classFieldTypes?.A ?? {};
    expect(fields).toMatchObject({ d: "Foo" });
    expect(fields).not.toHaveProperty("a");
    expect(fields).not.toHaveProperty("b");
    expect(fields).not.toHaveProperty("c");
  });
});

describe("Python walker — a module used bare as a base class", () => {
  it("leaves the module spelling verbatim instead of inventing a `::` class key", () => {
    const out = extract("import pkg\nclass A(pkg):\n    pass\n");

    expect(out.classAncestors).toEqual({ "app/registry.py::A": ["pkg"] });
  });
});

describe("Python walker — TYPE_CHECKING guard detection", () => {
  it("marks only imports under a TYPE_CHECKING guard as type-only", () => {
    const src = [
      "import sys",
      "if sys.version_info >= (3, 8):",
      "    import a",
      "if foo():",
      "    import b",
      "if typing.TYPE_CHECKING:",
      "    import c",
    ].join("\n");

    const byModule = Object.fromEntries(extract(src).imports.map((i) => [i.importText, i.typeOnly === true]));
    expect(byModule).toEqual({ sys: false, a: false, b: false, c: true });
  });
});
