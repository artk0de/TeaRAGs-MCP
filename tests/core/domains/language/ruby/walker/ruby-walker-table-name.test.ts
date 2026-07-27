/**
 * `self.table_name = "..."` capture (bd tea-rags-mcp-8l5fo). The schema-column
 * pre-pass maps a `db/schema.rb` table onto its owning model; an explicit
 * `self.table_name` declaration always beats the inflection guess, so the walker
 * has to surface it run-global alongside `classAncestors` / `classExtends`.
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { extractFromRubyFile } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";

function tablesOf(src: string): Record<string, string> | undefined {
  const parser = new Parser();
  parser.setLanguage(RbLang as unknown as Parser.Language);
  const tree = parser.parse(src);
  return extractFromRubyFile({ tree, code: src, relPath: "app/models/firm.rb", language: "ruby", chunks: [] })
    .classSchemaTables;
}

describe("extractFromRubyFile — self.table_name capture (bd tea-rags-mcp-8l5fo)", () => {
  it("records a double-quoted table override on the declaring class", () => {
    expect(tablesOf('class Firm < ApplicationRecord\n  self.table_name = "companies"\nend\n')).toEqual({
      Firm: "companies",
    });
  });

  it("records a single-quoted override", () => {
    expect(tablesOf("class Firm < ApplicationRecord\n  self.table_name = 'companies'\nend\n")).toEqual({
      Firm: "companies",
    });
  });

  it("keys a nested class by its fully-qualified name", () => {
    const src = ['module Admin', "  class Firm < ApplicationRecord", '    self.table_name = "companies"', "  end", "end", ""].join(
      "\n",
    );
    expect(tablesOf(src)).toEqual({ "Admin::Firm": "companies" });
  });

  it("keys a compact class declaration by its written form", () => {
    const src = ['class Admin::Firm < ApplicationRecord', '  self.table_name = "companies"', "end", ""].join("\n");
    expect(tablesOf(src)).toEqual({ "Admin::Firm": "companies" });
  });

  it("omits the channel entirely when no class declares a table override", () => {
    expect(tablesOf("class Firm < ApplicationRecord\n  has_many :users\nend\n")).toBeUndefined();
  });

  it("ignores a non-literal table_name expression (no guess)", () => {
    expect(tablesOf("class Firm < ApplicationRecord\n  self.table_name = compute_name\nend\n")).toBeUndefined();
  });

  it("ignores a plain `table_name =` local assignment (not the class-level override)", () => {
    expect(tablesOf('class Firm < ApplicationRecord\n  table_name = "companies"\nend\n')).toBeUndefined();
  });
});
