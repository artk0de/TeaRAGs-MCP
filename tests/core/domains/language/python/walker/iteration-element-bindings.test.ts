/**
 * P1 iteration bindings, walker half (bd tea-rags-mcp-m99j1.1.18): a `for`
 * target and a comprehension target are recorded as `iterationElement`
 * bindings carrying the ITERATED expression, never a type — the resolver
 * folds the expression, because the container's type lives in facts a
 * per-file pass cannot see.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { LocalBinding } from "../../../../../../src/core/contracts/types/codegraph.js";
import { extractFromPythonFile } from "../../../../../../src/core/domains/language/python/walker/walker.js";

function bindingsOf(src: string): Record<string, LocalBinding[]> {
  const parser = new Parser();
  parser.setLanguage(PyLang);
  const lines = src.split("\n").length;
  const extraction = extractFromPythonFile({
    tree: parser.parse(src),
    code: src,
    relPath: "app/registry.py",
    language: "python",
    chunks: [{ symbolId: "Apps#run", scope: ["Apps"], startLine: 1, endLine: lines }],
  });
  return extraction.chunks[0].localBindings ?? {};
}

describe("Python walker — iteration element bindings", () => {
  it("a `for` target carries the iterated expression", () => {
    const src = [
      "class Apps:",
      "    def run(self):",
      "        for app_config in self.app_configs.values():",
      "            app_config.get_models()",
    ].join("\n");
    expect(bindingsOf(src).app_config).toEqual([
      {
        line: 3,
        type: "",
        valueKind: "iterationElement",
        sourceExpression: "self.app_configs.values()",
        endLine: 3,
      },
    ]);
  });

  it("a flat tuple target binds each name at its element position", () => {
    const src = [
      "class Apps:",
      "    def run(self, ops):",
      "        for i, op in enumerate(ops):",
      "            op.reduce()",
    ].join("\n");
    const bindings = bindingsOf(src);
    expect(bindings.op).toEqual([
      {
        line: 3,
        type: "",
        valueKind: "iterationElement",
        sourceExpression: "enumerate(ops)",
        tupleIndex: 1,
        endLine: 3,
      },
    ]);
    expect(bindings.i?.[0]).toMatchObject({ valueKind: "iterationElement", tupleIndex: 0 });
  });

  it("a comprehension target is scoped to the comprehension", () => {
    const src = [
      "class Apps:",
      "    def run(self, xs):",
      "        names = [",
      "            x.name()",
      "            for x in xs",
      "        ]",
      "        return names",
    ].join("\n");
    expect(bindingsOf(src).x).toEqual([
      { line: 3, type: "", valueKind: "iterationElement", sourceExpression: "xs", scopeEndLine: 6 },
    ]);
  });

  it("a starred or nested target emits nothing", () => {
    const src = [
      "class Apps:",
      "    def run(self, rows):",
      "        for head, *rest in rows:",
      "            head.x()",
      "        for (a, b), c in rows:",
      "            c.x()",
      "        for self.cursor in rows:",
      "            pass",
    ].join("\n");
    const bindings = bindingsOf(src);
    expect(bindings.head).toBeUndefined();
    expect(bindings.rest).toBeUndefined();
    expect(bindings.a).toBeUndefined();
    expect(bindings.c).toBeUndefined();
  });
});
