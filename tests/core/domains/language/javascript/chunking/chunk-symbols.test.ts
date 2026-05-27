/**
 * `jsChunkSymbols` — the NEW composition wrapper introduced by the native
 * JavaScript vertical (bd tea-rags-mcp-cen6). It collapses the three branches
 * the chunker engine formerly inlined (`tree-sitter.ts:chunkSingleNode`) into a
 * single provider call. These tests pin the PRECEDENCE the engine relied on so
 * the branch collapse stays behaviour-preserving:
 *
 *   1. The `methods.forEach` HTTP-verb dispatch fan-out WINS outright — when it
 *      matches it is returned alone (the old engine `return`ed before the
 *      assignment branch).
 *   2. Otherwise the assignment / CommonJS shape, FOLLOWED IN ORDER by its
 *      nested `Object.defineProperty(this, …)` getter siblings.
 *   3. No match → `[]`.
 *
 * The per-shape correctness of the three relocated extractors is covered by
 * `symbol-resolver.test.ts`; this file only asserts the wrapper's composition.
 */

import Parser from "tree-sitter";
import JsLang from "tree-sitter-javascript";
import { describe, expect, it } from "vitest";

import { jsChunkSymbols } from "../../../../../../src/core/domains/language/javascript/chunking/chunk-symbols.js";

function parse(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(JsLang as unknown as Parser.Language);
  return parser.parse(src);
}

function topLevel(src: string, type: string): Parser.SyntaxNode {
  const tree = parse(src);
  const node = tree.rootNode.namedChildren.find((c) => c.type === type);
  if (!node) throw new Error(`No ${type} found in:\n${src}`);
  return node;
}

describe("jsChunkSymbols — precedence composition", () => {
  it("dispatch fan-out wins outright and is returned alone (9 HTTP verbs)", () => {
    // Strongest HTTP-verb signal: string-literal compare in the callback body.
    const src = `methods.forEach(function (method) {
      if (method === 'get') {}
      app[method] = function () {};
    });\n`;
    const stmt = topLevel(src, "expression_statement");
    const out = jsChunkSymbols(stmt);
    expect(out).toHaveLength(9);
    expect(out.map((s) => s.symbolId)).toContain("app.get");
    expect(out.map((s) => s.symbolId)).toContain("app.post");
    // dispatch SET WINS — no assignment-shape symbol leaks in.
    expect(out.every((s) => s.symbolId.startsWith("app."))).toBe(true);
  });

  it("assignment shape alone — single symbol, no dispatch, no nested siblings", () => {
    const stmt = topLevel("obj.method = function () {};\n", "expression_statement");
    expect(jsChunkSymbols(stmt)).toEqual([{ symbolId: "obj.method", name: "obj.method" }]);
  });

  it("assignment FOLLOWED IN ORDER by its nested defineProperty(this, …) siblings", () => {
    const src = `app.init = function () {
      Object.defineProperty(this, 'router', { get: function () {} });
    };\n`;
    const stmt = topLevel(src, "expression_statement");
    const out = jsChunkSymbols(stmt);
    // assignment symbol first, then the nested getter sibling (this → app).
    expect(out).toEqual([
      { symbolId: "app.init", name: "app.init" },
      { symbolId: "app.router", name: "app.router" },
    ]);
  });

  it("multiple nested defineProperty installs follow the assignment in source order", () => {
    const src = `app.init = function () {
      Object.defineProperty(this, 'a', { get: function () {} });
      Object.defineProperty(this, 'b', { get: function () {} });
    };\n`;
    const stmt = topLevel(src, "expression_statement");
    expect(jsChunkSymbols(stmt).map((s) => s.symbolId)).toEqual(["app.init", "app.a", "app.b"]);
  });

  it("const Foo = fn (lexical_declaration) → single symbol", () => {
    const lex = topLevel("const Foo = function () {};\n", "lexical_declaration");
    expect(jsChunkSymbols(lex)).toEqual([{ symbolId: "Foo", name: "Foo" }]);
  });

  it("no recognised shape → empty array (engine falls through to default extraction)", () => {
    const stmt = topLevel("doSomething();\n", "expression_statement");
    expect(jsChunkSymbols(stmt)).toEqual([]);
  });
});
