/**
 * Part 1 — singleton_class (`class << self`) mixin extraction.
 *
 * Ruby allows `class << self; include Mixin; end` inside a module/class body
 * to add instance methods of Mixin as class-level (singleton) methods.
 * `collectRubyClassAncestors` must descend into those singleton_class bodies
 * and attribute the extracted mixins to the enclosing class/module FQ name.
 *
 * bd tea-rags-mcp-08tss Part 1.
 */

import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { extractFromRubyFile } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";

function parse(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(RbLang as unknown as Parser.Language);
  return parser.parse(src);
}

function ancestors(src: string): Record<string, readonly string[]> | undefined {
  const out = extractFromRubyFile({ tree: parse(src), code: src, relPath: "x.rb", language: "ruby", chunks: [] });
  return out.classAncestors;
}

function edges(src: string): string[] {
  const out = extractFromRubyFile({ tree: parse(src), code: src, relPath: "x.rb", language: "ruby", chunks: [] });
  return (out.inheritanceEdges ?? []).map((e) => `${e.source}:${e.ancestor}:${e.kind}`);
}

describe("singleton_class mixin extraction (bd 08tss Part 1)", () => {
  it("includes mixin from `class << self; include Mixin; end` in classAncestors for the enclosing module", () => {
    const src = `
module Octokit
  class << self
    include Octokit::Configurable
  end
end
`.trimStart();
    const map = ancestors(src);
    expect(map?.["Octokit"]).toContain("Octokit::Configurable");
  });

  it("includes mixin from singleton_class in inheritanceEdges for the enclosing module", () => {
    const src = `
module Octokit
  class << self
    include Octokit::Configurable
  end
end
`.trimStart();
    expect(edges(src)).toContain("Octokit:Octokit::Configurable:include");
  });

  it("also captures bare include inside singleton_class of a regular class", () => {
    const src = `
class Foo
  class << self
    include ClassMethods
  end
end
`.trimStart();
    const map = ancestors(src);
    expect(map?.["Foo"]).toContain("ClassMethods");
  });

  it("captures extend inside singleton_class body", () => {
    const src = `
class Foo
  class << self
    extend ClassMethods
  end
end
`.trimStart();
    const map = ancestors(src);
    expect(map?.["Foo"]).toContain("ClassMethods");
  });

  it("does not duplicate mixins already captured from the class body itself", () => {
    const src = `
class Foo
  include DirectMixin
  class << self
    include SingMixin
  end
end
`.trimStart();
    const map = ancestors(src);
    expect(map?.["Foo"]).toContain("DirectMixin");
    expect(map?.["Foo"]).toContain("SingMixin");
    // Each appears exactly once
    expect(map?.["Foo"]?.filter((a) => a === "DirectMixin").length).toBe(1);
    expect(map?.["Foo"]?.filter((a) => a === "SingMixin").length).toBe(1);
  });

  it("attributes mixin to the correctly-namespaced enclosing scope", () => {
    const src = `
module Acme
  module Auth
    class << self
      include Shared::Configurable
    end
  end
end
`.trimStart();
    const map = ancestors(src);
    expect(map?.["Acme::Auth"]).toContain("Shared::Configurable");
  });

  it("emits singleton_class include in inheritanceEdges with correct ordinal", () => {
    const src = `
module M
  class << self
    include A
    include B
  end
end
`.trimStart();
    const out = extractFromRubyFile({ tree: parse(src), code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    const inc = (out.inheritanceEdges ?? [])
      .filter((e) => e.source === "M" && e.kind === "include")
      .sort((a, b) => a.ordinal - b.ordinal);
    expect(inc.map((e) => e.ancestor)).toEqual(["A", "B"]);
  });
});
