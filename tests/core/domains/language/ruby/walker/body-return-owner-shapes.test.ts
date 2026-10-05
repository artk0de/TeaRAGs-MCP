/**
 * Owner-keyed member body returns that need the DECLARING class (bd
 * tea-rags-mcp-0qaht.54). The owner-keyed channel
 * (`collectRubyScopedBodyReturnTypes`) knows which class a def belongs to; the
 * flat channel does not, so these three shapes widen the owner-keyed channel
 * only and the flat map stays exactly as it was:
 *
 *  (a) a receiverless `new(...)` in a singleton method of a CLASS is an
 *      instance of that class (huginn `TimeTracker.track`);
 *  (b) a self-returning tail — `self`, `clone` / `dup`, `.tap`, or a call on
 *      one of those to a sibling whose own tail is self-returning — is an
 *      instance of the declaring class (mastodon `Trends::Query#allowed =
 *      clone.allowed!`);
 *  (c) a relative constant in a constructor tail is qualified the way Ruby's
 *      lexical lookup reads it, when the file declares it under the def's
 *      nesting (`Query.new` inside `class Trends::Links` →
 *      `Trends::Links::Query`).
 *
 * The local-binding pass shares (a) for `instance = new(*args)`.
 */

import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import {
  collectRubyBodyReturnTypes,
  collectRubyScopedBodyReturnTypes,
} from "../../../../../../src/core/domains/language/ruby/walker/local-bindings.js";
import { rubyAstInferenceTypeSource } from "../../../../../../src/core/domains/language/ruby/walker/type-sources/ast-inference.js";
import type { RubyExtractInput } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";

function parser(): Parser {
  const p = new Parser();
  p.setLanguage(RbLang);
  return p;
}

function scoped(lines: string[]) {
  return collectRubyScopedBodyReturnTypes(parser().parse(`${lines.join("\n")}\n`).rootNode);
}

function flat(lines: string[]) {
  return collectRubyBodyReturnTypes(parser().parse(`${lines.join("\n")}\n`).rootNode);
}

function localFacts(lines: string[]) {
  const code = `${lines.join("\n")}\n`;
  const input: RubyExtractInput = { tree: parser().parse(code), code, relPath: "t.rb", language: "ruby", chunks: [] };
  return rubyAstInferenceTypeSource.extract(input);
}

const inst = (name: string) => ({ form: "instance", name });

describe("(a) receiverless `new` in a singleton method", () => {
  it("types a `def self.x` tail `new(...)` as an instance of the enclosing class", () => {
    const src = [
      "module Util",
      "  class TimeTracker",
      "    def self.track",
      "      result = yield",
      "      new(1, result)",
      "    end",
      "  end",
      "end",
    ];
    expect(scoped(src)["Util::TimeTracker#track"]).toEqual(inst("Util::TimeTracker"));
  });

  it("types a bare `new` tail inside `class << self`", () => {
    const src = ["class Policy", "  class << self", "    def current", "      new", "    end", "  end", "end"];
    expect(scoped(src)["Policy#current"]).toEqual(inst("Policy"));
  });

  it("types a memoized `@x ||= new` singleton reader", () => {
    const src = ["class App", "  def self.prototype", "    @prototype ||= new", "  end", "end"];
    expect(scoped(src)["App#prototype"]).toEqual(inst("App"));
  });

  it("stays silent in an instance method, in a module, and through a block", () => {
    const src = [
      "class Widget",
      "  def make",
      "    new",
      "  end",
      "end",
      "module Helper",
      "  def self.build",
      "    new",
      "  end",
      "end",
      "module Concern",
      "  included do",
      "    def self.build",
      "      new",
      "    end",
      "  end",
      "end",
    ];
    expect(scoped(src)).toEqual({});
  });

  it("does not read a local named `new` as the constructor", () => {
    const src = ["class Renamer", "  def self.rename(new)", "    new", "  end", "end"];
    expect(scoped(src)).toEqual({});
  });

  it("leaves the flat channel untouched", () => {
    const src = ["class TimeTracker", "  def self.track", "    new(1)", "  end", "end"];
    expect(flat(src)).toEqual({});
  });

  it("binds `instance = new(*args)` in a singleton method to the enclosing class", () => {
    const facts = localFacts([
      "class GoogleCalendar",
      "  def self.open(*args)",
      "    instance = new(*args)",
      "    instance.cleanup!",
      "  end",
      "end",
    ]);
    expect(facts.find((f) => f.name === "instance")?.type).toEqual(inst("GoogleCalendar"));
  });

  it("binds nothing for `x = new` in an instance method or inside a block", () => {
    const facts = localFacts([
      "class Drawer",
      "  def draw",
      "    a = new(1)",
      "  end",
      "  def self.each_one",
      "    items.map { |i| b = new(i) }",
      "  end",
      "end",
    ]);
    expect(facts.filter((f) => f.name === "a" || f.name === "b")).toEqual([]);
  });
});

