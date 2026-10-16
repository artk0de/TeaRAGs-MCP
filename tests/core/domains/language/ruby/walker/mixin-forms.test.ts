/**
 * Every mixin form the Ruby walker can read is recorded, and every one it
 * cannot read leaves an `unresolvedMixinClasses` fact on the class it sits in
 * (bd tea-rags-mcp-2m83f.48): the Rails-member rule must never claim a call a
 * mixin the walker did not see could answer.
 */

import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { extractFromRubyFile } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";

function extract(src: string): FileExtraction {
  const parser = new Parser();
  parser.setLanguage(RbLang);
  return extractFromRubyFile({ tree: parser.parse(src), code: src, relPath: "x.rb", language: "ruby", chunks: [] });
}

function edges(out: FileExtraction): string[] {
  return (out.inheritanceEdges ?? []).map((e) => `${e.source}:${e.ancestor}:${e.kind}`);
}

describe("mixin forms (bd 2m83f.48)", () => {
  it("records every constant argument of `include A, B`, later = nearer", () => {
    const out = extract("class Invoice < ApplicationRecord\n  include Auditable, Lockable\nend\n");
    expect(out.classAncestors?.["Invoice"]).toEqual(["ApplicationRecord", "Lockable", "Auditable"]);
    expect(edges(out)).toEqual(expect.arrayContaining(["Invoice:Auditable:include", "Invoice:Lockable:include"]));
    expect(out.unresolvedMixinClasses).toBeUndefined();
  });

  it("records every argument of `prepend A, B` and `extend A, B`", () => {
    const out = extract("class Foo\n  prepend P1, P2\n  extend E1, E2\nend\n");
    expect(out.classPrependedAncestors?.["Foo"]).toEqual(["P2", "P1"]);
    expect(out.classAncestors?.["Foo"]).toEqual(["E2", "E1"]);
  });

  it("records `send(:include, X)` and `self.include(X)` in a class body", () => {
    const out = extract("class Invoice < ApplicationRecord\n  send(:include, Helper)\n  self.include(Other)\nend\n");
    expect(out.classAncestors?.["Invoice"]).toEqual(["ApplicationRecord", "Helper", "Other"]);
    expect(out.unresolvedMixinClasses).toBeUndefined();
  });

  it("records `X.include(Y)` and `X.send(:include, Y)` onto X, wherever they are written", () => {
    const out = extract("Invoice.include(Helper)\nmodule Boot\n  Firm.send(:include, Other)\nend\n");
    expect(out.classAncestors?.["Invoice"]).toEqual(["Helper"]);
    expect(out.classAncestors?.["Firm"]).toEqual(["Other"]);
    expect(edges(out)).toEqual(expect.arrayContaining(["Invoice:Helper:include", "Firm:Other:include"]));
  });

  it("records a top-level `include X` onto Object", () => {
    const out = extract("include Helpers\n");
    expect(out.classAncestors?.["Object"]).toEqual(["Helpers"]);
  });

  it("records `base.include(X)` in a `self.included(base)` hook onto the module", () => {
    const out = extract("module Trackable\n  def self.included(base)\n    base.send(:include, Lockable)\n  end\nend\n");
    expect(out.classAncestors?.["Trackable"]).toEqual(["Lockable"]);
  });

  it("records `included do; include X; end` onto the concern", () => {
    const src = "module Trackable\n  extend ActiveSupport::Concern\n  included do\n    include Lockable\n  end\nend\n";
    expect(extract(src).classAncestors?.["Trackable"]).toEqual(["ActiveSupport::Concern", "Lockable"]);
  });

  it("marks a class whose `include` names a variable", () => {
    const out = extract("class Invoice < ApplicationRecord\n  include some_var\nend\n");
    expect(out.unresolvedMixinClasses).toEqual(["Invoice"]);
    expect(out.classAncestors?.["Invoice"]).toEqual(["ApplicationRecord"]);
  });

  it("marks a class whose body includes through a form the walker cannot attribute", () => {
    const src =
      "module Trackable\n  def self.included(base)\n    base.class_eval { include Lockable }\n  end\nend\n" +
      "class Foo\n  MODS.each { |m| include m }\nend\n";
    expect(extract(src).unresolvedMixinClasses).toEqual(["Trackable", "Foo"]);
  });

  it("marks X when `X.include(var)` names a variable", () => {
    expect(extract("Invoice.include(helper)\n").unresolvedMixinClasses).toEqual(["Invoice"]);
  });

  it("leaves `include?` and an `extend` of a variable unmarked", () => {
    const out = extract("class Foo\n  def a\n    list.include?(x)\n  end\n  extend self\nend\n");
    expect(out.unresolvedMixinClasses).toBeUndefined();
  });
});
