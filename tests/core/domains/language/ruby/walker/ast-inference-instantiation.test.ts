import Parser from "tree-sitter";
import Ruby from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { collectRubyInstantiationSites } from "../../../../../../src/core/domains/language/ruby/walker/type-sources/ast-inference.js";
import { extractFromRubyFile } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";

function parse(code: string): Parser.Tree {
  const p = new Parser();
  p.setLanguage(Ruby);
  return p.parse(code);
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

describe("collectRubyInstantiationSites", () => {
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
    const got = collectRubyInstantiationSites(tree.rootNode).sort(byName);
    expect(got).toEqual([
      { name: "Account", nesting: [], rootAnchored: false },
      { name: "Comment", nesting: [], rootAnchored: false },
      { name: "Post", nesting: [], rootAnchored: false },
      { name: "User", nesting: [], rootAnchored: false },
    ]);
  });

  it("returns [] when nothing is instantiated", () => {
    const tree = parse("x = compute(1)\ny = x + 2\n");
    expect(collectRubyInstantiationSites(tree.rootNode)).toEqual([]);
  });
});

// bd tea-rags-mcp-0qaht.65: the walker no longer pre-qualifies a constant by its
// lexical scope (that guessed `Zoo::Cat` for a top-level `Cat` and doubled a
// written qualifier); it records the site as Ruby's constant lookup sees it,
// and the barrier resolves it against the declared set.
describe("collectRubyInstantiationSites — lexical sites (bd 0qaht.65)", () => {
  it("Cat.new inside module Zoo → name Cat, nesting [Zoo]", () => {
    const tree = parse(["module Zoo", "  cat = Cat.new", "end"].join("\n"));
    expect(collectRubyInstantiationSites(tree.rootNode)).toEqual([
      { name: "Cat", nesting: ["Zoo"], rootAnchored: false },
    ]);
  });

  it("top-level Dog.new → name Dog, empty nesting", () => {
    const tree = parse("dog = Dog.new");
    expect(collectRubyInstantiationSites(tree.rootNode)).toEqual([{ name: "Dog", nesting: [], rootAnchored: false }]);
  });

  it("Zoo::Cat.new written qualified at top level → the qualified name as written", () => {
    const tree = parse("cat = Zoo::Cat.new");
    expect(collectRubyInstantiationSites(tree.rootNode)).toEqual([
      { name: "Zoo::Cat", nesting: [], rootAnchored: false },
    ]);
  });

  it("nested modules give the nesting innermost-first, each level fully qualified", () => {
    const tree = parse(["module Outer", "  module Inner", "    leaf = Leaf.new", "  end", "end"].join("\n"));
    expect(collectRubyInstantiationSites(tree.rootNode)).toEqual([
      { name: "Leaf", nesting: ["Outer::Inner", "Outer"], rootAnchored: false },
    ]);
  });

  it("::Cat.new inside module Zoo keeps the root anchor", () => {
    const tree = parse(["module Zoo", "  cat = ::Cat.new", "end"].join("\n"));
    expect(collectRubyInstantiationSites(tree.rootNode)).toEqual([
      { name: "Cat", nesting: ["Zoo"], rootAnchored: true },
    ]);
  });

  it("a compact `class A::B` is ONE nesting level", () => {
    const tree = parse(["class A::B", "  def run", "    X.new", "  end", "end"].join("\n"));
    expect(collectRubyInstantiationSites(tree.rootNode)).toEqual([
      { name: "X", nesting: ["A::B"], rootAnchored: false },
    ]);
  });

  it("a compact name inside a module composes under it as one level", () => {
    const tree = parse(["module Outer", "  class Inner::Leaf", "    X.new", "  end", "end"].join("\n"));
    expect(collectRubyInstantiationSites(tree.rootNode)).toEqual([
      { name: "X", nesting: ["Outer::Inner::Leaf", "Outer"], rootAnchored: false },
    ]);
  });

  it("graphql shape: a written qualifier is kept as written, never prefixed by the nesting", () => {
    const tree = parse(
      [
        "module GraphQL",
        "  class Schema",
        "    def fail!",
        "      GraphQL::ExecutionError.new('x')",
        "    end",
        "  end",
        "end",
      ].join("\n"),
    );
    expect(collectRubyInstantiationSites(tree.rootNode)).toEqual([
      { name: "GraphQL::ExecutionError", nesting: ["GraphQL::Schema", "GraphQL"], rootAnchored: false },
    ]);
  });

  it("mastodon shape: a constant inside a class is an unqualified site, not ClassName::Const", () => {
    const tree = parse(
      [
        "class SuspendAccountService < BaseService",
        "  def call",
        "    AccountReachFinder.new(@account)",
        "  end",
        "end",
      ].join("\n"),
    );
    expect(collectRubyInstantiationSites(tree.rootNode)).toEqual([
      { name: "AccountReachFinder", nesting: ["SuspendAccountService"], rootAnchored: false },
    ]);
  });

  it("the same name at two nestings is two sites", () => {
    const tree = parse(["Cat.new", "module Zoo", "  Cat.new", "end"].join("\n"));
    expect(collectRubyInstantiationSites(tree.rootNode)).toEqual([
      { name: "Cat", nesting: [], rootAnchored: false },
      { name: "Cat", nesting: ["Zoo"], rootAnchored: false },
    ]);
  });
});

describe("extractFromRubyFile — rubyInstantiationSites wiring (bd 0qaht.65)", () => {
  it("populates out.rubyInstantiationSites when trackTypes is on (default), and no pre-qualified instantiatedTypes", () => {
    const src = ["user = User.new", "post = Post.find(1)", "n = compute(2)"].join("\n");
    const tree = parse(`${src}\n`);
    const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
    expect([...(r.rubyInstantiationSites ?? [])].sort(byName)).toEqual([
      { name: "Post", nesting: [], rootAnchored: false },
      { name: "User", nesting: [], rootAnchored: false },
    ]);
    expect(r.instantiatedTypes).toBeUndefined();
  });

  it("does NOT populate rubyInstantiationSites when CODEGRAPH_RB_LOCAL_TYPE_TRACKING=false", () => {
    process.env.CODEGRAPH_RB_LOCAL_TYPE_TRACKING = "false";
    try {
      const src = "user = User.new\n";
      const tree = parse(src);
      const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks: [] });
      expect(r.rubyInstantiationSites).toBeUndefined();
    } finally {
      delete process.env.CODEGRAPH_RB_LOCAL_TYPE_TRACKING;
    }
  });
});
