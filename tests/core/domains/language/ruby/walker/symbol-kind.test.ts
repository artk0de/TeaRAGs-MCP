/**
 * The Ruby walker tags every chunk it emits with the KIND of declaration that
 * produced it (bd tea-rags-mcp-vi0wx, plan Task 2): `class A` → class,
 * `module M` → module, `def f` / `def self.f` / a DSL-generated accessor →
 * method, `MAX = 3` → constant.
 *
 * The chunk ranges come from the REAL symbol collection (`collectSymbols` over
 * `rbNameOf`), so the test sees exactly the chunks the pipeline hands the walker.
 * Ruby's `nameOf` declares no constants, so a constant is tagged only when a
 * caller supplies a chunk for it — the walker adds no new symbol.
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { rbNameOf } from "../../../../../../src/core/domains/language/ruby/walker/name-of.js";
import { symbolKindOf } from "../../../../../../src/core/domains/language/ruby/walker/symbol-kind.js";
import { extractFromRubyFile } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";

function parse(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(RbLang);
  return parser.parse(src);
}

const composer = new DefaultSymbolIdComposer();

/** Walk `src` with the chunks the real symbol collection yields; symbolId → symbolKind. */
function kindsOf(src: string): Record<string, string | undefined> {
  const tree = parse(src);
  const chunks = collectSymbols(tree, (n) => rbNameOf(n), "::", false, composer);
  const ex = extractFromRubyFile({ tree, code: src, relPath: "app/models/m.rb", language: "ruby", chunks });
  return Object.fromEntries(ex.chunks.map((c) => [c.symbolId, c.symbolKind]));
}

describe("symbolKindOf — Ruby declaration node → SymbolDefinitionKind", () => {
  const plain = { declaresMethod: false, assignsConstant: false };

  it("maps the structural declarations", () => {
    expect(symbolKindOf("class", plain)).toBe("class");
    expect(symbolKindOf("module", plain)).toBe("module");
    expect(symbolKindOf("method", plain)).toBe("method");
    expect(symbolKindOf("singleton_method", plain)).toBe("method");
  });

  it("maps a DSL / alias node that declares a method to method", () => {
    expect(symbolKindOf("call", { declaresMethod: true, assignsConstant: false })).toBe("method");
    expect(symbolKindOf("identifier", { declaresMethod: true, assignsConstant: false })).toBe("method");
    expect(symbolKindOf("alias", { declaresMethod: true, assignsConstant: false })).toBe("method");
  });

  it("maps an assignment to a constant only when its target is a constant", () => {
    expect(symbolKindOf("assignment", { declaresMethod: false, assignsConstant: true })).toBe("constant");
    expect(symbolKindOf("assignment", plain)).toBeUndefined();
  });

  it("leaves a node that declares nothing untagged", () => {
    expect(symbolKindOf("call", plain)).toBeUndefined();
    expect(symbolKindOf("identifier", plain)).toBeUndefined();
  });
});

describe("extractFromRubyFile — symbolKind on each emitted chunk", () => {
  const SRC = [
    "module M", //                 1
    "  class A", //                2
    "    MAX = 3", //              3
    "    attr_reader :name", //    4
    "    def f", //                5
    "      g", //                  6
    "    end", //                  7
    "    def self.build", //       8
    "    end", //                  9
    "  end", //                    10
    "end", //                      11
    "def top", //                  12
    "end", //                      13
    "",
  ].join("\n");

  it("tags module, class, instance/singleton/DSL/top-level methods", () => {
    expect(kindsOf(SRC)).toEqual({
      M: "module",
      "M::A": "class",
      "M::A#name": "method",
      "M::A#f": "method",
      "M::A.build": "method",
      top: "method",
    });
  });

  it("tells a one-line class from the def it contains (same line range)", () => {
    expect(kindsOf("class B; def c; end; end\n")).toEqual({ B: "class", "B#c": "method" });
  });

  it("tags a class declared with a scoped name", () => {
    expect(kindsOf("class Acme::Auth\n  def login; end\nend\n")).toEqual({
      "Acme::Auth": "class",
      "Acme::Auth#login": "method",
    });
  });

  it("tags a caller-supplied constant chunk as constant (nameOf declares none)", () => {
    const src = "class A\n  MAX = 3\nend\n";
    const tree = parse(src);
    const ex = extractFromRubyFile({
      tree,
      code: src,
      relPath: "a.rb",
      language: "ruby",
      chunks: [
        { symbolId: "A", scope: [], startLine: 1, endLine: 3 },
        { symbolId: "A::MAX", scope: ["A"], startLine: 2, endLine: 2 },
      ],
    });
    expect(ex.chunks.map((c) => [c.symbolId, c.symbolKind])).toEqual([
      ["A", "class"],
      ["A::MAX", "constant"],
    ]);
  });

  it("leaves a chunk that matches no declaration untagged", () => {
    const src = "x = 1\ny = 2\n";
    const tree = parse(src);
    const ex = extractFromRubyFile({
      tree,
      code: src,
      relPath: "a.rb",
      language: "ruby",
      chunks: [{ symbolId: "Ghost", scope: [], startLine: 1, endLine: 2 }],
    });
    expect(ex.chunks[0]).not.toHaveProperty("symbolKind");
  });
});