describe("(b) self-returning tails", () => {
  const query = [
    "class Trends::Query",
    "  def allowed!",
    "    @allowed = true",
    "    self",
    "  end",
    "  def allowed",
    "    clone.allowed!",
    "  end",
    "  def copy",
    "    dup",
    "  end",
    "  def tapped",
    "    dup.tap { |q| q.reset }",
    "  end",
    "  def opaque",
    "    clone.unknown!",
    "  end",
    "end",
  ];

  it("types `self`, `dup`, `.tap` and a call on a copy to a self-returning sibling as the declaring class", () => {
    const facts = scoped(query);
    expect(facts["Trends::Query#allowed!"]).toEqual(inst("Trends::Query"));
    expect(facts["Trends::Query#allowed"]).toEqual(inst("Trends::Query"));
    expect(facts["Trends::Query#copy"]).toEqual(inst("Trends::Query"));
    expect(facts["Trends::Query#tapped"]).toEqual(inst("Trends::Query"));
    expect(facts["Trends::Query#opaque"]).toBeUndefined();
  });

  it("stays silent on a singleton `self`, a module `self`, an ambiguous sibling and a cycle", () => {
    const src = [
      "class Builder",
      "  def self.configure",
      "    self",
      "  end",
      "  def twice",
      "    clone.again",
      "  end",
      "  def again",
      "    self",
      "  end",
      "  def again",
      "    other",
      "  end",
      "  def ping",
      "    clone.pong",
      "  end",
      "  def pong",
      "    clone.ping",
      "  end",
      "end",
      "module Mixin",
      "  def chain",
      "    self",
      "  end",
      "end",
    ];
    const facts = scoped(src);
    for (const key of ["Builder#configure", "Builder#twice", "Builder#ping", "Builder#pong", "Mixin#chain"]) {
      expect(facts[key]).toBeUndefined();
    }
  });

  it("leaves the flat channel untouched", () => {
    expect(flat(query)).toEqual({});
  });
});

describe("(c) relative constants qualified by the def's lexical nesting", () => {
  it("qualifies a constant the file declares under the enclosing class", () => {
    const src = [
      "class Trends::Links < Trends::Base",
      "  class Query < Trends::Query",
      "  end",
      "  def query",
      "    Query.new(1)",
      "  end",
      "end",
    ];
    expect(scoped(src)["Trends::Links#query"]).toEqual(inst("Trends::Links::Query"));
  });

  it("walks outward through the nesting, innermost first", () => {
    const src = [
      "module Shop",
      "  class Row",
      "  end",
      "  class Report",
      "    def row",
      "      Row.new",
      "    end",
      "  end",
      "end",
    ];
    expect(scoped(src)["Shop::Report#row"]).toEqual(inst("Shop::Row"));
  });

  it("does not treat a compact `class A::B` as nesting `A`", () => {
    const src = [
      "module Shop",
      "  class Row",
      "  end",
      "end",
      "class Shop::Report",
      "  def row",
      "    Row.new",
      "  end",
      "end",
    ];
    expect(scoped(src)["Shop::Report#row"]).toEqual(inst("Row"));
  });

  it("keeps the literal when the file declares nothing under the nesting", () => {
    const src = [
      "module Billing",
      "  class Invoice",
      "    def data",
      "      InvoiceRow.new",
      "    end",
      "  end",
      "end",
    ];
    expect(scoped(src)["Billing::Invoice#data"]).toEqual(inst("InvoiceRow"));
  });

  it("leaves the flat channel's literal spelling untouched", () => {
    const src = ["class Trends::Links", "  class Query", "  end", "  def query", "    Query.new", "  end", "end"];
    expect(flat(src)).toEqual({ query: "Query" });
  });
});
