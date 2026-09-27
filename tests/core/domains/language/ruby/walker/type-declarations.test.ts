/**
 * The Ruby walker publishes one `TypeDeclarationFact` per class, module and
 * constant assignment it sees (bd tea-rags-mcp-vi0wx, spec §1b, W3c) — naming
 * data for the type-role lexicon, never read by the Ruby resolver.
 *
 * `typeId` is Ruby's `::` composition with nesting (`Acme::Auth::MAX`), the
 * same lexical FQ `fileScope` and `classAncestors` key on. A class's
 * `conforms` is its superclass followed by the modules it `include`s /
 * `prepend`s, in source order; `extend Mod` mixes into the singleton class and
 * is not an ancestor of the type's instances, so it stays out. Constants count
 * at file, class and module level — a constant written inside a method body or
 * a `class << self` is not the type's.
 */
import { readFileSync } from "node:fs";

import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { rbNameOf } from "../../../../../../src/core/domains/language/ruby/walker/name-of.js";
import { extractFromRubyFile } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";
import { BASELINE_RUBY_SOURCE } from "./fixtures/type-declarations-baseline-source.js";

function parse(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(RbLang);
  return parser.parse(src);
}

const composer = new DefaultSymbolIdComposer();

/** The walker's extraction of `src`, with the chunks the real symbol collection yields. */
function extract(src: string, relPath = "app/models/m.rb"): FileExtraction {
  const tree = parse(src);
  const chunks = collectSymbols(tree, (n) => rbNameOf(n), "::", false, composer);
  return extractFromRubyFile({ tree, code: src, relPath, language: "ruby", chunks });
}

const declarationsOf = (src: string): FileExtraction["typeDeclarations"] => extract(src).typeDeclarations;

