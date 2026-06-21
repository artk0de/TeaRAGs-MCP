/**
 * Unit tests for the relocated `collectSymbols` kernel helper (yl9tv).
 *
 * `collectSymbols` was the codegraph provider's private symbol-range walker;
 * it moved to `domains/language/kernel` so the chunker worker can produce a
 * complete `FileExtraction` from the SAME parse it chunks with. The assertion
 * shape mirrors the provider symbol tests: a real tree-sitter parse + the
 * language's `nameOf`, asserting the composed fully-qualified ids + scope.
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { collectSymbols } from "../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../src/core/domains/language/kernel/symbol-id.js";
import { rbNameOf } from "../../../../../src/core/domains/language/ruby/walker/name-of.js";

function parse(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(RbLang as unknown as Parser.Language);
  return parser.parse(src);
}

describe("collectSymbols (kernel, yl9tv)", () => {
  const composer = new DefaultSymbolIdComposer();

  it("composes a nested module → class → instance method to M::C#m with the right scope", () => {
    const tree = parse(["module M", "  class C", "    def m", "    end", "  end", "end", ""].join("\n"));
    const rows = collectSymbols(tree, rbNameOf, "::", false, composer);
    const ids = rows.map((r) => r.symbolId);

    expect(ids).toContain("M");
    expect(ids).toContain("M::C");
    expect(ids).toContain("M::C#m");

    const method = rows.find((r) => r.symbolId === "M::C#m");
    expect(method).toBeDefined();
    expect(method?.scope).toEqual(["M", "C"]);
    // 1-indexed line span: `def m` is on the 3rd source line.
    expect(method?.startLine).toBe(3);
  });

  it("dedups by symbolId (keeps first occurrence) when disambiguateOverloads is false", () => {
    // Two same-named top-level methods collide; the default path keeps one.
    const tree = parse(["def dup", "end", "def dup", "end", ""].join("\n"));
    const rows = collectSymbols(tree, rbNameOf, "::", false, composer);
    expect(rows.filter((r) => r.symbolId === "dup")).toHaveLength(1);
  });
});
