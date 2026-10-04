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
function extractionOf(src: string, chunks: WalkInput["chunks"]) {
  return new RubyLanguage().walker.walk({ tree: parse(src), code: src, relPath: "a.rb", language: "ruby", chunks });
}

function declarationsOf(src: string, chunks: WalkInput["chunks"]) {
  return extractionOf(src, chunks).identifierDeclarations;
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
      {
        name: "tax_automation_document",
        kind: "local",
        line: 3,
        ownerSymbolId: "ProcessEvent#call",
        boundCallee: { member: "find_tax_automation_document!" },
      },
      {
        name: "@document",
        kind: "field",
        line: 4,
        ownerSymbolId: "ProcessEvent#call",
        typeName: "TaxAutomationDocument",
        typeSource: "constructor",
        boundCallee: { member: "new", receiver: "TaxAutomationDocument" },
      },
      {
        name: "row",
        kind: "local",
        line: 5,
        ownerSymbolId: "ProcessEvent#call",
        boundCallee: { member: "find", receiver: "TaxAutomationDocument" },
      },
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
        boundCallee: { member: "new", receiver: "Billing::Invoice" },
      },
    ]);
  });

  // bd tea-rags-mcp-4p3sb.16 — the row builder finds the CallRef by (startLine, member, receiver).
  it("binds a local / field to the outermost call, as the CallRef the walker emits on that line", () => {
    const src = [
      "class Svc",
      "  def call(id)",
      "    doc = Doc.where(x: id).first",
      "    user = current_user",
      "    rec = Billing::Invoice.find(id)",
      "    sent = obj.send(:publish)",
      "    same = id",
      "    top = ::Top.build",
      "    @widget = Widget.new",
      "    n = 1 + 2",
      "  end",
      "end",
    ].join("\n");
    const chunks = [
      { symbolId: "Svc", startLine: 1, endLine: 12, scope: [] },
      { symbolId: "Svc#call", startLine: 2, endLine: 11, scope: ["Svc"] },
    ];
    const extraction = extractionOf(src, chunks);
    const bound = Object.fromEntries((extraction.identifierDeclarations ?? []).map((d) => [d.name, d.boundCallee]));
    expect(bound).toEqual({
      id: undefined,
      doc: { member: "first", receiver: "Doc.where(x: id)" },
      user: { member: "current_user" },
      rec: { member: "find", receiver: "Billing::Invoice" },
      sent: { member: "publish", receiver: "obj" },
      same: undefined,
      top: { member: "build", receiver: "Top" },
      "@widget": { member: "new", receiver: "Widget" },
      n: undefined,
    });
    for (const declaration of extraction.identifierDeclarations ?? []) {
      if (declaration.boundCallee === undefined) continue;
      const onLine = extraction.chunks
        .flatMap((chunk) => chunk.calls)
        .filter((call) => call.startLine === declaration.line)
        .map((call) =>
          call.receiver === null ? { member: call.member } : { member: call.member, receiver: call.receiver },
        );
      expect(onLine).toContainEqual(declaration.boundCallee);
    }
  });

  // bd tea-rags-mcp-0qaht — class state and memoization reach the naming lexicon.
  describe("class variables and memoization declare", () => {
    it("a class variable is a field named with its sigil", () => {
      const src = "class Cache\n  @@store = Store.new\nend\n";
      const rows = declarationsOf(src, [{ symbolId: "Cache", startLine: 1, endLine: 3, scope: [] }]) ?? [];
      expect(rows).toContainEqual(expect.objectContaining({ name: "@@store", kind: "field", typeName: "Store" }));
    });

    it("||= declares its left side: ivar, class variable, local", () => {
      const src = [
        "class Report",
        "  def totals",
        "    @totals ||= Totals.new",
        "    @@registry ||= {}",
        "    memo ||= compute",
        "  end",
        "end",
      ].join("\n");
      const rows =
        declarationsOf(src, [
          { symbolId: "Report", startLine: 1, endLine: 7, scope: [] },
          { symbolId: "Report#totals", startLine: 2, endLine: 6, scope: ["Report"] },
        ]) ?? [];
      expect(rows).toContainEqual(expect.objectContaining({ name: "@totals", kind: "field", typeName: "Totals" }));
      expect(rows).toContainEqual(expect.objectContaining({ name: "@@registry", kind: "field" }));
      expect(rows).toContainEqual(expect.objectContaining({ name: "memo", kind: "local" }));
    });

    it("other compound assignments still declare nothing", () => {
      const src = ["def bump", "  count += 1", "  @hits -= 1", "  @ok &&= check", "end"].join("\n");
      const rows = declarationsOf(src, [{ symbolId: "bump", startLine: 1, endLine: 5, scope: [] }]) ?? [];
      const names = rows.map((r) => r.name);
      for (const name of ["count", "@hits", "@ok"]) expect(names).not.toContain(name);
    });
  });
});
