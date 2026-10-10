/**
 * A module's `def self.extended(base)` hook that mixes modules into `base`
 * (bd tea-rags-mcp-89k7k.35.31).
 *
 * `extend M` puts M on the singleton class only, but Ruby then runs
 * `M.extended(klass)`, and a hook body like `klass.include(Loader)` puts Loader
 * on the INSTANCE ancestry. The walker records those injections as
 * `extendedHookMixins`: module FQ → the `include` / `prepend` calls the hook
 * makes on its parameter, each module canonicalized against the hook module's
 * lexical nesting when this file declares it. graphql-ruby's
 * `GraphQL::Schema::Member::HasArguments` is the measured shape.
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { extractFromRubyFile } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";

function extract(code: string, relPath = "lib/hooks.rb"): FileExtraction {
  const parser = new Parser();
  parser.setLanguage(RbLang);
  return extractFromRubyFile({ tree: parser.parse(code), code, relPath, language: "ruby", chunks: [] });
}

describe("Ruby walker: extended-hook mixins (bd 89k7k.35.31)", () => {
  it("records `param.include(X)` and `param.prepend(Y)` made inside `def self.extended(param)`", () => {
    const out = extract(
      [
        "module Hooks",
        "  def self.extended(cls)",
        "    super",
        "    cls.include(Loader)",
        "    cls.prepend(Wrapper)",
        "  end",
        "end",
      ].join("\n"),
    );
    expect(out.extendedHookMixins).toEqual({
      Hooks: [
        { kind: "include", module: "Loader" },
        { kind: "prepend", module: "Wrapper" },
      ],
    });
  });

  it("canonicalizes a hook module against the hook module's lexical nesting when this file declares it", () => {
    const out = extract(
      [
        "module GraphQL",
        "  module Shared",
        "  end",
        "  module HasArguments",
        "    def self.extended(cls)",
        "      cls.include(ArgumentObjectLoader)",
        "      cls.include(Shared)",
        "      cls.include(Elsewhere::Thing)",
        "    end",
        "    module ArgumentObjectLoader",
        "    end",
        "  end",
        "end",
      ].join("\n"),
    );
    expect(out.extendedHookMixins).toEqual({
      "GraphQL::HasArguments": [
        { kind: "include", module: "GraphQL::HasArguments::ArgumentObjectLoader" },
        { kind: "include", module: "GraphQL::Shared" },
        { kind: "include", module: "Elsewhere::Thing" },
      ],
    });
  });

  it("covers `param.send(:include, X)`", () => {
    const out = extract(
      ["module Hooks", "  def self.extended(base)", "    base.send(:include, Loader)", "  end", "end"].join("\n"),
    );
    expect(out.extendedHookMixins).toEqual({ Hooks: [{ kind: "include", module: "Loader" }] });
  });

  it("ignores non-hook methods, other receivers and `param.extend`", () => {
    const out = extract(
      [
        "module Hooks",
        "  def self.setup(cls)",
        "    cls.include(Loader)",
        "  end",
        "  def extended(cls)",
        "    cls.include(Loader)",
        "  end",
        "  def self.extended(cls)",
        "    other.include(Loader)",
        "    cls.extend(ClassMethods)",
        "  end",
        "end",
      ].join("\n"),
    );
    expect(out.extendedHookMixins).toBeUndefined();
  });
});
