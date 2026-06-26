/**
 * YARD `@return` symbolScope threading (bd 9bliu YARD-scope follow-up).
 *
 * 9bliu wired the precise multi-hop path (`structuredReturnTypesMap()` →
 * `ctx.structuredReturnTypes["<fqClass>#method"]`), but the YARD inline source
 * emitted `@return` facts with an EMPTY `symbolScope`, so the map produced FLAT
 * `"#method"` keys and the engine's `recv.name#member` lookup never hit on a
 * pure-YARD corpus. These cases pin the fix: the YARD source now threads the
 * enclosing class/module scope (mirroring `collectRubyDefinedConstants`'
 * scope-stack walk) so the map emits real `"Class#method"` /
 * `"Outer::Inner#method"` keys. The FLAT `returnTypeByMethod()` fallback (keyed
 * by bare method name) MUST stay unchanged — scope is additive there.
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { RubyTypeFactStore } from "../../../../../../../src/core/domains/language/ruby/walker/type-fact-store.js";
import { rubyYardTypeSource } from "../../../../../../../src/core/domains/language/ruby/walker/type-sources/yard.js";
import {
  extractFromRubyFile,
  type RubyExtractInput,
} from "../../../../../../../src/core/domains/language/ruby/walker/walker.js";

function parse(src: string) {
  const parser = new Parser();
  parser.setLanguage(RbLang as unknown as Parser.Language);
  return parser.parse(src);
}

function makeInput(code: string): RubyExtractInput {
  return { code, relPath: "test.rb", language: "ruby", tree: parse(code), chunks: [] };
}

// 1: class Foo
// 2:   # @return [Bar]
// 3:   def baz; end
// 4: end
// 5: module Acme
// 6:   class Widget
// 7:     # @return [Gadget]
// 8:     def build; end
// 9:   end
// 10: end
const SRC = [
  "class Foo",
  "  # @return [Bar]",
  "  def baz; end",
  "end",
  "module Acme",
  "  class Widget",
  "    # @return [Gadget]",
  "    def build; end",
  "  end",
  "end",
  "",
].join("\n");

describe("rubyYardTypeSource — @return symbolScope (bd 9bliu YARD-scope follow-up)", () => {
  it("threads the enclosing class / module scope into @return facts", () => {
    const facts = rubyYardTypeSource.extract(makeInput(SRC));
    const returns = facts.filter((f) => f.kind === "return");
    const baz = returns.find((f) => f.methodName === "baz");
    const build = returns.find((f) => f.methodName === "build");
    expect(baz?.symbolScope).toEqual(["Foo"]);
    expect(build?.symbolScope).toEqual(["Acme", "Widget"]);
  });

  it("structuredReturnTypesMap yields Class#method / Outer::Inner#method keys (NOT flat #method)", () => {
    const facts = rubyYardTypeSource.extract(makeInput(SRC));
    const map = RubyTypeFactStore.fromFacts(facts).structuredReturnTypesMap();
    expect(map["Foo#baz"]).toEqual({ form: "instance", name: "Bar" });
    expect(map["Acme::Widget#build"]).toEqual({ form: "instance", name: "Gadget" });
    // The flat keys must be GONE — that was the under-population gap.
    expect(map["#baz"]).toBeUndefined();
    expect(map["#build"]).toBeUndefined();
  });

  it("returnTypeByMethod stays flat (bare method name → type) — fallback path unchanged", () => {
    const facts = rubyYardTypeSource.extract(makeInput(SRC));
    expect(RubyTypeFactStore.fromFacts(facts).returnTypeByMethod()).toEqual({ baz: "Bar", build: "Gadget" });
  });

  it("extractFromRubyFile surfaces Class#method structuredReturnTypes keys end-to-end", () => {
    const tree = parse(SRC);
    const r = extractFromRubyFile({ tree, code: SRC, relPath: "app/models.rb", language: "ruby", chunks: [] });
    expect(r.structuredReturnTypes?.["Foo#baz"]).toEqual({ form: "instance", name: "Bar" });
    expect(r.structuredReturnTypes?.["Acme::Widget#build"]).toEqual({ form: "instance", name: "Gadget" });
  });

  it("top-level @return (no enclosing class) keeps an empty scope → flat #method key", () => {
    const code = ["# @return [Bar]", "def baz; end"].join("\n");
    const facts = rubyYardTypeSource.extract(makeInput(code));
    const ret = facts.find((f) => f.kind === "return");
    expect(ret?.symbolScope).toEqual([]);
    expect(RubyTypeFactStore.fromFacts(facts).structuredReturnTypesMap()["#baz"]).toEqual({
      form: "instance",
      name: "Bar",
    });
  });

  it("two same-named methods in different classes both survive with distinct fq keys", () => {
    // Flat symbolScope collapsed `Foo#baz` and `Bar#baz` into one coordinate
    // (dedup by `kind|scope|methodName|name|line`). Distinct scopes keep both.
    const code = [
      "class Foo",
      "  # @return [Alpha]",
      "  def shared; end",
      "end",
      "class Bar",
      "  # @return [Beta]",
      "  def shared; end",
      "end",
    ].join("\n");
    const facts = rubyYardTypeSource.extract(makeInput(code));
    const map = RubyTypeFactStore.fromFacts(facts).structuredReturnTypesMap();
    expect(map["Foo#shared"]).toEqual({ form: "instance", name: "Alpha" });
    expect(map["Bar#shared"]).toEqual({ form: "instance", name: "Beta" });
  });

  it("scope_resolution class header (class A::B) threads scope [A, B] into @return facts", () => {
    // buildDefScopeMap handles `nameNode.type === "scope_resolution"` by calling
    // readScopeResolution() — this branch is the only uncovered path in buildDefScopeMap.
    // `class Acme::Widget` produces a scope_resolution nameNode; tree-sitter yields
    // the full `Acme::Widget` string which is then split on `::` to produce the scope.
    const code = ["class Acme::Widget", "  # @return [Gadget]", "  def build; end", "end"].join("\n");
    const facts = rubyYardTypeSource.extract(makeInput(code));
    const ret = facts.find((f) => f.kind === "return" && f.methodName === "build");
    expect(ret).toBeDefined();
    expect(ret?.symbolScope).toEqual(["Acme", "Widget"]);
  });

  it("scope_resolution class header produces correct structuredReturnTypesMap key", () => {
    const code = ["class Acme::Api::Client", "  # @return [Response]", "  def call; end", "end"].join("\n");
    const facts = rubyYardTypeSource.extract(makeInput(code));
    const map = RubyTypeFactStore.fromFacts(facts).structuredReturnTypesMap();
    expect(map["Acme::Api::Client#call"]).toEqual({ form: "instance", name: "Response" });
  });
});
