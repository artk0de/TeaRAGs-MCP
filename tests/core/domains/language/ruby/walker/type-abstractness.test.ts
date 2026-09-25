/**
 * Ruby type-abstractness census (bd tea-rags-mcp-r8hme.8). A class or module
 * that declares a method whose whole body is `raise NotImplementedError` leaves
 * that method to its includers or subclasses: abstract. Any other class is
 * concrete, and so is a module that defines methods (a mixin). A module that
 * defines no method of its own is a namespace and counts as neither.
 */
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { typeAbstractnessOf } from "../../__helpers__/type-abstractness.js";
import { RubyLanguage } from "../../../../../../src/core/domains/language/ruby/index.js";

const censusOf = (src: string) => typeAbstractnessOf(new RubyLanguage(), RbLang, src, "app/a.rb", "ruby");

describe("Ruby walker — type-abstractness census", () => {
  it("reads a NotImplementedError stub as abstract in a class or a module", () => {
    const src = [
      "class BaseService",
      "  def call",
      "    raise NotImplementedError",
      "  end",
      "end",
      "module Exportable",
      "  def self.format; raise NotImplementedError, 'x'; end",
      "end",
      "",
    ].join("\n");

    expect(censusOf(src)).toEqual({ abstractTypeCount: 2, concreteTypeCount: 0 });
  });

  it("counts other classes and method-defining modules as concrete, namespace modules as neither", () => {
    const src = [
      "module Billing",
      "  class Invoice < ApplicationRecord",
      "    def total; 1; end",
      "  end",
      "  class Empty; end",
      "end",
      "module Helpers",
      "  def fmt(x) = x.to_s",
      "end",
      "class Hooked",
      "  def before; end",
      "end",
      "",
    ].join("\n");

    expect(censusOf(src)).toEqual({ abstractTypeCount: 0, concreteTypeCount: 4 });
  });
});
