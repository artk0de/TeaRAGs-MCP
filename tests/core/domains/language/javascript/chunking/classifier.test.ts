import Parser from "tree-sitter";
import JsLang from "tree-sitter-javascript";
import { describe, it, expect, beforeAll } from "vitest";

import { JsChunkClassifier } from "../../../../../../src/core/domains/language/javascript/chunking/classifier.js";

let parser: Parser;
const classifier = new JsChunkClassifier();
beforeAll(() => {
  parser = new Parser();
  parser.setLanguage(JsLang as Parser.Language);
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

describe("JsChunkClassifier.classifyNode", () => {
  it("emits function-typed chunks for a CommonJS assignment", () => {
    const node = firstOfType("exports.foo = function () {};", "expression_statement");
    const decision = classifier.classifyNode(node);
    expect(decision.kind).toBe("emit");
    if (decision.kind === "emit") {
      expect(decision.chunks.length).toBeGreaterThan(0);
      expect(decision.chunks.every((c) => c.chunkType === "function")).toBe(true);
      expect(decision.chunks[0].symbolId).toBe(decision.chunks[0].name);
    }
  });

  it("passes through a node jsChunkSymbols does not claim", () => {
    const node = firstOfType("const x = 1;", "lexical_declaration");
    expect(classifier.classifyNode(node)).toEqual({ kind: "passthrough" });
  });
});