describe("extractFromRubyFile — typeDeclarations (W3c)", () => {
  it("emits a class with its superclass and included / prepended modules, extend excluded", () => {
    const src = [
      "class Login < Base", //  1
      "  include Trackable", // 2
      "  extend Finders", //    3
      "  prepend Instrumented", // 4
      "end", //                 5
      "",
    ].join("\n");
    expect(declarationsOf(src)).toEqual([
      {
        typeId: "Login",
        symbolKind: "class",
        line: 1,
        reopens: false,
        conforms: ["Base", "Trackable", "Instrumented"],
      },
    ]);
  });

  it("keeps a qualified superclass and a mixin from an `included do … end` block", () => {
    const src = [
      "module Trackable",
      "  extend ActiveSupport::Concern",
      "  included do",
      "    include Acme::Audit",
      "  end",
      "end",
      "class Session < Acme::Record",
      "end",
      "",
    ].join("\n");
    expect(declarationsOf(src)).toEqual([
      { typeId: "Trackable", symbolKind: "module", line: 1, reopens: false, conforms: ["Acme::Audit"] },
      { typeId: "Session", symbolKind: "class", line: 7, reopens: false, conforms: ["Acme::Record"] },
    ]);
  });

  it("omits conforms on a declaration naming no ancestor", () => {
    expect(declarationsOf("module Util\nend\n")).toEqual([
      { typeId: "Util", symbolKind: "module", line: 1, reopens: false },
    ]);
  });

  it("composes nested and compact declarations and their constants with `::`", () => {
    const src = [
      "module Acme", //                  1
      "  module Auth", //                2
      "    MAX = 3", //                  3
      "    class Login", //              4
      "      TTL = 60", //               5
      "    end", //                      6
      "  end", //                        7
      "  class Auth::Session", //        8
      "    KEY = :sid", //               9
      "  end", //                        10
      "end", //                          11
      "",
    ].join("\n");
    expect(declarationsOf(src)).toEqual([
      { typeId: "Acme", symbolKind: "module", line: 1, reopens: false },
      { typeId: "Acme::Auth", symbolKind: "module", line: 2, reopens: false },
      { typeId: "Acme::Auth::MAX", symbolKind: "constant", line: 3, reopens: false },
      { typeId: "Acme::Auth::Login", symbolKind: "class", line: 4, reopens: false },
      { typeId: "Acme::Auth::Login::TTL", symbolKind: "constant", line: 5, reopens: false },
      { typeId: "Acme::Auth::Session", symbolKind: "class", line: 8, reopens: false },
      { typeId: "Acme::Auth::Session::KEY", symbolKind: "constant", line: 9, reopens: false },
    ]);
  });

  it("emits file-level constants, scoped-target constants and a root-anchored constant", () => {
    const src = [
      "VERSION = '1.0'", //              1
      "Acme::Config::TIMEOUT = 30", //   2
      "::ROOT_FLAG = true", //           3
      "Point = Struct.new(:x, :y)", //   4
      "module M", //                     5
      "  Other::LIMIT = 5", //           6
      "end", //                          7
      "",
    ].join("\n");
    expect(declarationsOf(src)).toEqual([
      { typeId: "VERSION", symbolKind: "constant", line: 1, reopens: false },
      { typeId: "Acme::Config::TIMEOUT", symbolKind: "constant", line: 2, reopens: false },
      { typeId: "ROOT_FLAG", symbolKind: "constant", line: 3, reopens: false },
      { typeId: "Point", symbolKind: "constant", line: 4, reopens: false },
      { typeId: "M", symbolKind: "module", line: 5, reopens: false },
      { typeId: "M::Other::LIMIT", symbolKind: "constant", line: 6, reopens: false },
    ]);
  });

  it("emits a constant conditionally assigned with `||=`, bare or scoped, and not a local `+=`", () => {
    const src = [
      "VERSION ||= '1.0'", //          1
      "count += 1", //                 2
      "module Acme", //                3
      "  Config::TIMEOUT ||= 30", //   4
      "  LIMIT &&= 5", //              5
      "end", //                        6
      "",
    ].join("\n");
    expect(declarationsOf(src)).toEqual([
      { typeId: "VERSION", symbolKind: "constant", line: 1, reopens: false },
      { typeId: "Acme", symbolKind: "module", line: 3, reopens: false },
      { typeId: "Acme::Config::TIMEOUT", symbolKind: "constant", line: 4, reopens: false },
      { typeId: "Acme::LIMIT", symbolKind: "constant", line: 5, reopens: false },
    ]);
  });

  it("emits every constant target of a multiple assignment, splat and nested destructuring included", () => {
    const src = [
      "A, b = 1, 2", //                   1
      "module M", //                      2
      "  X, *REST = 1, 2, 3", //          3
      "  (P, q), Foo::Q = [1, 2], 3", //  4
      "  *rest, LAST = 1, 2", //          5
      "end", //                           6
      "",
    ].join("\n");
    expect(declarationsOf(src)).toEqual([
      { typeId: "A", symbolKind: "constant", line: 1, reopens: false },
      { typeId: "M", symbolKind: "module", line: 2, reopens: false },
      { typeId: "M::X", symbolKind: "constant", line: 3, reopens: false },
      { typeId: "M::REST", symbolKind: "constant", line: 3, reopens: false },
      { typeId: "M::P", symbolKind: "constant", line: 4, reopens: false },
      { typeId: "M::Foo::Q", symbolKind: "constant", line: 4, reopens: false },
      { typeId: "M::LAST", symbolKind: "constant", line: 5, reopens: false },
    ]);
  });

  it("does not emit `||=` or multiple-assignment constants inside a method body or `class << self`", () => {
    const src = [
      "class A",
      "  class << self",
      "    CACHE ||= {}",
      "    B, C = 1, 2",
      "  end",
      "  def run",
      "    D ||= 1",
      "    E, F = 1, 2",
      "  end",
      "end",
      "",
    ].join("\n");
    expect(declarationsOf(src)).toEqual([{ typeId: "A", symbolKind: "class", line: 1, reopens: false }]);
  });

  it("does not emit locals, attribute writes, or constants inside method bodies and `class << self`", () => {
    const src = [
      "limit = 3",
      "class A",
      "  self.table_name = 'as'",
      "  class << self",
      "    CACHE = {}",
      "    def build; end",
      "  end",
      "  def run",
      "    count = 0",
      "    INNER = 1",
      "  end",
      "  def self.make",
      "    OTHER = 2",
      "  end",
      "end",
      "",
    ].join("\n");
    expect(declarationsOf(src)).toEqual([{ typeId: "A", symbolKind: "class", line: 2, reopens: false }]);
  });

  it("leaves the channel absent on a file that declares nothing", () => {
    expect(declarationsOf("puts 'hi'\nx = 1\n")).toBeUndefined();
  });

  // bd tea-rags-mcp-ffxfc: the same walk also takes each declaration's member census,
  // a channel of its own that the pre-W3c baseline never had either.
  it("changes nothing else: the extraction minus typeDeclarations and typeMemberCensus equals the pre-W3c baseline", () => {
    const ex = extract(BASELINE_RUBY_SOURCE, "app/models/acme/auth.rb");
    const { typeDeclarations, typeMemberCensus, ...rest } = ex;
    const baseline = readFileSync(new URL("./fixtures/type-declarations-baseline.json", import.meta.url), "utf8");
    // Serialized compare: key order and every value, independent of how the
    // fixture file is formatted.
    expect(JSON.stringify(rest)).toBe(JSON.stringify(JSON.parse(baseline)));
    expect(typeDeclarations?.map((d) => d.typeId)).toEqual([
      "VERSION",
      "Acme::Config::TIMEOUT",
      "Acme",
      "Acme::Auth",
      "Acme::Auth::MAX",
      "Acme::Auth::HANDLERS",
      "Acme::Auth::Login",
      "Acme::Auth::Session",
    ]);
    expect(typeMemberCensus?.map((c) => c.typeId)).toEqual([
      "Acme",
      "Acme::Auth",
      "Acme::Auth::Login",
      "Acme::Auth::Session",
    ]);
  });
});
