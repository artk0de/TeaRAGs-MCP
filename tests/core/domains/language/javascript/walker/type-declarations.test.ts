/**
 * JavaScript type and constant declarations (bd tea-rags-mcp-vi0wx, spec §1b) —
 * the TypeScript facet driven by `jsNameOf`. JavaScript's row is a subset:
 * classes (declarations and const-bound class expressions) and module-level
 * `const`s that are not function-valued. A const-bound function, including the
 * CommonJS shapes `jsNameOf` names, is a function symbol already.
 */
import Parser from "tree-sitter";
import JsLang from "tree-sitter-javascript";
import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { JavaScriptLanguage } from "../../../../../../src/core/domains/language/javascript/index.js";
import { extractFromJavascriptFile } from "../../../../../../src/core/domains/language/javascript/walker/walker.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { materializeTree } from "../../../../../../src/core/infra/materialize.js";

function extract(src: string): { composed: FileExtraction; native: FileExtraction } {
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
  const input = { tree, code: src, relPath: "a.js", language: "javascript", chunks };
  return { composed: language.walker.walk(input), native: extractFromJavascriptFile(input) };
}

function typeDeclarationsOf(src: string): FileExtraction["typeDeclarations"] {
  return extract(src).composed.typeDeclarations;
}

describe("JavaScript walker — type declarations", () => {
  it("emits classes with their superclass and module-level non-function consts", () => {
    const src = [
      "class Svc extends ns.Base {}",
      "export class Plain {}",
      "export const Recorder = class extends Svc {};",
      "const LIMIT = 10;",
      "export const DEFAULTS = { timeout: 1 };",
      "const Grouper = { group() {} };",
      "let mutable = 1;",
      "var legacy = 2;",
      'const { helper } = require("./helper");',
      "",
    ].join("\n");

    expect(typeDeclarationsOf(src)).toEqual([
      { typeId: "Svc", symbolKind: "class", line: 1, reopens: false, conforms: ["ns.Base"] },
      { typeId: "Plain", symbolKind: "class", line: 2, reopens: false },
      { typeId: "Recorder", symbolKind: "class", line: 3, reopens: false, conforms: ["Svc"] },
      { typeId: "LIMIT", symbolKind: "constant", line: 4, reopens: false },
      { typeId: "DEFAULTS", symbolKind: "constant", line: 5, reopens: false },
      { typeId: "Grouper", symbolKind: "module", line: 6, reopens: false },
    ]);
  });

  it("does not emit a function-valued const nor locals inside a function or class", () => {
    const src = [
      "const handler = () => 1;",
      "const legacy = function () {};",
      "function run() {",
      "  const LOCAL = 1;",
      "  class Inner {}",
      "}",
      "module.exports = { handler };",
      "",
    ].join("\n");

    expect(typeDeclarationsOf(src)).toBeUndefined();
  });

  it("leaves chunks, symbols and calls byte-identical: the composed walk differs from the native one only by facets", () => {
    const src = [
      'const { helper } = require("./helper");',
      "const LIMIT = 3;",
      "class Svc {",
      "  run() { return helper(LIMIT); }",
      "}",
      "module.exports = { Svc };",
      "",
    ].join("\n");
    const { composed, native } = extract(src);

    expect(composed.typeDeclarations).toHaveLength(2);
    expect(native.typeDeclarations).toBeUndefined();
    expect(composed.imports).toEqual(native.imports);
    expect(composed.chunks.map((c) => [c.symbolId, c.scope, c.startLine, c.endLine, c.calls])).toEqual(
      native.chunks.map((c) => [c.symbolId, c.scope, c.startLine, c.endLine, c.calls]),
    );
  });
});
