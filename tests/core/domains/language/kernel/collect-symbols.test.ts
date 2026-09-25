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
  parser.setLanguage(RbLang);
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

  it("stamps a `bodyScope` on a declaration whose nameOf says its body runs with it as `self`", () => {
    // bd tea-rags-mcp-3ievc class B — a TYPE chunk's own calls (a stored
    // property initializer, a computed property) execute inside the type, yet
    // its `scope` is honestly the PARENT's. The flag is opt-in per nameOf, so a
    // language that does not set it keeps its ranges byte-identical.
    const tree = parse(["module M", "  class C", "    def m", "    end", "  end", "end", ""].join("\n"));
    const optIn = (node: Parameters<typeof rbNameOf>[0]) => {
      const named = rbNameOf(node);
      if (named === null || Array.isArray(named) || node.type !== "class") return named;
      return { ...named, opensSelfScope: true };
    };
    const rows = collectSymbols(tree, optIn, "::", false, composer);

    const cls = rows.find((r) => r.symbolId === "M::C");
    expect(cls?.scope).toEqual(["M"]);
    expect(cls?.bodyScope).toEqual(["M", "C"]);
    // A declaration that did not opt in carries no key at all.
    expect(rows.find((r) => r.symbolId === "M")).not.toHaveProperty("bodyScope");
    expect(rows.find((r) => r.symbolId === "M::C#m")).not.toHaveProperty("bodyScope");
  });

  it("stamps no `bodyScope` anywhere when no nameOf result opts in", () => {
    const tree = parse(["module M", "  class C", "    def m", "    end", "  end", "end", ""].join("\n"));
    for (const row of collectSymbols(tree, rbNameOf, "::", false, composer)) {
      expect(row).not.toHaveProperty("bodyScope");
    }
  });

  it("dedups by symbolId (keeps first occurrence) when disambiguateOverloads is false", () => {
    // Two same-named top-level methods collide; the default path keeps one.
    const tree = parse(["def dup", "end", "def dup", "end", ""].join("\n"));
    const rows = collectSymbols(tree, rbNameOf, "::", false, composer);
    expect(rows.filter((r) => r.symbolId === "dup")).toHaveLength(1);
  });
});
