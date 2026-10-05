/**
 * The `ast` inline type source (E2 seam 5, bd tea-rags-mcp-9fgdi) — a def's
 * return type read off its own `return` statements, through the kernel engine.
 *
 * The EMITTED rows say what the five measured expression shapes are worth; the
 * DECLINED rows are the precision story, and there are more of them on purpose.
 * A wrong return type does not stay local — it seeds a chain fold that then
 * pins the wrong symbol at every downstream hop, so every ambiguous shape here
 * has to answer nothing at all.
 *
 * Every fixture is real Python parsed through tree-sitter. The last block goes
 * through `TypeFactStore` + `pythonTypeChannels` rather than the raw fact list,
 * because "loses to an annotation" is a claim about the STORE's coordinate
 * dedupe, not about what the source emits.
 */

import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { AstNode } from "../../../../../../../src/core/contracts/types/ast.js";
import { TypeFactStore } from "../../../../../../../src/core/domains/language/kernel/type-fact-store.js";
import type { TypeFact } from "../../../../../../../src/core/domains/language/kernel/type-facts.js";
import { PY_DISPATCH_FAN_MAX } from "../../../../../../../src/core/domains/language/python/resolver/dispatch/python-dispatch-policy.js";
import {
  PYTHON_INLINE_TYPE_SOURCES,
  PYTHON_TYPE_SOURCE_ORDER,
  pythonAnnotationTypeFacetPass,
} from "../../../../../../../src/core/domains/language/python/walker/passes/annotation-type-facts.js";
import {
  PYTHON_RETURN_UNION,
  pythonAstTypeSource,
  pythonInferredReturnReader,
} from "../../../../../../../src/core/domains/language/python/walker/passes/python-ast-type-source.js";
import { pythonTypeChannels } from "../../../../../../../src/core/domains/language/python/walker/passes/python-type-channels.js";
import { materializeTree } from "../../../../../../../src/core/infra/materialize.js";

function parse(src: string): AstNode {
  const parser = new Parser();
  parser.setLanguage(PyLang);
  return materializeTree(parser.parse(src).rootNode, src);
}

function facts(src: string): TypeFact[] {
  return pythonAstTypeSource.extract({ root: parse(src), trackLocalTypes: true });
}

/** The whole facet as production runs it: every source, ranked, rendered as channels. */
function structuredReturnTypes(src: string): Record<string, unknown> {
  const root = parse(src);
  const all = PYTHON_INLINE_TYPE_SOURCES.flatMap((source) => source.extract({ root, trackLocalTypes: true }));
  const channel =
    pythonTypeChannels(TypeFactStore.fromFacts(all, PYTHON_TYPE_SOURCE_ORDER), { chunks: [], relPath: "pkg/svc.py" })
      .structuredReturnTypes ?? {};
  // What is INFERRED is pinned here; a member's declaring-file twin
  // (`pkg/svc.py::Cls#m`, bd tea-rags-mcp-m99j1.1.35) is the channel test's.
  return Object.fromEntries(Object.entries(channel).filter(([key]) => !isMemberTwin(key)));
}

