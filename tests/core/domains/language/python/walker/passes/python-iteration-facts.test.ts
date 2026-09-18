/**
 * The iteration-variable type source (E2 seam 5 / R3, bd tea-rags-mcp-9fgdi).
 *
 * Two halves, as with every Python type source. The EMITTED rows say a loop
 * variable takes the element type of an annotated container — a field, a
 * parameter, a local, and `.values()` on a mapping. The DECLINED rows are the
 * precision gate: a bare `for k in mapping:` cannot be typed because the
 * `TypeRef` container form carries the mapping VALUE and nothing else, a tuple
 * target is not a single nominal receiver, and an element that is itself a
 * union or a container names no class the call site has.
 *
 * Every fixture is real Python parsed through tree-sitter, so a grammar change
 * that moves `for_statement`'s `right` field breaks this file rather than
 * silently emptying the channel on five corpora.
 */

import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { AstNode } from "../../../../../../../src/core/contracts/types/ast.js";
import type { FileExtraction } from "../../../../../../../src/core/contracts/types/codegraph.js";
import type { TypeFact } from "../../../../../../../src/core/domains/language/kernel/type-facts.js";
import { PythonLanguage } from "../../../../../../../src/core/domains/language/python/index.js";
import { PYTHON_INLINE_TYPE_SOURCES } from "../../../../../../../src/core/domains/language/python/walker/passes/annotation-type-facts.js";
import { pythonIterationTypeSource } from "../../../../../../../src/core/domains/language/python/walker/passes/python-iteration-facts.js";
import { materializeTree } from "../../../../../../../src/core/infra/materialize.js";

function parse(src: string): AstNode {
  const parser = new Parser();
  parser.setLanguage(PyLang);
  return materializeTree(parser.parse(src).rootNode, src);
}

function facts(src: string, trackLocalTypes = true): TypeFact[] {
  return pythonIterationTypeSource.extract({ root: parse(src), trackLocalTypes });
}

const instance = (name: string) => ({ form: "instance", name }) as const;

describe("pythonIterationTypeSource — emitted", () => {
  it("types a loop variable from an annotated field", () => {
    const src = [
      "class Basket:",
      "    items: list[Item]",
      "",
      "    def total(self):",
      "        for item in self.items:",
      "            item.price()",
      "",
    ].join("\n");
    expect(facts(src)).toEqual([
      {
        kind: "local",
        source: "ast",
        symbolScope: ["Basket"],
        methodName: "total",
        name: "item",
        line: 5,
        type: instance("Item"),
      },
    ]);
  });

  it("types a loop variable from a field annotated on `self` inside another method", () => {
    const src = [
      "class Basket:",
      "    def load(self):",
      "        self.items: list[Item] = []",
      "",
      "    def total(self):",
      "        for item in self.items:",
      "            item.price()",
      "",
    ].join("\n");
    expect(facts(src)).toEqual([
      {
        kind: "local",
        source: "ast",
        symbolScope: ["Basket"],
        methodName: "total",
        name: "item",
        line: 6,
        type: instance("Item"),
      },
    ]);
  });

  it("types a loop variable from an annotated parameter", () => {
    const src = ["def render(xs: Sequence[Row]):", "    for row in xs:", "        row.render()", ""].join("\n");
    expect(facts(src)).toEqual([
      {
        kind: "local",
        source: "ast",
        symbolScope: [],
        methodName: "render",
        name: "row",
        line: 2,
        type: instance("Row"),
      },
    ]);
  });

  it("types a loop variable from an annotated local", () => {
    const src = ["def render():", "    xs: list[Row] = load()", "    for row in xs:", "        row.render()", ""].join(
      "\n",
    );
    expect(facts(src)).toEqual([
      {
        kind: "local",
        source: "ast",
        symbolScope: [],
        methodName: "render",
        name: "row",
        line: 3,
        type: instance("Row"),
      },
    ]);
  });

  it("types a `.values()` loop variable as the mapping VALUE", () => {
    const src = ["def run(d: dict[str, Item]):", "    for item in d.values():", "        item.price()", ""].join("\n");
    expect(facts(src)).toEqual([
      {
        kind: "local",
        source: "ast",
        symbolScope: [],
        methodName: "run",
        name: "item",
        line: 2,
        type: instance("Item"),
      },
    ]);
  });

  it("reads `tuple[T, ...]` as a homogeneous container", () => {
    const src = ["def run(xs: tuple[Row, ...]):", "    for row in xs:", "        row.render()", ""].join("\n");
    expect(facts(src)).toEqual([
      { kind: "local", source: "ast", symbolScope: [], methodName: "run", name: "row", line: 2, type: instance("Row") },
    ]);
  });

  it("scopes a comprehension variable to its enclosing def", () => {
    const src = [
      "class View:",
      "    def body(self, xs: list[Row]):",
      "        return [r.render() for r in xs]",
      "",
    ].join("\n");
    expect(facts(src)).toEqual([
      {
        kind: "local",
        source: "ast",
        symbolScope: ["View"],
        methodName: "body",
        name: "r",
        line: 3,
        type: instance("Row"),
      },
    ]);
  });
});

