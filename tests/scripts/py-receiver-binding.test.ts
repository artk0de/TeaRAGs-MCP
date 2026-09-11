import { describe, expect, it } from "vitest";

import {
  classifyBindingReason,
  importNarrowsToOne,
  reasonForAnnotatedParam,
  reasonForCallResult,
  returnExprShape,
  type PyDefFacts,
  type PyReasonView,
} from "../../scripts/lib/py-binding-reasons.js";
import { classifyReceiverBinding, enclosingPythonDef } from "../../scripts/lib/py-receiver-binding.js";

const view = (src: string[], classes: string[] = [], defs: string[] = []) => ({
  linesOf: () => src,
  isProjectClass: (n: string) => classes.includes(n),
  isProjectDef: (n: string) => defs.includes(n),
});
const row = (line: number, receiver: string) => ({
  relPath: "a.py",
  startLine: line,
  receiver,
  receiverKind: "dynamic",
});

const def = (over: Partial<PyDefFacts>): PyDefFacts => ({
  relPath: "a.py",
  line: 0,
  returnAnnotation: null,
  isClassMethod: false,
  isAsync: false,
  hasYield: false,
  returnExprs: [],
  ...over,
});

const reasonView = (over: Partial<PyReasonView>): PyReasonView => ({
  linesOf: () => [],
  defsNamed: () => [],
  classFilesNamed: () => [],
  importLinesOf: () => [],
  isProtocolClass: () => false,
  typeVarNames: () => new Set<string>(),
  fieldAnnotationOf: () => null,
  ...over,
});

describe("classifyReceiverBinding", () => {
  it("calls an unannotated parameter a parameter", () => {
    const src = ["def f(x):", "    x.m()"];
    expect(classifyReceiverBinding(row(2, "x"), view(src)).binding).toBe("paramUnannotated");
  });

  it("keeps an annotated parameter apart from an unannotated one", () => {
    const src = ["def f(x: Foo):", "    x.m()"];
    expect(classifyReceiverBinding(row(2, "x"), view(src)).binding).toBe("paramAnnotated");
  });

  // spec D7 — self/cls are E4.4's class-object family, never parameters.
  it("does not call cls a parameter", () => {
    const src = ["class C:", "    @classmethod", "    def f(cls):", "        cls.m()"];
    expect(classifyReceiverBinding(row(4, "cls"), view(src)).binding).not.toBe("paramUnannotated");
  });

  // The prototype's enclosing-def scan updated its indent watermark on any
  // dedented line, so a flush-left comment orphaned every row below it.
  it("finds the enclosing def past a flush-left comment", () => {
    const src = ["def f(x):", "    y = 1", "# note", "    x.m()"];
    expect(enclosingPythonDef(src, 4)?.name).toBe("f");
    expect(classifyReceiverBinding(row(4, "x"), view(src)).binding).toBe("paramUnannotated");
  });

  it("separates an in-project call result from an external one", () => {
    const src = ["def f():", "    r = Repo.from_session(s)", "    r.m()"];
    expect(classifyReceiverBinding(row(3, "r"), view(src, ["Repo"])).binding).toBe("assignCallProject");
    expect(classifyReceiverBinding(row(3, "r"), view(src)).binding).toBe("assignCallExternal");
  });

  it("reads a loop target as a loop target and a walrus as a walrus", () => {
    expect(classifyReceiverBinding(row(2, "a"), view(["def f(xs):", "    for a in xs:"])).binding).toBe("loopTarget");
    expect(classifyReceiverBinding(row(2, "a"), view(["def f():", "    if (a := g()):"])).binding).toBe("walrus");
  });

  it("reports unbound rather than guessing", () => {
    expect(classifyReceiverBinding(row(2, "z"), view(["def f():", "    z.m()"])).binding).toBe("unbound");
  });
});

