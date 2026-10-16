/**
 * Ruby walker `localAssignmentLines` producer (bd tea-rags-mcp-2m83f.43).
 *
 * Residual receiver narrowing groups the calls on one receiver within a method;
 * a local or ivar reassigned between two calls is two receivers, so every def
 * chunk carries the lines its locals and ivars are assigned on.
 */

import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { extractFromRubyFile } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";

function extract(src: string, chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[]) {
  const parser = new Parser();
  parser.setLanguage(RbLang);
  const tree = parser.parse(src);
  return extractFromRubyFile({ tree, code: src, relPath: "a.rb", language: "ruby", chunks });
}

const SRC = [
  "class A", // 1
  "  def m(p)", // 2
  "    r = find", // 3
  "    r.firm_id", // 4
  "    r = other", // 5
  "    @inv ||= load", // 6
  "    a, b = pair", // 7
  "    p = p.next", // 8
  "    def inner", // 9
  "      r = 1", // 10
  "    end", // 11
  "  end", // 12
  "end", // 13
  "",
].join("\n");

describe("ruby walker localAssignmentLines (2m83f.43)", () => {
  const ex = extract(SRC, [
    { symbolId: "A", startLine: 1, endLine: 13, scope: [] },
    { symbolId: "A#m", startLine: 2, endLine: 12, scope: ["A"] },
    { symbolId: "A#inner", startLine: 9, endLine: 11, scope: ["A"] },
  ]);
  const chunk = (id: string) => ex.chunks.find((c) => c.symbolId === id);

  it("records every assignment line of locals, ivars and params, outside nested defs", () => {
    expect(chunk("A#m")?.localAssignmentLines).toEqual({
      r: [3, 5],
      "@inv": [6],
      a: [7],
      b: [7],
      p: [8],
    });
  });

  it("gives a nested def its own lines and a non-method chunk none", () => {
    expect(chunk("A#inner")?.localAssignmentLines).toEqual({ r: [10] });
    expect(chunk("A")?.localAssignmentLines).toBeUndefined();
  });
});
