/**
 * Ruby field accesses (bd tea-rags-mcp-zy6hx, D0 T3) — the
 * `FileExtraction.fieldAccesses` facts the field-access facet pass publishes,
 * read through the seam production runs: materialize, `collectSymbols(tree,
 * walker.nameOf, …)`, then the COMPOSED `walker.walk`, so the owner join
 * against real chunk ids is what is asserted.
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { materializeTree } from "../../../../../../src/core/adapters/tree-sitter/materialize.js";
import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { RubyLanguage } from "../../../../../../src/core/domains/language/ruby/index.js";
import { buildFieldAccessRows } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/field-access-rows.js";

function extract(src: string): FileExtraction {
  const language = new RubyLanguage();
  const parser = new Parser();
  parser.setLanguage(RbLang);
  const tree = { rootNode: materializeTree(parser.parse(src).rootNode, src) };
  const chunks = collectSymbols(
    tree,
    (node) => language.walker.nameOf(node),
    language.kernel.scopeSeparator ?? "::",
    language.kernel.disambiguateOverloads ?? false,
    new DefaultSymbolIdComposer(),
  );
  return language.walker.walk({ tree, code: src, relPath: "a.rb", language: "ruby", chunks });
}

function accessesOf(...lines: string[]) {
  return extract(lines.join("\n")).fieldAccesses ?? [];
}

describe("Ruby walker — field accesses", () => {
  it("records @x reads and writes in an instance method as self accesses owned by the enclosing class", () => {
    expect(
      accessesOf(
        "class Cart", //
        "  def total",
        "    @count = @items",
        "    @count",
        "  end",
        "end",
      ),
    ).toEqual([
      {
        symbolId: "Cart#total",
        ownerKind: "self",
        ownerType: "Cart",
        fieldName: "@count",
        accessKind: "write",
        line: 3,
      },
      {
        symbolId: "Cart#total",
        ownerKind: "self",
        ownerType: "Cart",
        fieldName: "@items",
        accessKind: "read",
        line: 3,
      },
      {
        symbolId: "Cart#total",
        ownerKind: "self",
        ownerType: "Cart",
        fieldName: "@count",
        accessKind: "read",
        line: 4,
      },
    ]);
  });

  it("names the owner the way the symbolId does, nested modules included", () => {
    const facts = accessesOf("module Shop", "  class Cart", "    def add", "      @n", "    end", "  end", "end");
    expect(facts.map((f) => [f.symbolId, f.ownerKind, f.ownerType])).toEqual([
      ["Shop::Cart#add", "self", "Shop::Cart"],
    ]);
  });

  it("records a compound assignment as a read followed by a write", () => {
    const facts = accessesOf(
      "class Counter",
      "  def bump",
      "    @n += 1",
      "    @cache ||= {}",
      "    @ok &&= false",
      "  end",
      "end",
    );
    expect(facts.map((f) => [f.fieldName, f.accessKind, f.line])).toEqual([
      ["@n", "read", 3],
      ["@n", "write", 3],
      ["@cache", "read", 4],
      ["@cache", "write", 4],
      ["@ok", "read", 5],
      ["@ok", "write", 5],
    ]);
  });

  it("records every target of a multiple assignment as a write, splat and nested targets included", () => {
    const facts = accessesOf(
      "class Pair",
      "  def split(list)",
      "    @a, (@b, @c), *@rest = list",
      "  rescue => @error",
      "  end",
      "end",
    );
    expect(facts.map((f) => [f.fieldName, f.accessKind])).toEqual([
      ["@a", "write"],
      ["@b", "write"],
      ["@c", "write"],
      ["@rest", "write"],
      ["@error", "write"],
    ]);
  });

  it("records @@x as a class access in an instance method and in a class method", () => {
    const facts = accessesOf(
      "class Registry",
      "  def register",
      "    @@count += 1",
      "  end",
      "  def self.count",
      "    @@count",
      "  end",
      "end",
    );
    expect(facts.map((f) => [f.symbolId, f.ownerKind, f.ownerType, f.fieldName, f.accessKind])).toEqual([
      ["Registry#register", "class", "Registry", "@@count", "read"],
      ["Registry#register", "class", "Registry", "@@count", "write"],
      ["Registry.count", "class", "Registry", "@@count", "read"],
    ]);
  });

  it("records @x inside def self.m and inside class << self as class accesses", () => {
    const facts = accessesOf(
      "class Config",
      "  def self.load",
      "    @settings = {}",
      "  end",
      "  class << self",
      "    def reset",
      "      @settings",
      "    end",
      "  end",
      "end",
    );
    expect(facts.map((f) => [f.symbolId, f.ownerKind, f.ownerType, f.fieldName, f.accessKind])).toEqual([
      ["Config.load", "class", "Config", "@settings", "write"],
      ["Config.reset", "class", "Config", "@settings", "read"],
    ]);
  });

  it("records a YARD-typed parameter's attribute read as a param access carrying the type and the receiver", () => {
    expect(
      accessesOf(
        "class Mailer",
        "  # @param order [Order] the order",
        "  def deliver(order)",
        "    order.email",
        "  end",
        "end",
      ),
    ).toEqual([
      {
        symbolId: "Mailer#deliver",
        ownerKind: "param",
        ownerType: "Order",
        receiver: "order",
        fieldName: "email",
        accessKind: "read",
        line: 4,
      },
    ]);
  });

  it("records an untyped parameter's attribute as unknown with the receiver, and a collection-typed one too", () => {
    const facts = accessesOf(
      "class Mailer",
      "  # @param [Array<Order>] orders",
      "  def deliver(order, orders, retries = 1, notify:)",
      "    order.email",
      "    orders.latest",
      "    retries.zero",
      "    notify.channel",
      "  end",
      "end",
    );
    expect(facts.map((f) => [f.ownerKind, f.ownerType, f.receiver, f.fieldName])).toEqual([
      ["unknown", undefined, "order", "email"],
      ["unknown", undefined, "orders", "latest"],
      ["unknown", undefined, "retries", "zero"],
      ["unknown", undefined, "notify", "channel"],
    ]);
  });

  it("records an attribute writer on a parameter as a write and a compound one as read + write", () => {
    const facts = accessesOf(
      "class Mailer",
      "  # @param order [Order]",
      "  def mark(order)",
      "    order.sent = true",
      "    order.attempts += 1",
      "    order&.flag",
      "  end",
      "end",
    );
    expect(facts.map((f) => [f.ownerKind, f.ownerType, f.fieldName, f.accessKind])).toEqual([
      ["param", "Order", "sent", "write"],
      ["param", "Order", "attempts", "read"],
      ["param", "Order", "attempts", "write"],
      ["param", "Order", "flag", "read"],
    ]);
  });

  it("records nothing for self.x, a bare call, a call with arguments or a block, a predicate, or a local", () => {
    const facts = accessesOf(
      "class Svc",
      "  def run(p)",
      "    self.total",
      "    total",
      "    p.update(1)",
      "    p.fetch()",
      "    p.each { |x| x }",
      "    p.valid?",
      "    p.save!",
      "    local = Thing.new",
      "    local.name",
      "    p.body.size",
      "  end",
      "end",
    );
    expect(facts.map((f) => [f.receiver, f.fieldName])).toEqual([["p", "body"]]);
  });

  it("skips a pure read of a core Object/Kernel/Enumerable member on a parameter, keeps user attributes and core-named writes", () => {
    const facts = accessesOf(
      "class Svc",
      "  # @param order [Order]",
      "  def run(path, options, order, list)",
      "    path.to_s",
      "    options.dup",
      "    order.class",
      "    options.freeze",
      "    list.size",
      "    path.nil?",
      "    order.total",
      "    options.timeout",
      "    list.size = 1",
      "    list.count += 1",
      "    local = Thing.new",
      "    local.to_s",
      "  end",
      "end",
    );
    expect(facts.map((f) => [f.receiver, f.fieldName, f.accessKind])).toEqual([
      ["order", "total", "read"],
      ["options", "timeout", "read"],
      ["list", "size", "write"],
      ["list", "count", "read"],
      ["list", "count", "write"],
    ]);
  });

  it("keeps id and errors reads on a parameter, which are real attributes rather than core members", () => {
    const facts = accessesOf("class Svc", "  def run(record)", "    record.id", "    record.errors", "  end", "end");
    expect(facts.map((f) => f.fieldName)).toEqual(["id", "errors"]);
  });

  it("keeps a block's ivars on the enclosing method and lets a block parameter shadow a method parameter", () => {
    const facts = accessesOf(
      "class Svc",
      "  def run(p)",
      "    @items.each do |p|",
      "      @seen = p.name",
      "    end",
      "    handler = ->(p) { p.size }",
      "    p.kept",
      "  end",
      "end",
    );
    expect(facts.map((f) => [f.symbolId, f.ownerKind, f.fieldName, f.accessKind])).toEqual([
      ["Svc#run", "self", "@items", "read"],
      ["Svc#run", "self", "@seen", "write"],
      ["Svc#run", "unknown", "kept", "read"],
    ]);
  });

  it("skips the bodies of instance_eval / class_eval blocks, which rebind self", () => {
    const facts = accessesOf(
      "class Svc",
      "  def run(other)",
      "    other.instance_eval { @hidden }",
      "    Svc.class_eval do",
      "      @also_hidden = 1",
      "    end",
      "    instance_exec(1) { |n| @exec_hidden }",
      "    instance_variable_get(:@dynamic)",
      "    @visible",
      "  end",
      "end",
    );
    expect(facts.map((f) => f.fieldName)).toEqual(["@visible"]);
  });

  it("records nothing in a class body outside a method, nor in a top-level def", () => {
    const facts = accessesOf(
      "@top = 1",
      "def helper(p)",
      "  @free = p.value",
      "end",
      "class Svc",
      "  @class_ivar = 1",
      "  @@shared = 2",
      "  self.config = @class_ivar",
      "end",
    );
    expect(facts).toEqual([]);
  });

  it("records accesses inside a define_method block the walker chunks as a method", () => {
    const facts = accessesOf("class Svc", "  define_method(:dyn) do |p|", "    @x = p.value", "  end", "end");
    expect(facts.map((f) => [f.symbolId, f.ownerKind, f.ownerType, f.receiver, f.fieldName, f.accessKind])).toEqual([
      ["Svc#dyn", "self", "Svc", undefined, "@x", "write"],
      ["Svc#dyn", "unknown", undefined, "p", "value", "read"],
    ]);
  });

  it("records @x in a module method as owned by the module", () => {
    const facts = accessesOf("module Cacheable", "  def cached", "    @cache", "  end", "end");
    expect(facts.map((f) => [f.symbolId, f.ownerKind, f.ownerType])).toEqual([
      ["Cacheable#cached", "self", "Cacheable"],
    ]);
  });

  it("attributes every access of an oversized method to the method's base id, never a #partN", () => {
    const body = Array.from({ length: 400 }, (_, i) => `    @f${i} = @g${i} + ${i}`);
    const facts = accessesOf("class Big", "  def run", ...body, "  end", "end");
    expect(facts).toHaveLength(800);
    expect(new Set(facts.map((f) => f.symbolId))).toEqual(new Set(["Big#run"]));
  });

  it("reaches cg_symbols_edges_field rows through buildFieldAccessRows", () => {
    const extraction = extract(["class Cart", "  def add", "    @n += 1", "    @n += 2", "  end", "end"].join("\n"));
    expect(buildFieldAccessRows(extraction)).toEqual([
      expect.objectContaining({
        sourceSymbolId: "Cart#add",
        ownerKind: "self",
        ownerType: "Cart",
        fieldName: "@n",
        accessKind: "read",
        accessCount: 2,
        firstLine: 3,
      }),
      expect.objectContaining({
        sourceSymbolId: "Cart#add",
        ownerKind: "self",
        ownerType: "Cart",
        fieldName: "@n",
        accessKind: "write",
        accessCount: 2,
        firstLine: 3,
      }),
    ]);
  });
});
