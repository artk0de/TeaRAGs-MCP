/**
 * The `annotations` inline type source (E2 seam 2, bd tea-rags-mcp-9fgdi).
 *
 * Two halves carry equal weight. The EMITTED rows say the source reads what the
 * native walker cannot type — `Optional[Foo]`, a forward reference, a class-body
 * attribute. The DECLINED rows say it stays silent where the walker already
 * wrote (`x: Foo`, `x: mod.Foo`) and where the bound string would name a
 * receiver the call site does not have (`list[Foo]`, `Foo | Bar`).
 *
 * Every fixture is real Python parsed through tree-sitter, so a grammar change
 * that moves a `typed_parameter` field breaks this file rather than silently
 * emptying the channel on five corpora.
 */

import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { AstNode } from "../../../../../../../src/core/contracts/types/ast.js";
import type { TypeFact } from "../../../../../../../src/core/domains/language/kernel/type-facts.js";
import { pythonAnnotationTypeSource } from "../../../../../../../src/core/domains/language/python/walker/passes/python-annotation-type-source.js";
import { materializeTree } from "../../../../../../../src/core/infra/materialize.js";

function parse(src: string): AstNode {
  const parser = new Parser();
  parser.setLanguage(PyLang as unknown as Parser.Language);
  return materializeTree(parser.parse(src).rootNode, src);
}

function facts(src: string, trackLocalTypes = true): TypeFact[] {
  return pythonAnnotationTypeSource.extract({ root: parse(src), trackLocalTypes });
}

const instance = (name: string) => ({ form: "instance", name }) as const;
const nilable = (name: string) => ({ form: "union", members: [instance(name), { form: "nil" }] }) as const;

describe("pythonAnnotationTypeSource — parameters", () => {
  it("declines `x: Foo` — the native walker already binds a bare identifier", () => {
    expect(facts("def f(x: Foo): pass\n")).toEqual([]);
  });

  it("declines `x: mod.Foo` — the walker binds the dotted form too", () => {
    expect(facts("def f(x: mod.Foo): pass\n")).toEqual([]);
  });

  it("emits a param fact for `Optional[Foo]`, keyed at the `def` line", () => {
    expect(facts("\ndef f(x: Optional[Foo]): pass\n")).toEqual([
      {
        kind: "param",
        source: "annotations",
        symbolScope: [],
        methodName: "f",
        name: "x",
        line: 2,
        type: nilable("Foo"),
      },
    ]);
  });

  it("keeps the `def` line for every parameter of a multi-line signature", () => {
    const out = facts("def f(\n    a: Optional[Foo],\n    b: Optional[Bar],\n): pass\n");
    expect(out.map((f) => f.line)).toEqual([1, 1]);
  });

  it("declines `list[Foo]` — a container names the element, not the receiver", () => {
    expect(facts("def f(x: list[Foo]): pass\n")).toEqual([]);
  });

  it("declines `Foo | Bar` — two reachable arms, half the sites would be wrong", () => {
    expect(facts("def f(x: Foo | Bar): pass\n")).toEqual([]);
  });

  it("emits a param fact for a forward reference", () => {
    const out = facts('def f(x: "Foo"): pass\n');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "param", name: "x", type: instance("Foo") });
  });

  it("skips a splat parameter — `*args: int` binds a tuple, never the annotated type", () => {
    expect(facts("def f(*args: Optional[Foo], **kw: Optional[Bar]): pass\n")).toEqual([]);
  });

  it("reads a typed default parameter", () => {
    const out = facts("def f(x: Optional[Foo] = None): pass\n");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "param", name: "x", methodName: "f" });
  });
});