describe("reasonForCallResult", () => {
  it("blames the annotation form the facet drops", () => {
    const v = reasonView({ defsNamed: () => [def({ returnAnnotation: "Iterator[Thing]" })] });
    expect(reasonForCallResult("make", v)).toBe("a1AnnotationDropped");
  });

  it("separates a one-hop transitive fold from a deeper one", () => {
    const deep = reasonView({
      defsNamed: (n: string) => (n === "outer" ? [def({ returnExprs: ["inner()"] })] : [def({ returnExprs: ["x"] })]),
    });
    expect(reasonForCallResult("outer", deep)).toBe("a2TransitiveDeeper");
    const shallow = reasonView({
      defsNamed: (n: string) =>
        n === "outer" ? [def({ returnExprs: ["inner()"] })] : [def({ returnAnnotation: "Thing" })],
    });
    expect(reasonForCallResult("outer", shallow)).toBe("a2TransitiveDepth1");
  });

  it("calls a -> Self classmethod factory what it is", () => {
    const v = reasonView({ defsNamed: () => [def({ returnAnnotation: "Self", isClassMethod: true })] });
    expect(reasonForCallResult("from_session", v)).toBe("a6ClsSelfFactory");
  });

  it("counts a namesake callee separately from an unresolved one", () => {
    const namesake = reasonView({ classFilesNamed: () => ["models/checkout.py", "checkout/schemas.py"] });
    expect(reasonForCallResult("Checkout", namesake)).toBe("a7NamesakeCallee");
    expect(reasonForCallResult("nowhere", reasonView({}))).toBe("a8CalleeUnresolved");
  });

  it("reads a conditional return as a disagreement", () => {
    const v = reasonView({ defsNamed: () => [def({ returnExprs: ["a if b else c"] })] });
    expect(reasonForCallResult("pick", v)).toBe("a3MultiReturnDisagree");
  });
});

describe("reasonForAnnotatedParam", () => {
  it("names the form that produced no receiver", () => {
    expect(reasonForAnnotatedParam("a.py", "A | B", reasonView({}))).toBe("b2UnionMulti");
    expect(reasonForAnnotatedParam("a.py", "Callable[[int], str]", reasonView({}))).toBe("b5OpaqueCallable");
    expect(reasonForAnnotatedParam("a.py", "list[Thing]", reasonView({}))).toBe("b4GenericContainer");
    expect(reasonForAnnotatedParam("a.py", "T", reasonView({ typeVarNames: () => new Set(["T"]) }))).toBe("b8TypeVar");
  });

  it("keeps a protocol and a namesake apart from an external name", () => {
    const protocol = reasonView({ isProtocolClass: () => true, classFilesNamed: () => ["p.py"] });
    expect(reasonForAnnotatedParam("a.py", "Reader", protocol)).toBe("b3Protocol");
    const namesake = reasonView({ classFilesNamed: () => ["m/x.py", "s/x.py"] });
    expect(reasonForAnnotatedParam("a.py", "Meter", namesake)).toBe("b7Namesake");
    expect(reasonForAnnotatedParam("a.py", "Session", reasonView({}))).toBe("b9External");
  });

  it("reads a string forward reference to another module", () => {
    const v = reasonView({ classFilesNamed: () => ["other.py"] });
    expect(reasonForAnnotatedParam("a.py", '"Thing"', v)).toBe("b1StringForwardRef");
  });
});

describe("returnExprShape and the namesake probe", () => {
  it("classifies the five RF.2 shapes", () => {
    expect(returnExprShape("Widget()")).toBe("ctor:Widget");
    expect(returnExprShape("await helper()")).toBe("call:helper");
    expect(returnExprShape("self.session")).toBe("selfAttr");
    expect(returnExprShape("cls(**kw)")).toBe("self");
    expect(returnExprShape("a if b else c")).toBe("cond");
  });

  it("says whether the caller's own imports pick exactly one namesake", () => {
    const v = reasonView({ importLinesOf: () => ["from polar.models.checkout import Checkout"] });
    const files = ["server/polar/models/checkout.py", "server/polar/checkout/schemas.py"];
    expect(importNarrowsToOne("caller.py", "Checkout", files, v)).toBe(true);
    const blind = reasonView({ importLinesOf: () => ["from .models import Checkout"] });
    expect(importNarrowsToOne("caller.py", "Checkout", files, blind)).toBe(false);
  });

  it("reads an annotated self-field iterable as a container hop", () => {
    const attribution = { binding: "loopTarget" as const, detail: "self.children", defLine: 0 };
    const v = reasonView({ fieldAnnotationOf: () => "list[Decoder]" });
    expect(classifyBindingReason(row(9, "child"), attribution, v)).toBe("d1IterableContainerAnnotated");
  });

  it("routes an unbound implicit receiver to its own bucket", () => {
    const attribution = { binding: "unbound" as const, detail: "", defLine: null };
    expect(classifyBindingReason(row(2, "cls"), attribution, reasonView({}))).toBe("c1ImplicitReceiver");
  });
});
