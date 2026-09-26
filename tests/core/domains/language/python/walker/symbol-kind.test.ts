/**
 * Python walker symbol kinds (bd tea-rags-mcp-vi0wx). Every chunk the walker
 * emits carries the declaration kind the node spells: a `class` is `class`, a
 * `def` in a class body is `method` whatever its decorator, and every other
 * `def` — module-level or nested in another def — is `function`.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { PythonLanguage } from "../../../../../../src/core/domains/language/python/index.js";
import { symbolKindOf } from "../../../../../../src/core/domains/language/python/walker/symbol-kind.js";
import { materializeTree } from "../../../../../../src/core/infra/materialize.js";

/**
 * `symbolId → symbolKind` for every chunk the COMPOSED walker emits, through the
 * seam production runs: materialize, `collectSymbols(tree, walker.nameOf, …)`,
 * then `walker.walk`.
 */
function symbolKindsOf(src: string): Record<string, string | undefined> {
  const language = new PythonLanguage();
  const parser = new Parser();
  parser.setLanguage(PyLang);
  const rootNode = materializeTree(parser.parse(src).rootNode, src);
  const tree = { rootNode };
  const chunks = collectSymbols(
    tree,
    (node) => language.walker.nameOf(node),
    language.kernel.scopeSeparator ?? ".",
    language.kernel.disambiguateOverloads ?? false,
    new DefaultSymbolIdComposer(),
  );
  const extraction = language.walker.walk({ tree, code: src, relPath: "app/a.py", language: "python", chunks });
  const out: Record<string, string | undefined> = {};
  for (const chunk of extraction.chunks) out[chunk.symbolId] = chunk.symbolKind;
  return out;
}

describe("Python walker — symbol kind per chunk", () => {
  it("tags a class, a module function and every method shape", () => {
    const src = [
      "class A:",
      "    def m(self): pass",
      "    @classmethod",
      "    def c(cls): pass",
      "    @staticmethod",
      "    def s(): pass",
      "",
      "def f():",
      "    pass",
      "",
    ].join("\n");
    expect(symbolKindsOf(src)).toEqual({
      A: "class",
      "A#m": "method",
      "A.c": "method",
      "A.s": "method",
      f: "function",
    });
  });

  it("tags a def nested in a method as a function and a nested class as a class", () => {
    const src = [
      "class Outer:",
      "    class Inner:",
      "        pass",
      "    def m(self):",
      "        def helper():",
      "            pass",
      "        return helper",
      "",
    ].join("\n");
    const kinds = symbolKindsOf(src);
    expect(kinds.Outer).toBe("class");
    expect(kinds["Outer.Inner"]).toBe("class");
    expect(kinds["Outer#m"]).toBe("method");
    const helper = Object.entries(kinds).find(([id]) => id.endsWith("helper"));
    expect(helper?.[1]).toBe("function");
  });

  it("tags the implementation def an @overload group yields its symbol to", () => {
    const src = [
      "from typing import overload",
      "class A:",
      "    @overload",
      "    def m(self, x: int) -> int: ...",
      "    def m(self, x): return x",
      "",
    ].join("\n");
    expect(symbolKindsOf(src)["A#m"]).toBe("method");
  });
});

describe("symbolKindOf", () => {
  it("maps a class definition to class", () => {
    expect(symbolKindOf("class_definition", { inClassBody: false })).toBe("class");
    expect(symbolKindOf("class_definition", { inClassBody: true })).toBe("class");
  });

  it("maps a def to method only in a class body", () => {
    expect(symbolKindOf("function_definition", { inClassBody: true })).toBe("method");
    expect(symbolKindOf("function_definition", { inClassBody: false })).toBe("function");
  });

  it("leaves a node that declares no symbol unmapped", () => {
    expect(symbolKindOf("assignment", { inClassBody: false })).toBeUndefined();
    expect(symbolKindOf("decorated_definition", { inClassBody: true })).toBeUndefined();
  });
});