describe("pythonIterationTypeSource — declined", () => {
  const declines = (label: string, src: string, trackLocalTypes = true): void => {
    it(label, () => {
      expect(facts(src, trackLocalTypes)).toEqual([]);
    });
  };

  declines(
    "declines a bare dict loop variable — the container ref carries the VALUE, not the key",
    ["def run(d: dict[str, Item]):", "    for key in d:", "        key.render()", ""].join("\n"),
  );
  declines(
    "declines `.items()` — a 2-tuple is not a single nominal",
    ["def run(d: dict[str, Item]):", "    for pair in d.items():", "        pair.render()", ""].join("\n"),
  );
  declines(
    "declines `.keys()` — the key type is unrecoverable",
    ["def run(d: dict[str, Item]):", "    for k in d.keys():", "        k.render()", ""].join("\n"),
  );
  declines(
    "declines a tuple target",
    ["def run(xs: list[Row]):", "    for a, b in xs:", "        a.render()", ""].join("\n"),
  );
  declines(
    "declines an un-annotated iterable",
    ["def run(xs):", "    for row in xs:", "        row.render()", ""].join("\n"),
  );
  declines(
    "declines a container whose element is a union",
    ["def run(xs: list[A | B]):", "    for x in xs:", "        x.render()", ""].join("\n"),
  );
  declines(
    "declines a nested container element",
    ["def run(xs: list[list[Row]]):", "    for x in xs:", "        x.render()", ""].join("\n"),
  );
  declines(
    "declines a heterogeneous tuple annotation",
    ["def run(xs: tuple[A, B]):", "    for x in xs:", "        x.render()", ""].join("\n"),
  );
  declines(
    "declines a wrapped container — only a DIRECT subscript states which end is the element",
    ["def run(xs: Optional[list[Row]]):", "    for x in xs:", "        x.render()", ""].join("\n"),
  );
  declines(
    "declines a non-container annotation",
    ["def run(xs: QuerySet[Row]):", "    for x in xs:", "        x.render()", ""].join("\n"),
  );
  declines(
    "declines an annotation that lands BELOW the loop",
    ["def run():", "    for row in xs:", "        row.render()", "    xs: list[Row] = []", ""].join("\n"),
  );
  declines(
    "declines an enumerate() call — only `.values()` is transparent",
    ["def run(xs: list[Row]):", "    for x in enumerate(xs):", "        x.render()", ""].join("\n"),
  );
  declines(
    "skips a module-level for statement",
    ["xs: list[Row] = []", "for row in xs:", "    row.render()", ""].join("\n"),
  );
  declines(
    "skips a module-level comprehension",
    ["xs: list[Row] = []", "ys = [r.render() for r in xs]", ""].join("\n"),
  );
  declines(
    "emits nothing when local type tracking is off",
    ["def render(xs: Sequence[Row]):", "    for row in xs:", "        row.render()", ""].join("\n"),
    false,
  );
});

describe("pythonIterationTypeSource — wired into the facet pass", () => {
  const SOURCE = [
    "class Basket:",
    "    items: list[Item]",
    "",
    "    def total(self):",
    "        for item in self.items:",
    "            item.price()",
    "",
  ].join("\n");

  const CHUNKS = [
    { symbolId: "Basket", startLine: 1, endLine: 6, scope: [] },
    { symbolId: "Basket#total", startLine: 4, endLine: 6, scope: ["Basket"] },
  ];

  function extract(): FileExtraction {
    const parser = new Parser();
    parser.setLanguage(PyLang);
    return new PythonLanguage().walker.walk({
      tree: parser.parse(SOURCE),
      code: SOURCE,
      relPath: "pkg/basket.py",
      language: "python",
      chunks: CHUNKS,
    });
  }

  it("is registered in the inline source list", () => {
    expect(PYTHON_INLINE_TYPE_SOURCES).toContain(pythonIterationTypeSource);
  });

  it("reaches the composed walker's localBindings", () => {
    const chunk = extract().chunks.find((c) => c.symbolId === "Basket#total");
    expect(chunk?.localBindings?.["item"]).toEqual([{ line: 5, type: "Item" }]);
  });
});
