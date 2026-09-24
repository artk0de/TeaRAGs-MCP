import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import type { WalkInput } from "../../../../../../src/core/contracts/types/language.js";
import { RubyLanguage } from "../../../../../../src/core/domains/language/ruby/index.js";

function parse(src: string) {
  const p = new Parser();
  p.setLanguage(RbLang);
  return p.parse(src);
}

/** Through the COMPOSED walker, so the pass is exercised where production runs it. */
function declarationsOf(src: string, chunks: WalkInput["chunks"]) {
  return new RubyLanguage().walker.walk({ tree: parse(src), code: src, relPath: "a.rb", language: "ruby", chunks })
    .identifierDeclarations;
}

// bd tea-rags-mcp-4p3sb.3 — the naming lexicon's syntactic half for Ruby.
describe("Ruby walker — identifier declarations", () => {
  it("records params, locals and ivar fields; only `X.new` types by constructor", () => {
    const src = [
      "class ProcessEvent",
      "  def call(id, ignored:)",
      "    tax_automation_document = find_tax_automation_document!(id)",
      "    @document = TaxAutomationDocument.new",
      "    row = TaxAutomationDocument.find(id)",
      "  end",
      "end",
    ].join("\n");
    const chunks = [
      { symbolId: "ProcessEvent", startLine: 1, endLine: 7, scope: [] },
      { symbolId: "ProcessEvent#call", startLine: 2, endLine: 6, scope: ["ProcessEvent"] },
    ];
    expect(declarationsOf(src, chunks)).toEqual([
      { name: "id", kind: "param", line: 2, ownerSymbolId: "ProcessEvent#call" },
      { name: "ignored", kind: "param", line: 2, ownerSymbolId: "ProcessEvent#call" },
      { name: "tax_automation_document", kind: "local", line: 3, ownerSymbolId: "ProcessEvent#call" },
      {
        name: "@document",
        kind: "field",
        line: 4,
        ownerSymbolId: "ProcessEvent#call",
        typeName: "TaxAutomationDocument",
        typeSource: "constructor",
      },
      { name: "row", kind: "local", line: 5, ownerSymbolId: "ProcessEvent#call" },
    ]);
  });

  it("covers every parameter form, lambda params, scoped constructors; skips compound assignment", () => {
    const src = [
      "def m(p = 1, *args, k: 2, **opts, &blk)",
      "  fn = ->(a) { a }",
      "  svc = Billing::Invoice.new",
      "  svc += 1",
      "  x, y = 1, 2",
      "end",
    ].join("\n");
    const chunks = [{ symbolId: "m", startLine: 1, endLine: 6, scope: [] }];
    expect(declarationsOf(src, chunks)).toEqual([
      { name: "p", kind: "param", line: 1, ownerSymbolId: "m" },
      { name: "args", kind: "param", line: 1, ownerSymbolId: "m" },
      { name: "k", kind: "param", line: 1, ownerSymbolId: "m" },
      { name: "opts", kind: "param", line: 1, ownerSymbolId: "m" },
      { name: "blk", kind: "param", line: 1, ownerSymbolId: "m" },
      { name: "fn", kind: "local", line: 2, ownerSymbolId: "m" },
      { name: "a", kind: "param", line: 2, ownerSymbolId: "m" },
      {
        name: "svc",
        kind: "local",
        line: 3,
        ownerSymbolId: "m",
        typeName: "Billing::Invoice",
        typeSource: "constructor",
      },
    ]);
  });
});
