/**
 * bd tea-rags-mcp-q1g6s.10 — `method(:x)` names a method of its receiver; the
 * walker emits the reference to `x` (receiver kept, `self` normalised to bare)
 * and drops the `Kernel#method` call itself, which resolved to an unrelated
 * project `#method` (an `attr_reader :method` on an error class).
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { extractFromRubyFile } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";

function callsOf(body: string) {
  const src = `def f\n  ${body}\nend\n`;
  const parser = new Parser();
  parser.setLanguage(RbLang);
  const r = extractFromRubyFile({
    tree: parser.parse(src),
    code: src,
    relPath: "x.rb",
    language: "ruby",
    chunks: [{ symbolId: "f", scope: ["f"], startLine: 1, endLine: 3 }],
  });
  return r.chunks[0].calls;
}

describe("method-reference unwrap (q1g6s.10)", () => {
  it("unwraps bare `method(:vendor_error_class)` to a bare call of the named method", () => {
    const calls = callsOf("handler = method(:vendor_error_class)");
    expect(calls.find((c) => c.member === "vendor_error_class")?.receiver).toBeNull();
    expect(calls.find((c) => c.member === "method")).toBeUndefined();
  });

  it("unwraps `self.method(:x)` to bare and keeps an explicit receiver", () => {
    expect(callsOf("self.method(:x)").find((c) => c.member === "x")?.receiver).toBeNull();
    expect(callsOf("client.public_method('fetch')").find((c) => c.member === "fetch")?.receiver).toBe("client");
  });

  it("keeps a non-literal `method(name)` as the plain call it is", () => {
    const calls = callsOf("method(name)");
    expect(calls.find((c) => c.member === "method")).toBeDefined();
    expect(calls.find((c) => c.member === "method")?.dynamicSend).toBeUndefined();
  });
});
