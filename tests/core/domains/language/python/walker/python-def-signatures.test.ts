/**
 * Python def signatures and call shapes (E4.1.2, bd tea-rags-mcp-w205u).
 *
 * The four neutral channels `ArityNarrower` / `KwargNarrower` read —
 * `ChunkExtraction.arity` / `.kwargs` on the def side, `CallRef.argCount` /
 * `.kwargKeys` / `.hasKwargSplat` on the call side — had exactly one writer (the
 * Ruby walker). These pin Python's, and the emission rule that makes them SAFE
 * for a language where a positional-or-keyword parameter may be passed by
 * keyword: `kwargs.optional` carries the positional names too, so
 * `f(timeout=3)` against `def f(timeout)` KEEPS the candidate.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import {
  collectPythonDefSignatures,
  pythonCallShape,
} from "../../../../../../src/core/domains/language/python/walker/passes/python-def-signatures.js";
import { extractFromPythonFile } from "../../../../../../src/core/domains/language/python/walker/walker.js";

function parse(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(PyLang);
  return parser.parse(src);
}

function signaturesOf(src: string) {
  return collectPythonDefSignatures(parse(src).rootNode);
}

/** The first `call` node in source order — every call case below has exactly one. */
function shapeOf(src: string) {
  const stack: Parser.SyntaxNode[] = [parse(src).rootNode];
  while (stack.length > 0) {
    const node = stack.shift() as Parser.SyntaxNode;
    if (node.type === "call") return pythonCallShape(node);
    stack.push(...node.children);
  }
  throw new Error("no call node");
}

describe("collectPythonDefSignatures", () => {
  it("splits positional, splat and keyword-only params", () => {
    const sig = signaturesOf("def f(a, b=1, *args, k, j=2, **kw): pass").get(1);
    expect(sig?.arity).toEqual({ minRequired: 1, maxPositional: 2, hasSplat: true });
    expect(sig?.kwargs).toEqual({ required: ["k"], optional: ["a", "b", "j"], hasSplat: true });
  });

  it("drops the implicit `self` of a method", () => {
    const src = ["class C:", "    def m(self, x): pass"].join("\n");
    const sig = signaturesOf(src).get(2);
    expect(sig?.arity).toEqual({ minRequired: 1, maxPositional: 1, hasSplat: false });
    expect(sig?.kwargs?.optional).toEqual(["x"]);
  });

  it("drops the implicit `cls` of a classmethod", () => {
    const src = ["class C:", "    @classmethod", "    def c(cls, x): pass"].join("\n");
    const sig = signaturesOf(src).get(3);
    expect(sig?.arity).toEqual({ minRequired: 1, maxPositional: 1, hasSplat: false });
    expect(sig?.kwargs?.optional).toEqual(["x"]);
  });

  it("keeps every parameter of a staticmethod", () => {
    const src = ["class C:", "    @staticmethod", "    def s(self, x): pass"].join("\n");
    const sig = signaturesOf(src).get(3);
    expect(sig?.arity).toEqual({ minRequired: 2, maxPositional: 2, hasSplat: false });
    expect(sig?.kwargs?.optional).toEqual(["self", "x"]);
  });

  it("excludes a positional-only param from the nameable set", () => {
    const sig = signaturesOf("def g(a, /, b): pass").get(1);
    expect(sig?.arity).toEqual({ minRequired: 2, maxPositional: 2, hasSplat: false });
    expect(sig?.kwargs).toEqual({ required: [], optional: ["b"], hasSplat: false });
  });

  it("marks a bare `*` keyword separator without a splat", () => {
    const sig = signaturesOf("def s(a, *, c, d=1): pass").get(1);
    expect(sig?.arity).toEqual({ minRequired: 1, maxPositional: 1, hasSplat: false });
    expect(sig?.kwargs).toEqual({ required: ["c"], optional: ["a", "d"], hasSplat: false });
  });

  it("omits kwargs entirely for a def with no nameable parameter", () => {
    const sig = signaturesOf("async def h(): pass").get(1);
    expect(sig?.arity).toEqual({ minRequired: 0, maxPositional: 0, hasSplat: false });
    expect(sig?.kwargs).toBeUndefined();
  });

  it("gives a nested def its own entry at its own line", () => {
    const src = ["def outer(a):", "    def inner(b, c): pass", "    return inner"].join("\n");
    const sigs = signaturesOf(src);
    expect(sigs.get(1)?.arity).toEqual({ minRequired: 1, maxPositional: 1, hasSplat: false });
    expect(sigs.get(2)?.arity).toEqual({ minRequired: 2, maxPositional: 2, hasSplat: false });
  });

  it("ignores a lambda — it is not a def and gets no entry", () => {
    const sigs = signaturesOf("f = lambda a, b: a + b\n");
    expect(sigs.size).toBe(0);
  });

  it("reads a typed and defaulted parameter list", () => {
    const sig = signaturesOf("def ann(a: int, b: str = 'x', *, c: float): pass").get(1);
    expect(sig?.arity).toEqual({ minRequired: 1, maxPositional: 2, hasSplat: false });
    expect(sig?.kwargs).toEqual({ required: ["c"], optional: ["a", "b"], hasSplat: false });
  });
});

