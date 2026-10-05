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
import { pythonTypeNameQualifier } from "../../../../../../../src/core/domains/language/python/walker/walker.js";
import { materializeTree } from "../../../../../../../src/core/infra/materialize.js";

function parse(src: string): AstNode {
  const parser = new Parser();
  parser.setLanguage(PyLang);
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

  it("emits `Foo | Bar` as a structured union — the arms travel in the ref, never as one name", () => {
    expect(facts("def f(x: Foo | Bar): pass\n")).toEqual([
      {
        kind: "param",
        source: "annotations",
        symbolScope: [],
        methodName: "f",
        name: "x",
        line: 1,
        type: { form: "union", members: [instance("Foo"), instance("Bar")] },
      },
    ]);
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

/**
 * A multi-arm union on a `param` / `local` (bd tea-rags-mcp-m99j1.1.30): the
 * union dispatch component reads it through `LocalBinding.typeRef`, so the
 * fact carries every arm, each qualified through the file's imports the way a
 * return arm is (m99j1.1.55) so the resolver places it by the declaring file.
 */
describe("pythonAnnotationTypeSource — union params and locals", () => {
  const qualifiedFacts = (src: string): TypeFact[] => {
    const root = parse(src);
    return pythonAnnotationTypeSource.extract({
      root,
      trackLocalTypes: true,
      qualifyTypeName: pythonTypeNameQualifier(root),
    });
  };
  const typeOf = (src: string, name: string) => qualifiedFacts(src).find((f) => f.name === name)?.type;

  it("reads `Union[Foo, Bar]` as the same union", () => {
    expect(facts("def f(x: Union[Foo, Bar]): pass\n").map((f) => f.type)).toEqual([
      { form: "union", members: [instance("Foo"), instance("Bar")] },
    ]);
  });

  it("keeps the nil arm of `Foo | Bar | None`", () => {
    expect(facts("def f(x: Foo | Bar | None): pass\n").map((f) => f.type)).toEqual([
      { form: "union", members: [instance("Foo"), instance("Bar"), { form: "nil" }] },
    ]);
  });

  it("emits a union local at the assignment line", () => {
    expect(facts("def f():\n    y: Foo | Bar = g()\n")).toEqual([
      {
        kind: "local",
        source: "annotations",
        symbolScope: [],
        methodName: "f",
        name: "y",
        line: 2,
        type: { form: "union", members: [instance("Foo"), instance("Bar")] },
      },
    ]);
  });

  it("qualifies each arm through the file's imports, as a return arm is", () => {
    const src = "from pkg import models\nfrom pkg.a import Foo\n\ndef f(x: Foo | models.Bar | Local): pass\n";
    expect(typeOf(src, "x")).toEqual({
      form: "union",
      members: [instance("pkg.a::Foo"), instance("pkg.models::Bar"), instance("Local")],
    });
  });

  it("leaves a single nominal arm unqualified — `Optional[Foo]` collapses as before", () => {
    expect(typeOf("from pkg.a import Foo\n\ndef f(x: Optional[Foo]): pass\n", "x")).toEqual(nilable("Foo"));
  });

  it("declines a union with a container arm — `list[Foo] | Bar` names no receiver per arm", () => {
    expect(facts("def f(x: list[Foo] | Bar): pass\n")).toEqual([]);
  });

  it("declines a union of class objects — `type[A] | type[B]`", () => {
    expect(facts("def f(x: type[A] | type[B]): pass\n")).toEqual([]);
  });

  it("still declines a union class attribute — `classFieldTypes` has nowhere to carry the arms", () => {
    expect(facts("class C:\n    svc: Foo | Bar\n")).toEqual([]);
    expect(
      facts("class C:\n    def __init__(self, svc: Foo | Bar):\n        self.svc = svc\n").map((f) => f.kind),
    ).toEqual(["param"]);
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

  // Was `instance("Svc")` — the DECLARING class — until bd tea-rags-mcp-w205u
  // (E4.6b-1). `Self` on a return is the class the RECEIVER names, which the
  // walker cannot know: polar's `AccountRepository.from_session(s)` inherits
  // `from_session` from `RepositoryBase`, and typing its result as
  // `RepositoryBase` puts every following hop on the wrong class — 12 rows.
  // The fact records the MARKER; `pythonInheritedMemberType` substitutes.
  it("records `-> Self` as a marker for the reader to substitute", () => {
    const out = facts("class Svc:\n    def chain(self) -> Self:\n        pass\n");
    expect(out).toEqual([
      { kind: "return", source: "annotations", symbolScope: ["Svc"], methodName: "chain", type: instance("Self") },
    ]);
  });

  it("records the marker for every spelling of Self a return can carry", () => {
    for (const spelling of ["typing.Self", "typing_extensions.Self", '"Self"']) {
      expect(facts(`class Svc:\n    def chain(self) -> ${spelling}:\n        pass\n`)).toEqual([
        { kind: "return", source: "annotations", symbolScope: ["Svc"], methodName: "chain", type: instance("Self") },
      ]);
    }
  });

  // bd tea-rags-mcp-m99j1.1.44. httpx's `Client.__enter__(self: T) -> T`, with
  // `T = TypeVar("T", bound="Client")`, is a Self return spelled with a
  // TypeVar. Purely syntactic: the return names the first parameter's own
  // annotation, so it is whatever the receiver is — no TypeVar table.
  // A quoted / `type[...]` parameter also yields a `param` fact; this is about the return.
  const returns = (src: string) => facts(src).filter((fact) => fact.kind === "return");
  const selfMarker = (methodName: string, classForm?: true) => ({
    kind: "return",
    source: "annotations",
    symbolScope: ["Client"],
    methodName,
    type: instance("Self"),
    ...(classForm === undefined ? {} : { classForm }),
  });

  it("records `def m(self: T) -> T` as the Self marker", () => {
    expect(facts("class Client:\n    def __enter__(self: T) -> T:\n        pass\n")).toEqual([selfMarker("__enter__")]);
  });

  it("records `async def m(self: U) -> U` as the Self marker", () => {
    expect(facts("class Client:\n    async def __aenter__(self: U) -> U:\n        pass\n")).toEqual([
      selfMarker("__aenter__"),
    ]);
  });

  it("records `@classmethod def m(cls: type[T]) -> T` (and the quoted forms) as a class-form Self marker", () => {
    for (const cls of ["type[T]", 'type["T"]', "Type[T]"]) {
      const src = `class Client:\n    @classmethod\n    def make(cls: ${cls}) -> T:\n        pass\n`;
      expect(returns(src)).toEqual([selfMarker("make", true)]);
    }
  });

  it("records a quoted return naming the same TypeVar", () => {
    expect(returns('class Client:\n    def __enter__(self: "T") -> "T":\n        pass\n')).toEqual([
      selfMarker("__enter__"),
    ]);
  });

  it("does NOT record Self when the TypeVar sits on a non-first parameter", () => {
    expect(facts("class Client:\n    def m(self, x: T) -> T:\n        pass\n")).toEqual([
      { kind: "return", source: "annotations", symbolScope: ["Client"], methodName: "m", type: instance("T") },
    ]);
  });

  it("does NOT record Self when the return names a different identifier than the first parameter", () => {
    expect(facts("class Client:\n    def m(self: T) -> U:\n        pass\n")).toEqual([
      { kind: "return", source: "annotations", symbolScope: ["Client"], methodName: "m", type: instance("U") },
    ]);
  });

  it("does NOT record Self for a module-level `def f(x: T) -> T` — not a class-body def", () => {
    expect(facts("def f(x: T) -> T:\n    pass\n")).toEqual([
      { kind: "return", source: "annotations", symbolScope: [], methodName: "f", type: instance("T") },
    ]);
  });

  it("still resolves `Self` against the enclosing class OUTSIDE a return", () => {
    // An ivar names a value the object already holds; only the return is
    // polymorphic in the receiver, so only the return records the marker.
    expect(facts("class Svc:\n    twin: Optional[Self]\n")).toEqual([
      { kind: "ivar", source: "annotations", symbolScope: ["Svc"], name: "twin", line: 2, type: instance("Svc") },
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

  it("unwraps a SQLAlchemy `Mapped[T]` column down to the T the value actually is", () => {
    // The end-to-end proof that the transparent-set entry reaches the channel a
    // resolver reads, not just the ref algebra (bd tea-rags-mcp-w205u, E4.2a).
    expect(facts("class Benefit:\n    tiers: Mapped[Tiers] = mapped_column(JSONB)\n")).toEqual([
      {
        kind: "ivar",
        source: "annotations",
        symbolScope: ["Benefit"],
        name: "tiers",
        line: 2,
        type: instance("Tiers"),
      },
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