const isMemberTwin = (key: string): boolean => key.startsWith("pkg/svc.py::") && /[#.]/.test(key.slice(12));

const instance = (name: string) => ({ form: "instance", name }) as const;

/**
 * A module-level def's channel key. It was the bare name until E5.1c qualified
 * it with the declaring file (bd tea-rags-mcp-1v12o.1.7); a class member keeps
 * its `Cls#m` / `Cls.m` form and is spelled literally below.
 */
const moduleKey = (name: string): string => `pkg/svc.py::${name}`;

describe("pythonAstTypeSource — what it infers", () => {
  it("infers a constructor return", () => {
    const emitted = facts(["class Factory:", "    def build(self):", "        return Widget()", ""].join("\n"));
    expect(emitted).toContainEqual(
      expect.objectContaining({
        kind: "return",
        source: "ast",
        symbolScope: ["Factory"],
        methodName: "build",
        type: instance("Widget"),
      }),
    );
  });

  it("infers self as the enclosing class", () => {
    expect(
      structuredReturnTypes(["class Builder:", "    def with_x(self):", "        return self", ""].join("\n")),
    ).toEqual({ "Builder#with_x": instance("Builder") });
  });

  it("infers cls(...) as the enclosing class, keyed with the class-form separator", () => {
    const src = ["class Widget:", "    @classmethod", "    def make(cls, x):", "        return cls(x)", ""].join("\n");
    expect(structuredReturnTypes(src)).toEqual({ "Widget.make": instance("Widget") });
  });

  it("infers a typed self field", () => {
    const src = [
      "class Repo:",
      "    session: Session",
      "    def handle(self):",
      "        return self.session",
      "",
    ].join("\n");
    expect(structuredReturnTypes(src)).toEqual({ "Repo#handle": instance("Session") });
  });

  it("infers a same-file annotated callee one hop", () => {
    const src = ["def make() -> Widget:", "    ...", "", "def build():", "    return make()", ""].join("\n");
    expect(structuredReturnTypes(src)).toEqual({
      [moduleKey("make")]: instance("Widget"),
      [moduleKey("build")]: instance("Widget"),
    });
  });

  it("follows a local bound exactly once inside the body", () => {
    const src = ["def build():", "    w = Widget()", "    return w", ""].join("\n");
    expect(structuredReturnTypes(src)).toEqual({ [moduleKey("build")]: instance("Widget") });
  });

  it("agrees across two returns naming the same class", () => {
    const src = ["def build(flag):", "    if flag:", "        return Widget()", "    return Widget()", ""].join("\n");
    expect(structuredReturnTypes(src)).toEqual({ [moduleKey("build")]: instance("Widget") });
  });
});

describe("pythonAstTypeSource — what it declines", () => {
  it("is silent on a bare return", () => {
    const src = ["def build(flag):", "    if flag:", "        return Widget()", "    return", ""].join("\n");
    expect(facts(src)).toEqual([]);
  });

  it("is silent on a def with no return statement", () => {
    expect(facts(["def build():", "    Widget()", ""].join("\n"))).toEqual([]);
  });

  it("is silent on a generator", () => {
    const src = ["def build(items):", "    for i in items:", "        yield Widget()", "    return Widget()", ""].join(
      "\n",
    );
    expect(facts(src)).toEqual([]);
  });

  it("is silent on a nested def's returns", () => {
    const src = ["def outer():", "    def helper():", "        return Widget()", "    helper()", ""].join("\n");
    expect(facts(src).map((f) => f.methodName)).toEqual(["helper"]);
  });

  it("is silent on a local reassigned twice", () => {
    const src = ["def build(flag):", "    w = Widget()", "    w = Gadget()", "    return w", ""].join("\n");
    expect(facts(src)).toEqual([]);
  });

  it("is silent on a lowercase bare call with no same-file annotation", () => {
    const src = ["def build():", "    return make()", ""].join("\n");
    expect(facts(src)).toEqual([]);
  });

  it("is silent on an untyped self field", () => {
    const src = ["class Repo:", "    def handle(self):", "        return self.session", ""].join("\n");
    expect(facts(src)).toEqual([]);
  });

  it.each([
    ["tuple unpacking", ["def build(pair):", "    w = Widget()", "    w, n = pair", "    return w", ""]],
    ["an augmented assignment", ["def build():", "    w = Widget()", "    w += other", "    return w", ""]],
    [
      "a for loop rebinding it",
      ["def build(items):", "    w = Widget()", "    for w in items:", "        pass", "    return w", ""],
    ],
  ])("is silent on a local also rebound by %s", (_shape, lines) => {
    expect(facts(lines.join("\n"))).toEqual([]);
  });

  it("a nested def's assignment to the same name does not rebind the outer local", () => {
    const src = [
      "def build():",
      "    w = Widget()",
      "    def helper():",
      "        w = Gadget()",
      "    return w",
      "",
    ].join("\n");
    expect(structuredReturnTypes(src)).toEqual({ [moduleKey("build")]: instance("Widget") });
  });

  it("a method-local annotation or a non-self attribute annotation types no field", () => {
    const src = [
      "class Repo:",
      "    def handle(self, other):",
      "        s: Session = open_session()",
      "        other.session: Session = s",
      "        return self.session",
      "",
    ].join("\n");
    expect(facts(src)).toEqual([]);
  });

  it("loses to an annotation on the same def", () => {
    const src = ["class Factory:", "    def build(self) -> Gadget:", "        return Widget()", ""].join("\n");
    expect(structuredReturnTypes(src)).toEqual({ "Factory#build": instance("Gadget") });
  });
});

/**
 * bd tea-rags-mcp-m99j1.1.36 / .1.49 — the return a def DELEGATES to a sibling
 * on its own class (`return self._cursor()`), to a same-file def whose own
 * return is itself inferred, or to a field the class assigns from a
 * constructor. One fixpoint over the file's defs and fields, cycle-guarded; the
 * kernel's four rules still decide every arm, so a delegation is exactly as
 * precise as the def it delegates to.
 */
describe("pythonAstTypeSource — delegated returns (self-calls, inferred callees, assigned fields)", () => {
  it("infers a return that delegates to a same-class method through two hops and a local", () => {
    const src = [
      "class Conn:",
      "    def make_cursor(self, c):",
      "        return CursorWrapper(c, self)",
      "    def _prepare_cursor(self, c):",
      "        wrapped = self.make_cursor(c)",
      "        return wrapped",
      "    def _cursor(self):",
      "        return self._prepare_cursor(self.create_cursor())",
      "    def cursor(self):",
      "        return self._cursor()",
      "",
    ].join("\n");
    const channels = structuredReturnTypes(src);
    expect(channels["Conn#cursor"]).toEqual(instance("CursorWrapper"));
    expect(channels["Conn#_cursor"]).toEqual(instance("CursorWrapper"));
    expect(channels["Conn#_prepare_cursor"]).toEqual(instance("CursorWrapper"));
  });

  it("reads a same-class callee's annotation, and a `cls.m()` delegation on a classmethod", () => {
    const src = [
      "class Repo:",
      "    def session(self) -> Session:",
      "        ...",
      "    def handle(self):",
      "        return self.session()",
      "    @classmethod",
      "    def build(cls):",
      "        return cls()",
      "    @classmethod",
      "    def default(cls):",
      "        return cls.build()",
      "",
    ].join("\n");
    const channels = structuredReturnTypes(src);
    expect(channels["Repo#handle"]).toEqual(instance("Session"));
    expect(channels["Repo.default"]).toEqual(instance("Repo"));
  });

  it("carries a `-> Self` callee's marker through, so the reader substitutes the receiver", () => {
    const src = [
      "class Query:",
      "    def chain(self) -> Self:",
      "        ...",
      "    def filter(self):",
      "        return self.chain()",
      "",
    ].join("\n");
    expect(structuredReturnTypes(src)["Query#filter"]).toEqual(instance("Self"));
  });

  it("types `copy.copy(self)` as the Self marker, through a local", () => {
    const src = [
      "import copy",
      "class Expr:",
      "    def copy(self):",
      "        c = copy.copy(self)",
      "        c.copied = True",
      "        return c",
      "    def relabeled(self):",
      "        return self.copy()",
      "",
    ].join("\n");
    const channels = structuredReturnTypes(src);
    expect(channels["Expr#copy"]).toEqual(instance("Self"));
    expect(channels["Expr#relabeled"]).toEqual(instance("Self"));
  });

  it("infers a same-file callee whose own return is inferred, not annotated", () => {
    const src = ["def make():", "    return Widget()", "", "def build():", "    return make()", ""].join("\n");
    expect(structuredReturnTypes(src)[moduleKey("build")]).toEqual(instance("Widget"));
  });

  it("types a field every assignment of which constructs one class, a None initialiser aside", () => {
    const src = [
      "class Form:",
      "    def __init__(self):",
      "        self._errors = None",
      "    def full_clean(self):",
      "        self._errors = ErrorDict()",
      "    def errors(self):",
      "        if self._errors is None:",
      "            self.full_clean()",
      "        return self._errors",
      "",
    ].join("\n");
    expect(structuredReturnTypes(src)["Form#errors"]).toEqual(instance("ErrorDict"));
  });

  it("types a field assigned from a same-class call, and a local bound from a self-call", () => {
    const src = [
      "class Expression:",
      "    def _resolve_output_field(self):",
      "        return Field()",
      "    def __init__(self):",
      "        self._field = self._resolve_output_field()",
      "    def field(self):",
      "        return self._field",
      "    def output_field(self):",
      "        output_field = self._resolve_output_field()",
      "        if output_field is None:",
      "            raise FieldError('x')",
      "        return output_field",
      "",
    ].join("\n");
    const channels = structuredReturnTypes(src);
    expect(channels["Expression#field"]).toEqual(instance("Field"));
    expect(channels["Expression#output_field"]).toEqual(instance("Field"));
  });

  it("the descriptor reader answers the declaring class for a Self-marked return", () => {
    const root = parse(
      ["import copy", "class Expr:", "    def copy(self):", "        return copy.copy(self)", ""].join("\n"),
    );
    const classBody = root.namedChildren[1]?.childForFieldName("body");
    const def = classBody?.namedChildren[0];
    expect(def?.type).toBe("function_definition");
    expect(pythonInferredReturnReader(root)(def as AstNode, "Expr")).toBe("Expr");
  });
});

describe("pythonAstTypeSource — union returns (bd tea-rags-mcp-m99j1.1.53)", () => {
  const union = (...names: string[]) => ({ form: "union", members: names.map(instance) });

  it("caps a union at the resolver's dispatch fan cap — the walker restates it, this pins it", () => {
    expect(PYTHON_RETURN_UNION.maxArms).toBe(PY_DISPATCH_FAN_MAX);
  });

  it("unions two returns naming different classes, in declaration order", () => {
    const src = ["def build(flag):", "    if flag:", "        return Widget()", "    return Gadget()", ""].join("\n");
    expect(structuredReturnTypes(src)).toEqual({ [moduleKey("build")]: union("Widget", "Gadget") });
  });

  it("unions a local bound on two branches, and carries the union through self-delegation (django _prepare_cursor)", () => {
    const src = [
      "class BaseDatabaseWrapper:",
      "    def make_debug_cursor(self, cursor):",
      "        return CursorDebugWrapper(cursor, self)",
      "    def make_cursor(self, cursor):",
      "        return CursorWrapper(cursor, self)",
      "    def _prepare_cursor(self, cursor):",
      "        if self.queries_logged:",
      "            wrapped_cursor = self.make_debug_cursor(cursor)",
      "        else:",
      "            wrapped_cursor = self.make_cursor(cursor)",
      "        return wrapped_cursor",
      "    def _cursor(self, name=None):",
      "        return self._prepare_cursor(self.create_cursor(name))",
      "    def cursor(self):",
      "        return self._cursor()",
      "",
    ].join("\n");
    const channel = structuredReturnTypes(src);
    expect(channel["BaseDatabaseWrapper#_prepare_cursor"]).toEqual(union("CursorDebugWrapper", "CursorWrapper"));
    expect(channel["BaseDatabaseWrapper#cursor"]).toEqual(union("CursorDebugWrapper", "CursorWrapper"));
  });

  it("unions try / except branches, and a branch that conditionally rebinds an earlier value", () => {
    const tryExcept = [
      "def build():",
      "    try:",
      "        w = Widget()",
      "    except KeyError:",
      "        w = Gadget()",
      "    return w",
      "",
    ].join("\n");
    const conditional = [
      "def build(flag):",
      "    w = Widget()",
      "    if flag:",
      "        w = Gadget()",
      "    return w",
      "",
    ].join("\n");
    expect(structuredReturnTypes(tryExcept)).toEqual({ [moduleKey("build")]: union("Widget", "Gadget") });
    expect(structuredReturnTypes(conditional)).toEqual({ [moduleKey("build")]: union("Widget", "Gadget") });
  });

  it("is silent when a later unconditional assignment overwrites a branch's value", () => {
    const src = [
      "def build(flag):",
      "    if flag:",
      "        w = Widget()",
      "    w = Gadget()",
      "    return w",
      "",
    ].join("\n");
    expect(facts(src)).toEqual([]);
  });

  it("is silent on a union wider than the Python dispatch fan cap", () => {
    const src = [
      "def build(n):",
      "    if n == 1:",
      "        return A()",
      "    if n == 2:",
      "        return B()",
      "    if n == 3:",
      "        return C()",
      "    if n == 4:",
      "        return D()",
      "    return E()",
      "",
    ].join("\n");
    expect(facts(src)).toEqual([]);
  });

  it("is silent when one arm is the Self marker — a union never carries it", () => {
    const src = [
      "import copy",
      "class Expr:",
      "    def pick(self, flag):",
      "        if flag:",
      "            return copy.copy(self)",
      "        return Widget()",
      "",
    ].join("\n");
    expect(facts(src)).toEqual([]);
  });

  it("the descriptor reader answers null for a union — a field type is one class", () => {
    const root = parse(
      [
        "class Box:",
        "    def pick(self, flag):",
        "        if flag:",
        "            return A()",
        "        return B()",
        "",
      ].join("\n"),
    );
    const def = root.namedChildren[0]?.childForFieldName("body")?.namedChildren[0];
    expect(def?.type).toBe("function_definition");
    expect(pythonInferredReturnReader(root)(def as AstNode, "Box")).toBeNull();
  });
});

describe("pythonAstTypeSource — delegated returns it declines", () => {
  const methodsOf = (src: string): string[] =>
    facts(src)
      .flatMap((f) => (f.methodName === undefined ? [] : [f.methodName]))
      .sort();

  it("is silent on a delegation cycle, and terminates", () => {
    const src = [
      "class Loop:",
      "    def a(self):",
      "        return self.b()",
      "    def b(self, flag):",
      "        if flag:",
      "            return Widget()",
      "        return self.a()",
      "",
    ].join("\n");
    expect(facts(src)).toEqual([]);
  });

  it("is silent on a self-call to a method the class does not define (inherited or dynamic)", () => {
    const src = ["class Child(Base):", "    def cursor(self):", "        return self._cursor()", ""].join("\n");
    expect(facts(src)).toEqual([]);
  });

  it("is silent on a self-call to a method the class defines twice", () => {
    const src = [
      "class Twice:",
      "    def make(self):",
      "        return Widget()",
      "    def make(self):",
      "        return Widget()",
      "    def build(self):",
      "        return self.make()",
      "",
    ].join("\n");
    expect(methodsOf(src)).toEqual(["make", "make"]);
  });

  it("is silent on a self-call to a property — the call invokes what the property returns", () => {
    const src = [
      "class Holder:",
      "    @property",
      "    def factory(self):",
      "        return Widget()",
      "    def build(self):",
      "        return self.factory()",
      "",
    ].join("\n");
    expect(methodsOf(src)).toEqual(["factory"]);
  });

  it.each([
    ["two different constructors", ["        self.x = Widget()", "        self.x = Gadget()"]],
    ["a parameter alongside a constructor", ["        self.x = Widget()", "        self.x = other"]],
    ["an augmented assignment", ["        self.x = Widget()", "        self.x += other"]],
    ["a tuple target", ["        self.x = Widget()", "        self.x, self.y = pair"]],
    ["only None", ["        self.x = None"]],
  ])("is silent on a field assigned %s", (_shape, assignments) => {
    const src = [
      "class Holder:",
      "    def setup(self, other, pair):",
      ...assignments,
      "    def get(self):",
      "        return self.x",
      "",
    ].join("\n");
    expect(facts(src)).toEqual([]);
  });

  it("a nested class's `self.x` assignment does not type the outer class's field", () => {
    const src = [
      "class Outer:",
      "    class Inner:",
      "        def __init__(self):",
      "            self.x = Widget()",
      "    def get(self):",
      "        return self.x",
      "",
    ].join("\n");
    expect(methodsOf(src)).toEqual([]);
  });

  it("is silent on `copy.copy` of something other than self", () => {
    const src = ["import copy", "class Expr:", "    def dup(self, other):", "        return copy.copy(other)", ""].join(
      "\n",
    );
    expect(facts(src)).toEqual([]);
  });
});

/**
 * The facet pass publishes inferred arms under the spelling the DECLARING file
 * binds them by (bd tea-rags-mcp-m99j1.1.55), so a reader in another file places
 * them where the return was written. The inference itself stays bare.
 */
describe("pythonAnnotationTypeFacetPass — return arms qualified by the declaring file's imports", () => {
  const published = (src: string): Record<string, unknown> =>
    pythonAnnotationTypeFacetPass.run(parse(src), {
      code: src,
      relPath: "db/backends/base/base.py",
      language: "python",
      chunks: [],
    }).structuredReturnTypes ?? {};

  it("keeps a module-attribute constructor's dotted spelling, qualified through the binding", () => {
    const src = [
      "from db.backends import utils",
      "class BaseDatabaseWrapper:",
      "    def _prepare_cursor(self, cursor):",
      "        if self.queries_logged:",
      "            return utils.CursorDebugWrapper(cursor, self)",
      "        return utils.CursorWrapper(cursor, self)",
      "",
    ].join("\n");
    const prepared = {
      form: "union",
      members: [instance("db.backends.utils::CursorDebugWrapper"), instance("db.backends.utils::CursorWrapper")],
    };
    // Bare, and its declaring-file twin (bd tea-rags-mcp-m99j1.1.35).
    expect(published(src)).toEqual({
      "BaseDatabaseWrapper#_prepare_cursor": prepared,
      "db/backends/base/base.py::BaseDatabaseWrapper#_prepare_cursor": prepared,
    });
  });

  it("qualifies a from-imported bare name and leaves a same-file class bare", () => {
    const src = [
      "from .models import Widget",
      "class Gadget: pass",
      "def make(flag):",
      "    if flag:",
      "        return Widget()",
      "    return Gadget()",
      "",
    ].join("\n");
    expect(published(src)).toEqual({
      "db/backends/base/base.py::make": { form: "union", members: [instance(".models::Widget"), instance("Gadget")] },
    });
  });

  it("leaves a dotted spelling no import binds as its bare last segment", () => {
    const src = ["def make():", "    return Outer.Inner()", ""].join("\n");
    expect(published(src)).toEqual({ "db/backends/base/base.py::make": instance("Inner") });
  });
});