describe("pythonCallShape", () => {
  it("counts positionals and names keywords", () => {
    expect(shapeOf("f(1, 2, k=3)\n")).toEqual({ argCount: 2, kwargKeys: ["k"] });
  });

  it("records a dictionary splat as unknown runtime keys", () => {
    expect(shapeOf("f(1, 2, k=3, **rest)\n")).toEqual({ argCount: 2, kwargKeys: ["k"], hasKwargSplat: true });
  });

  it("omits argCount entirely when a positional splat hides the count", () => {
    const shape = shapeOf("f(*xs, **kw)\n");
    expect(shape.argCount).toBeUndefined();
    expect(shape.hasKwargSplat).toBe(true);
  });

  it("reads an empty argument list as zero positionals", () => {
    expect(shapeOf("f()\n")).toEqual({ argCount: 0 });
  });

  it("reads a receiver call the same way", () => {
    expect(shapeOf("obj.m()\n")).toEqual({ argCount: 0 });
  });

  it("counts a multi-line call by its arguments, not its lines", () => {
    expect(shapeOf("f(1,\n  2,\n  k=3)\n")).toEqual({ argCount: 2, kwargKeys: ["k"] });
  });

  it("counts a lambda and a comprehension as one positional each", () => {
    expect(shapeOf("f(lambda z: z, [q for q in y], k=1)\n")).toEqual({ argCount: 2, kwargKeys: ["k"] });
  });
});

describe("extractFromPythonFile — signature join", () => {
  const src = [
    "class C:",
    "    def m(self, x, y=1, **kw):",
    "        other.run(x, mode=2)",
    "        return x",
    "",
  ].join("\n");

  it("carries the def signature onto the method chunk", () => {
    const out = extractFromPythonFile({
      tree: parse(src),
      code: src,
      relPath: "app/c.py",
      language: "python",
      chunks: [{ symbolId: "C#m", startLine: 2, endLine: 4, scope: ["C"] }],
    });
    expect(out.chunks[0].arity).toEqual({ minRequired: 1, maxPositional: 2, hasSplat: false });
    expect(out.chunks[0].kwargs).toEqual({ required: [], optional: ["x", "y"], hasSplat: true });
  });

  it("carries the call shape onto the CallRef", () => {
    const out = extractFromPythonFile({
      tree: parse(src),
      code: src,
      relPath: "app/c.py",
      language: "python",
      chunks: [{ symbolId: "C#m", startLine: 2, endLine: 4, scope: ["C"] }],
    });
    const call = out.chunks[0].calls.find((c) => c.member === "run");
    expect(call?.argCount).toBe(1);
    expect(call?.kwargKeys).toEqual(["mode"]);
  });

  it("leaves a class chunk with no signature at all", () => {
    const out = extractFromPythonFile({
      tree: parse(src),
      code: src,
      relPath: "app/c.py",
      language: "python",
      chunks: [{ symbolId: "C", startLine: 1, endLine: 4, scope: [] }],
    });
    expect(out.chunks[0].arity).toBeUndefined();
    expect(out.chunks[0].kwargs).toBeUndefined();
  });
});