describe("pythonAnnotationTypeSource — returns", () => {
  it("emits a return fact with no line and no classForm", () => {
    expect(facts("def f() -> Optional[Foo]: pass\n")).toEqual([
      { kind: "return", source: "annotations", symbolScope: [], methodName: "f", type: nilable("Foo") },
    ]);
  });

  it("emits a return fact for a bare identifier — return facts have no walker gate", () => {
    const out = facts("def f() -> Foo: pass\n");
    expect(out).toEqual([
      { kind: "return", source: "annotations", symbolScope: [], methodName: "f", type: instance("Foo") },
    ]);
  });

  it("declines `-> None` — a nil-only ref states no receiver", () => {
    expect(facts("def f() -> None: pass\n")).toEqual([]);
  });

  it("declines `-> Any`", () => {
    expect(facts("def f() -> Any: pass\n")).toEqual([]);
  });

  it("marks a @classmethod return with classForm and the enclosing class scope", () => {
    const out = facts("class C:\n    @classmethod\n    def make(cls) -> Foo:\n        pass\n");
    expect(out).toEqual([
      {
        kind: "return",
        source: "annotations",
        symbolScope: ["C"],
        methodName: "make",
        classForm: true,
        type: instance("Foo"),
      },
    ]);
  });

  it("leaves classForm absent on a plain instance method", () => {
    const out = facts("class C:\n    def run(self) -> Foo:\n        pass\n");
    expect(out).toEqual([
      { kind: "return", source: "annotations", symbolScope: ["C"], methodName: "run", type: instance("Foo") },
    ]);
  });

  it("resolves `-> Self` against the enclosing class", () => {
    const out = facts("class Svc:\n    def chain(self) -> Self:\n        pass\n");
    expect(out).toEqual([
      { kind: "return", source: "annotations", symbolScope: ["Svc"], methodName: "chain", type: instance("Svc") },
    ]);
  });

  it("reads a decorated def through `@app.route(...)` — the decorator is not the def", () => {
    const out = facts('@app.route("/x")\ndef view() -> Foo: pass\n');
    expect(out).toEqual([
      { kind: "return", source: "annotations", symbolScope: [], methodName: "view", type: instance("Foo") },
    ]);
  });
});

describe("pythonAnnotationTypeSource — class attributes", () => {
  it("emits an ivar fact for a class-body annotation, collapsed to one nominal arm", () => {
    expect(facts("class C:\n    svc: Optional[Svc]\n")).toEqual([
      { kind: "ivar", source: "annotations", symbolScope: ["C"], name: "svc", line: 2, type: instance("Svc") },
    ]);
  });

  it("emits an ivar fact for `self.x: T` inside a method, with no methodName", () => {
    const out = facts("class C:\n    def __init__(self):\n        self.svc: Optional[Svc] = None\n");
    expect(out).toEqual([
      { kind: "ivar", source: "annotations", symbolScope: ["C"], name: "svc", line: 3, type: instance("Svc") },
    ]);
  });

  it("emits an ivar fact for a bare identifier annotation too — the ivar channel unions by key", () => {
    const out = facts("class C:\n    svc: Svc\n");
    expect(out).toEqual([
      { kind: "ivar", source: "annotations", symbolScope: ["C"], name: "svc", line: 2, type: instance("Svc") },
    ]);
  });

  it("carries the full class chain for a nested class", () => {
    const out = facts("class Outer:\n    class Inner:\n        x: Foo\n");
    expect(out).toEqual([
      {
        kind: "ivar",
        source: "annotations",
        symbolScope: ["Outer", "Inner"],
        name: "x",
        line: 3,
        type: instance("Foo"),
      },
    ]);
  });

  it("declines a class-body container annotation — no single nominal arm", () => {
    expect(facts("class C:\n    items: list[Foo]\n")).toEqual([]);
  });

  it("declines `self.x: T` outside any class", () => {
    expect(facts("def f(self):\n    self.svc: Optional[Svc] = None\n")).toEqual([]);
  });
});

describe("pythonAnnotationTypeSource — locals and the env gate", () => {
  it("emits a local fact at the assignment line", () => {
    expect(facts("def f():\n    x: Optional[Foo] = g()\n")).toEqual([
      {
        kind: "local",
        source: "annotations",
        symbolScope: [],
        methodName: "f",
        name: "x",
        line: 2,
        type: nilable("Foo"),
      },
    ]);
  });

  it("declines a bare-identifier local — the walker already binds `x: Foo`", () => {
    expect(facts("def f():\n    x: Foo = g()\n")).toEqual([]);
  });

  it("declines a module-level annotated assignment — no channel reads it", () => {
    expect(facts("x: Optional[Foo] = g()\n")).toEqual([]);
  });

  it("suppresses param and local facts when local type tracking is off, keeping ivar and return", () => {
    const src = [
      "class C:",
      "    svc: Optional[Svc]",
      "    def run(self, x: Optional[Foo]) -> Optional[Bar]:",
      "        y: Optional[Baz] = g()",
      "",
    ].join("\n");
    expect(
      facts(src, true)
        .map((f) => f.kind)
        .sort(),
    ).toEqual(["ivar", "local", "param", "return"]);
    expect(
      facts(src, false)
        .map((f) => f.kind)
        .sort(),
    ).toEqual(["ivar", "return"]);
  });
});
