import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import type { WalkInput } from "../../../../../../src/core/contracts/types/language.js";
import { RubyLanguage } from "../../../../../../src/core/domains/language/ruby/index.js";
import { buildIdentifierRows } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/identifier-rows.js";

function parse(src: string) {
  const p = new Parser();
  p.setLanguage(RbLang);
  return p.parse(src);
}

/**
 * One chunk per `class` / `def` line, closed by the matching `end` by indent —
 * enough for the flat fixtures below, and the owner join needs real ranges.
 */
function chunksOf(src: string): WalkInput["chunks"] {
  const lines = src.split("\n");
  const chunks: WalkInput["chunks"] = [];
  let className: string | undefined;
  lines.forEach((text, i) => {
    const klass = /^class (\w+)/.exec(text);
    const def = /^(\s+)def (\w+)/.exec(text);
    if (!klass && !def) return;
    const indent = klass ? "" : def![1];
    const endLine = lines.findIndex((t, j) => j > i && t === `${indent}end`) + 1;
    if (klass) {
      className = klass[1];
      chunks.push({ symbolId: className, startLine: i + 1, endLine, scope: [] });
    } else {
      chunks.push({ symbolId: `${className}#${def![2]}`, startLine: i + 1, endLine, scope: [className!] });
    }
  });
  return chunks;
}

/** Through the COMPOSED walker, so the pass's registration is exercised where production runs it. */
function extractionOf(src: string, opts: { gemfile?: string } = {}) {
  return new RubyLanguage().walker.walk({
    tree: parse(src),
    code: src,
    relPath: "a.rb",
    language: "ruby",
    chunks: chunksOf(src),
    gemfileContent: opts.gemfile,
  });
}

/** Field rows declared on a line that holds an accessor macro — the rows this facet owns. */
function fieldRowsOf(src: string, opts: { gemfile?: string } = {}) {
  const lines = src.split("\n");
  const macroLines = new Set(
    lines.flatMap((text, i) => (/^\s+[a-z_]+ :/.test(text) && !/^\s+def /.test(text) ? [i + 1] : [])),
  );
  return (extractionOf(src, opts).identifierDeclarations ?? []).filter(
    (row) => row.kind === "field" && macroLines.has(row.line),
  );
}

/** Rows as `cg_identifiers` persists them: the field type is joined there, not in the walker. */
function typedFieldRowsOf(src: string) {
  return buildIdentifierRows(extractionOf(src)).filter((row) => row.kind === "field");
}

// bd tea-rags-mcp-0qaht — accessor macros are field declarations for the naming lexicon.
describe("Ruby walker — accessor macros declare fields", () => {
  it("attr_reader / attr_accessor / attr_writer declare one @field per operand, owned by the class", () => {
    const rows = fieldRowsOf(
      `class Invoice\n  attr_reader :number, :total\n  attr_accessor :status\n  attr_writer :note\nend\n`,
    );
    expect(rows.map((r) => r.name).sort()).toEqual(["@note", "@number", "@status", "@total"]);
    expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(["field"]));
    expect(new Set(rows.map((r) => r.ownerSymbolId))).toEqual(new Set(["Invoice"]));
    expect(rows.find((r) => r.name === "@total")?.line).toBe(2);
  });

  it("a reader and a writer of the same name are one field per owner", () => {
    const rows = fieldRowsOf(`class Invoice\n  attr_reader :total\n  attr_writer :total\nend\n`);
    expect(rows.map((r) => r.name)).toEqual(["@total"]);
  });

  it("a static accessor (cattr_*, mattr_*) declares a class variable", () => {
    const rows = fieldRowsOf(`class Setting\n  cattr_accessor :default_locale\n  mattr_reader :zone\nend\n`, {
      gemfile: `gem "rails"\n`,
    });
    expect(rows.map((r) => r.name).sort()).toEqual(["@@default_locale", "@@zone"]);
  });

  it("a gem-gated accessor declares its field only when the project carries the gem", () => {
    const src = `class CreateInvoice\n  param :amount\nend\n`;
    expect(fieldRowsOf(src, { gemfile: `gem "dry-initializer"\n` }).map((r) => r.name)).toEqual(["@amount"]);
    expect(fieldRowsOf(src, { gemfile: `gem "sinatra"\n` })).toEqual([]);
  });

  it("an accessor declares one field per operand, not one per synthesised method", () => {
    const rows = fieldRowsOf(`class User\n  mount_uploader :avatar, AvatarUploader\nend\n`, {
      gemfile: `gem "carrierwave"\n`,
    });
    expect(rows.map((r) => r.name)).toEqual(["@avatar"]);
  });

  it("a predicate an accessor also declares is no ivar", () => {
    const rows = fieldRowsOf(`class Setting\n  class_attribute :enabled\nend\n`);
    expect(rows.map((r) => r.name)).toEqual(["@enabled"]);
  });

  it("a receiver-qualified call is no macro", () => {
    expect(fieldRowsOf(`class A\n  def x\n    obj.attr_reader :y\n  end\nend\n`)).toEqual([]);
  });

  it("an accessor is typed from the ivar the class assigns", () => {
    const rows = typedFieldRowsOf(
      `class Order\n  attr_reader :customer\n  def initialize\n    @customer = Customer.new\n  end\nend\n`,
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ name: "@customer", ownerSymbolId: "Order", typeName: "Customer" }),
    );
  });
});
