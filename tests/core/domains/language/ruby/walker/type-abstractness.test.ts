/**
 * Ruby type-abstractness census (bd tea-rags-mcp-r8hme.8). A class or module
 * that declares a method whose whole body is `raise NotImplementedError` leaves
 * that method to its includers or subclasses: abstract. A declaration that
 * defines a method of its own is concrete — `initialize` is the constructor,
 * not behaviour. A class whose body is only `initialize`, attribute accessors,
 * constants and assignments declares no behaviour — an error class, a data
 * object — and counts as neither (bd tea-rags-mcp-44cpv, decision c-1=a); so
 * does a module that defines no method (a namespace).
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

  it("counts method-defining classes and modules as concrete, behaviour-free classes as neither", () => {
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

    // `Empty` is behaviour-free (44cpv c-1); the rest define a method.
    expect(censusOf(src)).toEqual({ abstractTypeCount: 0, concreteTypeCount: 3 });
  });

  describe("behaviour-free classes (bd tea-rags-mcp-44cpv, decision c-1=a)", () => {
    it("counts an error class of initialize, attr accessors and constants as neither bucket", () => {
      const src = [
        "class PipelineError < StandardError",
        "  KIND = 'pipeline'",
        "  attr_accessor :code",
        "  def initialize(code)",
        "    super(code)",
        "    @code = code",
        "  end",
        "end",
        "",
      ].join("\n");

      expect(censusOf(src)).toEqual({ abstractTypeCount: 0, concreteTypeCount: 0 });
    });

    it("counts a data object of attr_reader and initialize as neither", () => {
      const src = [
        "class Row",
        "  attr_reader :id, :label",
        "  def initialize(id, label)",
        "    @id = id",
        "    @label = label",
        "  end",
        "end",
        "",
      ].join("\n");

      expect(censusOf(src)).toEqual({ abstractTypeCount: 0, concreteTypeCount: 0 });
    });

    it("keeps counting a class as concrete for a class method", () => {
      expect(censusOf("class Repo\n  def self.build; new; end\nend\n")).toEqual({
        abstractTypeCount: 0,
        concreteTypeCount: 1,
      });
    });
  });
});
