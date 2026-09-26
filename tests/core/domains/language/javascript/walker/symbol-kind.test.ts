/**
 * JavaScript symbol kind (bd tea-rags-mcp-vi0wx) — the declaration kind each
 * chunk the composed walker emits carries on `ChunkExtraction.symbolKind`,
 * including the CommonJS shapes `jsNameOf` adds on top of `tsNameOf`. A
 * plain-valued top-level `const` is not a symbol today, so no chunk exists to
 * tag.
 */
import Parser from "tree-sitter";
import JsLang from "tree-sitter-javascript";
import { describe, expect, it } from "vitest";

import { JavaScriptLanguage } from "../../../../../../src/core/domains/language/javascript/index.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { materializeTree } from "../../../../../../src/core/infra/materialize.js";

function symbolKinds(src: string): Record<string, string | undefined> {
  const language = new JavaScriptLanguage();
  const parser = new Parser();
  parser.setLanguage(JsLang);
  const tree = { rootNode: materializeTree(parser.parse(src).rootNode, src) };
  const chunks = collectSymbols(
    tree,
    (node) => language.walker.nameOf(node),
    language.kernel.scopeSeparator ?? ".",
    language.kernel.disambiguateOverloads ?? false,
    new DefaultSymbolIdComposer(),
  );
  const extraction = language.walker.walk({ tree, code: src, relPath: "a.js", language: "javascript", chunks });
  const out: Record<string, string | undefined> = {};
  for (const chunk of extraction.chunks) out[chunk.symbolId] = chunk.symbolKind;
  return out;
}

describe("JavaScript walker — symbol kind", () => {
  it("tags a class, its methods, a function and a function-valued const", () => {
    const src = ["class A {", "  run() {}", "}", "function f() {}", "const g = () => {};", ""].join("\n");
    expect(symbolKinds(src)).toEqual({
      A: "class",
      "A#run": "method",
      "A#constructor": "method",
      f: "function",
      g: "function",
    });
  });

  it("tags CommonJS member assignments as methods and export assignments as functions", () => {
    const src = [
      "function Foo() {}",
      "Foo.prototype.bar = function () {};",
      "exports.helper = function () {};",
      "app.handle = function () {};",
      "",
    ].join("\n");
    expect(symbolKinds(src)).toMatchObject({
      Foo: "function",
      "Foo#bar": "method",
      helper: "function",
      "app.handle": "method",
    });
  });

  it("emits no chunk for a plain top-level const — not a symbol yet", () => {
    expect(symbolKinds("const MAX = 3;\n")).toEqual({});
  });
});
