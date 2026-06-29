import Parser from "tree-sitter";
import Ruby from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { collectRubyInstantiatedTypes } from "../../../../../../src/core/domains/language/ruby/walker/type-sources/ast-inference.js";
import { extractFromRubyFile } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";

function parse(code: string): Parser.Tree {
  const p = new Parser();
  p.setLanguage(Ruby as Parser.Language);
  return p.parse(code);
}

describe("collectRubyInstantiatedTypes", () => {
  it("collects constructors, factories, finders and relation tails; dedups", () => {
    const tree = parse(
      [
        "user = User.new",
        "post = Post.find(1)",
        "acct = Account.create!(name: 'x')",
        "first = Comment.where(approved: true).first",
        "dup = User.new", // duplicate — must dedup
        "n = compute(2)", // bare call — no const, ignored
      ].join("\n"),
    );
    const got = collectRubyInstantiatedTypes(tree.rootNode).sort();
    expect(got).toEqual(["Account", "Comment", "Post", "User"]);
  });

  it("returns [] when nothing is instantiated", () => {
    const tree = parse("x = compute(1)\ny = x + 2\n");
    expect(collectRubyInstantiatedTypes(tree.rootNode)).toEqual([]);
  });
});

describe("collectRubyInstantiatedTypes — scope-aware lexical-fq (pffv Task 5)", () => {
  it("Cat.new inside module Zoo → Zoo::Cat", () => {
    const tree = parse(["module Zoo", "  cat = Cat.new", "end"].join("\n"));
    const got = collectRubyInstantiatedTypes(tree.rootNode);
    expect(got).toEqual(["Zoo::Cat"]);
  });

  it("top-level Dog.new → Dog (top-level unchanged)", () => {
    const tree = parse("dog = Dog.new");
    expect(collectRubyInstantiatedTypes(tree.rootNode)).toEqual(["Dog"]);
  });

  it("Zoo::Cat.new written qualified at top level → Zoo::Cat", () => {
    const tree = parse("cat = Zoo::Cat.new");
    expect(collectRubyInstantiatedTypes(tree.rootNode)).toEqual(["Zoo::Cat"]);
  });

  it("two nested modules push scope correctly: module Outer; module Inner; Leaf.new; end; end → Outer::Inner::Leaf", () => {
    const tree = parse(["module Outer", "  module Inner", "    leaf = Leaf.new", "  end", "end"].join("\n"));
    const got = collectRubyInstantiatedTypes(tree.rootNode);
    expect(got).toEqual(["Outer::Inner::Leaf"]);
  });
});

describe("extractFromRubyFile — instantiatedTypes wiring (pffv)", () => {
  it("populates out.instantiatedTypes when trackTypes is on (default)", () => {
    const src = ["user = User.new", "post = Post.find(1)", "n = compute(2)"].join("\n");
    const tree = parse(`${src}\n`);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    expect(r.instantiatedTypes?.sort()).toEqual(["Post", "User"]);
  });

  it("does NOT populate instantiatedTypes when CODEGRAPH_RB_LOCAL_TYPE_TRACKING=false", () => {
    process.env.CODEGRAPH_RB_LOCAL_TYPE_TRACKING = "false";
    try {
      const src = "user = User.new\n";
      const tree = parse(src);
      const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
      expect(r.instantiatedTypes).toBeUndefined();
    } finally {
      delete process.env.CODEGRAPH_RB_LOCAL_TYPE_TRACKING;
    }
  });
});
