import Parser from "tree-sitter";
import GoLang from "tree-sitter-go";
import { describe, it, expect, beforeAll } from "vitest";

import { GoChunkClassifier } from "../../../../../../src/core/domains/language/go/chunking/classifier.js";

let parser: Parser;
const classifier = new GoChunkClassifier();
beforeAll(() => {
  parser = new Parser();
  parser.setLanguage(GoLang as Parser.Language);
});

function firstOfType(code: string, type: string): Parser.SyntaxNode {
  const root = parser.parse(code).rootNode;
  const found = (function walk(n: Parser.SyntaxNode): Parser.SyntaxNode | null {
    if (n.type === type) return n;
    for (const c of n.children) {
      const r = walk(c);
      if (r) return r;
    }
    return null;
  })(root);
  if (!found) throw new Error(`no ${type}`);
  return found;
}

describe("GoChunkClassifier.classifyNode", () => {
  it("emits class chunkType for a struct type_declaration", () => {
    const node = firstOfType("type Engine struct { n int }", "type_declaration");
    expect(classifier.classifyNode(node)).toEqual({
      kind: "emit",
      chunks: [{ name: "Engine", symbolId: "Engine", chunkType: "class" }],
    });
  });
  it("emits interface chunkType for an interface type_declaration", () => {
    const node = firstOfType("type Handler interface { Serve() }", "type_declaration");
    expect(classifier.classifyNode(node)).toEqual({
      kind: "emit",
      chunks: [{ name: "Handler", symbolId: "Handler", chunkType: "interface" }],
    });
  });
  it("emits block chunkType for a func-type alias", () => {
    const node = firstOfType("type HandlerFunc func(*Context)", "type_declaration");
    expect(classifier.classifyNode(node)).toEqual({
      kind: "emit",
      chunks: [{ name: "HandlerFunc", symbolId: "HandlerFunc", chunkType: "block" }],
    });
  });
  it("emits function chunkType + Receiver#Method for a method", () => {
    const node = firstOfType("func (c *Context) Query() string { return \"\" }", "method_declaration");
    expect(classifier.classifyNode(node)).toEqual({
      kind: "emit",
      chunks: [{ name: "Context#Query", symbolId: "Context#Query", chunkType: "function" }],
    });
  });
  it("passes through a top-level function_declaration (preserves the floor)", () => {
    const node = firstOfType("func f() {}", "function_declaration");
    expect(classifier.classifyNode(node)).toEqual({ kind: "passthrough" });
  });
});
