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
import {
  PYTHON_INLINE_TYPE_SOURCES,
  PYTHON_TYPE_SOURCE_ORDER,
} from "../../../../../../../src/core/domains/language/python/walker/passes/annotation-type-facts.js";
import { pythonAstTypeSource } from "../../../../../../../src/core/domains/language/python/walker/passes/python-ast-type-source.js";
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
  return (
    pythonTypeChannels(TypeFactStore.fromFacts(all, PYTHON_TYPE_SOURCE_ORDER), { chunks: [], relPath: "pkg/svc.py" })
      .structuredReturnTypes ?? {}
  );
}

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
  it("is silent when two returns disagree", () => {
    const src = ["def build(flag):", "    if flag:", "        return Widget()", "    return Gadget()", ""].join("\n");
    expect(facts(src)).toEqual([]);
  });

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

  it("loses to an annotation on the same def", () => {
    const src = ["class Factory:", "    def build(self) -> Gadget:", "        return Widget()", ""].join("\n");
    expect(structuredReturnTypes(src)).toEqual({ "Factory#build": instance("Gadget") });
  });
});
