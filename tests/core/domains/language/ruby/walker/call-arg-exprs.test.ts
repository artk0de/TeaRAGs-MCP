/**
 * bd tea-rags-mcp-2m83f.44 — walker half of parameter typing from callers:
 * `CallRef.argExprs` carries the receiver-shaped argument texts pass 2 types.
 */

import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import type { CallRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import { extractFromRubyFile } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";

function callTo(line: string, member: string): CallRef | undefined {
  const src = ["class A", "  def go(record, args)", `    ${line}`, "  end", "end", ""].join("\n");
  const parser = new Parser();
  parser.setLanguage(RbLang);
  const ex = extractFromRubyFile({
    tree: parser.parse(src),
    code: src,
    relPath: "a.rb",
    language: "ruby",
    chunks: [{ symbolId: "A#go", startLine: 2, endLine: 4, scope: ["A"] }],
  });
  return ex.chunks.find((c) => c.symbolId === "A#go")?.calls.find((c) => c.member === member);
}

describe("ruby walker — call argument expressions (2m83f.44)", () => {
  it("records identifiers, ivars and call chains by position, nil as null", () => {
    expect(callTo("W.new.perform(record, nil, @firm, Invoice.find(1))", "perform")?.argExprs).toEqual({
      positional: ["record", null, "@firm", "Invoice.find(1)"],
    });
  });

  // bd tea-rags-mcp-2m83f.49 — constants and literals are typed evidence too.
  it("records a constant argument by its path text", () => {
    expect(callTo("W.new.perform(Firm, Billing::Invoice, ::Root)", "perform")?.argExprs).toEqual({
      positional: ["Firm", "Billing::Invoice", "::Root"],
    });
  });

  it("records a literal as the canonical literal of its core class", () => {
    expect(callTo("W.new.perform(42, 1.5, 'x', \"y#{record}\", :s, [1, 2], { a: 1 })", "perform")?.argExprs).toEqual({
      positional: ["0", "0.0", '""', '""', ":_", "[]", "{}"],
    });
  });

  it("records a literal keyword value", () => {
    expect(callTo("W.new.perform(n: 1)", "perform")?.argExprs).toEqual({ keyword: { n: "0" } });
  });

  it("records keyword values under their key", () => {
    expect(callTo("W.new.perform(record: record, n: nil)", "perform")?.argExprs).toEqual({
      keyword: { record: "record" },
    });
  });

  it("stops positions at a splat", () => {
    expect(callTo("W.new.perform(*args, record)", "perform")?.argExprs).toBeUndefined();
  });

  it("is absent when nothing is typeable", () => {
    expect(callTo("W.new.perform(nil, true)", "perform")?.argExprs).toBeUndefined();
  });
});
