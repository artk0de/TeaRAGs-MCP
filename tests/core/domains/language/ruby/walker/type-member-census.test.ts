/**
 * Ruby type member census (bd tea-rags-mcp-ffxfc) — `FileExtraction.typeMemberCensus`
 * per class / module body: how many distinct members are BEHAVIOUR (`def`) and
 * how many are DATA (a name an `accessor`-category DSL macro declares:
 * `attr_accessor`, ActiveModel / StoreModel `attribute`, `store_accessor`, …).
 *
 * An accessor declares ONE field, never a reader plus a writer method, and a
 * `def` that re-implements an accessor of the same body (`def name` over
 * `attr_reader :name`, `def name=`) stays that field. `def self.x`, a `def`
 * inside `class << self` or a self-scoped block (`included do`), and a `def`
 * passed to a visibility macro (`private def x`) are methods of the body. A
 * `Struct.new(:a, …)` / `Data.define(:a, …)` superclass declares fields, and so
 * does a constant bound to one; that constant's block `def`s are its methods.
 * Other DSL macros (`has_many`, `scope`, `delegate`) are neither: what a macro
 * declares is DSL-specific. The census is naming data only — the method rows the
 * resolver reads (`cg_symbols`) are untouched.
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { rbNameOf } from "../../../../../../src/core/domains/language/ruby/walker/name-of.js";
import { extractFromRubyFile } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";

function censusOf(src: string): FileExtraction["typeMemberCensus"] {
  const parser = new Parser();
  parser.setLanguage(RbLang);
  const tree = parser.parse(src);
  const chunks = collectSymbols(tree, (n) => rbNameOf(n), "::", false, new DefaultSymbolIdComposer());
  return extractFromRubyFile({ tree, code: src, relPath: "app/models/m.rb", language: "ruby", chunks })
    .typeMemberCensus;
}

describe("extractFromRubyFile — typeMemberCensus", () => {
  it("counts attr_accessor names as fields and defs as methods", () => {
    const src = [
      "class ReportData", // 1
      "  attr_accessor :title, :rows", // 2
      "  def render", // 3
      "  end", // 4
      "end", // 5
      "",
    ].join("\n");
    expect(censusOf(src)).toEqual([{ typeId: "ReportData", line: 1, methodCount: 1, fieldCount: 2 }]);
  });

  it("merges readers, writers and accessor re-implementations into one field per name", () => {
    const src = [
      "class Account",
      "  attr_reader :name, :email",
      "  attr_writer :name",
      "  def name",
      "    @name.upcase",
      "  end",
      "  def email=(v)",
      "    @email = v",
      "  end",
      "end",
      "",
    ].join("\n");
    expect(censusOf(src)).toEqual([{ typeId: "Account", line: 1, methodCount: 0, fieldCount: 2 }]);
  });

  it("counts singleton, class << self, self-scoped block and visibility-macro defs as methods; other macros as neither", () => {
    const src = [
      "module Billing",
      "  class Invoice",
      "    has_many :lines",
      "    scope :open, -> { where(open: true) }",
      "    def self.build; end",
      "    class << self",
      "      def load; end",
      "    end",
      "    included do",
      "      def audit; end",
      "    end",
      "    private def recalc; end",
      "    def total; end",
      "  end",
      "end",
      "",
    ].join("\n");
    expect(censusOf(src)).toEqual([
      { typeId: "Billing", line: 1, methodCount: 0, fieldCount: 0 },
      { typeId: "Billing::Invoice", line: 2, methodCount: 5, fieldCount: 0 },
    ]);
  });

  it("reads attribute-style accessor macros as fields, a class-level accessor apart from an instance one", () => {
    const src = [
      "class CertificateData",
      "  include StoreModel::Model",
      "  attribute :token, :string",
      "  store_accessor :settings, :theme, :locale",
      "  cattr_accessor :token",
      "end",
      "",
    ].join("\n");
    // token, theme, locale (instance) + .token (class-level); `settings` is the store column, not a member.
    expect(censusOf(src)).toEqual([{ typeId: "CertificateData", line: 1, methodCount: 0, fieldCount: 4 }]);
  });

  it("reads Struct.new / Data.define members as fields, on a superclass and on a constant", () => {
    const src = [
      "class Point < Struct.new(:x, :y, keyword_init: true)", // 1
      "  def norm; end", // 2
      "end", // 3
      "Range2 = Data.define(:from, :to) do", // 4
      "  def size; end", // 5
      "end", // 6
      "MAX = 3", // 7
      "",
    ].join("\n");
    expect(censusOf(src)).toEqual([
      { typeId: "Point", line: 1, methodCount: 1, fieldCount: 2 },
      { typeId: "Range2", line: 4, methodCount: 1, fieldCount: 2 },
    ]);
  });
});
