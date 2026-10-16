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
  it("records identifiers, ivars and call chains by position, a literal as null", () => {
    expect(callTo("W.new.perform(record, 42, @firm, Invoice.find(1))", "perform")?.argExprs).toEqual({
      positional: ["record", null, "@firm", "Invoice.find(1)"],
    });
  });

  it("records keyword values under their key", () => {
    expect(callTo("W.new.perform(record: record, n: 1)", "perform")?.argExprs).toEqual({
      keyword: { record: "record" },
    });
  });

  it("stops positions at a splat", () => {
    expect(callTo("W.new.perform(*args, record)", "perform")?.argExprs).toBeUndefined();
  });

  it("is absent when nothing is typeable", () => {
    expect(callTo("W.new.perform(1, 'x')", "perform")?.argExprs).toBeUndefined();
  });
});
