/**
 * Ruby walker `assignedLocals` producer (bd tea-rags-mcp-m99j1.1.59).
 *
 * Every method chunk carries the names its def ASSIGNS — typed or not — so the
 * dynamic fan can tell an untyped local from a self-method head. Parameters,
 * block parameters and a nested def's locals are not the method's assigned
 * locals; block bodies are, because a Ruby block shares the method's scope.
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
  "  def m(p, opts = {})", // 2
  "    x = foo", // 3
  "    x.bar", // 4
  "    y ||= build", // 5
  "    a, b = pair", // 6
  "    n += 1", // 7
  "    items.each do |it|", // 8
  "      z = it.value", // 9
  "    end", // 10
  "    begin", // 11
  "      risky", // 12
  "    rescue StandardError => e", // 13
  "      e.message", // 14
  "    end", // 15
  "    opts = opts.merge(k: 1)", // 16
  "    def inner", // 17
  "      q = 1", // 18
  "    end", // 19
  "  end", // 20
  "end", // 21
  "",
].join("\n");

describe("ruby walker assignedLocals (m99j1.1.59)", () => {
  const ex = extract(SRC, [
    { symbolId: "A", startLine: 1, endLine: 21, scope: [] },
    { symbolId: "A#m", startLine: 2, endLine: 20, scope: ["A"] },
    { symbolId: "A#inner", startLine: 17, endLine: 19, scope: ["A"] },
  ]);
  const chunk = (id: string) => ex.chunks.find((c) => c.symbolId === id);

  it("collects assignment, ||=, op-assign, multiple-assignment, block-body and rescue names", () => {
    expect(chunk("A#m")?.assignedLocals).toEqual(["a", "b", "e", "n", "x", "y", "z"]);
  });

  it("excludes method params (even reassigned), block params and a nested def's locals", () => {
    const names = chunk("A#m")?.assignedLocals ?? [];
    expect(names).not.toContain("p");
    expect(names).not.toContain("opts");
    expect(names).not.toContain("it");
    expect(names).not.toContain("q");
  });

  it("gives a nested def its own locals and a non-method chunk none", () => {
    expect(chunk("A#inner")?.assignedLocals).toEqual(["q"]);
    expect(chunk("A")?.assignedLocals).toBeUndefined();
  });

  it("gives a window inside a method (a split part) the method's locals", () => {
    const parts = extract(SRC, [{ symbolId: "A#m", startLine: 8, endLine: 15, scope: ["A"] }]);
    expect(parts.chunks[0]?.assignedLocals).toEqual(["a", "b", "e", "n", "x", "y", "z"]);
  });

  it("drops a name whose receiver use precedes its first assignment (a self-method call there)", () => {
    const src = ["class B", "  def m", "    w.call", "    w = 1", "    v = 2", "    v.go", "  end", "end", ""].join(
      "\n",
    );
    const out = extract(src, [{ symbolId: "B#m", startLine: 2, endLine: 7, scope: ["B"] }]);
    expect(out.chunks[0]?.assignedLocals).toEqual(["v"]);
  });

  it("omits the field on a def that assigns nothing", () => {
    const src = ["class C", "  def m(a)", "    a.go", "  end", "end", ""].join("\n");
    const out = extract(src, [{ symbolId: "C#m", startLine: 2, endLine: 4, scope: ["C"] }]);
    expect(out.chunks[0]?.assignedLocals).toBeUndefined();
  });
});
