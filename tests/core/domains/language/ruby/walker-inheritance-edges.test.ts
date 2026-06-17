/**
 * Ruby walker inheritanceEdges tests (bd tea-rags-mcp-lz8t) — full kind
 * parity with the TS walker (bd tea-rags-mcp-f10y T6). Ruby distinguishes
 * four hierarchy channels the legacy flat `classAncestors` Record collapses:
 *
 *   - `class Foo < Bar`  → kind `super`   (single superclass)
 *   - `include Mod`      → kind `include` (MRO insertion after the class)
 *   - `extend Mod`       → kind `extend`  (singleton-class mixin)
 *   - `prepend Mod`      → kind `prepend` (MRO insertion before the class)
 *
 * Mirrors tests/core/domains/language/typescript/walker-inheritance-edges.test.ts.
 */

import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { extractFromRubyFile } from "../../../../../src/core/domains/language/ruby/walker/walker.js";

function parse(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(RbLang as unknown as Parser.Language);
  return parser.parse(src);
}

function edges(src: string): string[] {
  const out = extractFromRubyFile({ tree: parse(src), code: src, relPath: "x.rb", language: "ruby", chunks: [] });
  return (out.inheritanceEdges ?? []).map((e) => `${e.source}:${e.ancestor}:${e.kind}`);
}

describe("Ruby walker inheritanceEdges (bd lz8t)", () => {
  it("captures the superclass as kind super", () => {
    expect(edges("class Dog < Animal\nend\n")).toEqual(["Dog:Animal:super"]);
  });

  it("captures include as kind include", () => {
    expect(edges("class Foo\n  include Comparable\nend\n")).toEqual(["Foo:Comparable:include"]);
  });

  it("captures extend as kind extend (not include)", () => {
    expect(edges("class Foo\n  extend ClassMethods\nend\n")).toEqual(["Foo:ClassMethods:extend"]);
  });

  it("captures prepend as kind prepend", () => {
    expect(edges("class Foo\n  prepend Overrides\nend\n")).toEqual(["Foo:Overrides:prepend"]);
  });

  it("captures all four channels with precise kinds in one class", () => {
    const src = "class Foo < Animal\n  prepend P\n  include I\n  extend E\nend\n";
    expect(edges(src).sort()).toEqual(["Foo:Animal:super", "Foo:E:extend", "Foo:I:include", "Foo:P:prepend"].sort());
  });

  it("qualifies the source by enclosing module scope", () => {
    const src = "module Acme\n  class User < Base\n    include Trackable\n  end\nend\n";
    expect(edges(src).sort()).toEqual(["Acme::User:Base:super", "Acme::User:Trackable:include"].sort());
  });

  it("ordinal reflects declaration order within the include channel", () => {
    const src = "class Foo\n  include A\n  include B\n  include C\nend\n";
    const out = extractFromRubyFile({ tree: parse(src), code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    const inc = (out.inheritanceEdges ?? []).filter((e) => e.kind === "include").sort((a, b) => a.ordinal - b.ordinal);
    expect(inc.map((e) => e.ancestor)).toEqual(["A", "B", "C"]);
  });

  it("emits nothing for a class with no heritage", () => {
    expect(edges("class Plain\nend\n")).toEqual([]);
  });

  it("captures qualified ancestor names verbatim", () => {
    expect(edges("class User < ActiveRecord::Base\nend\n")).toEqual(["User:ActiveRecord::Base:super"]);
  });

  it("still populates the legacy classAncestors / classPrependedAncestors Records (phased — not removed)", () => {
    // The resolver (ruby-super, ruby-local-type, ruby-constant) walks the
    // flat classAncestors chain — it MUST keep working alongside the new
    // precise inheritanceEdges field.
    const src = "class Foo < Animal\n  extend Bar\n  prepend Baz\n  include Qux\nend\n";
    const out = extractFromRubyFile({ tree: parse(src), code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    expect(out.classAncestors?.["Foo"]).toEqual(["Animal", "Bar", "Qux"]);
    expect(out.classPrependedAncestors?.["Foo"]).toEqual(["Baz"]);
  });
});
