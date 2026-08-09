/**
 * `collectRubyAssociationTypes` — the per-class Rails association-TYPE channel
 * (`className → accessorName → modelType`). Distinct from the association-edge
 * CallRef path exercised in `ruby-walker-dsl-edges.test.ts`: that pins the
 * file→file model edge, this builds the receiver-typing MAP the resolver reads
 * to type `event.user`-style accessor chains. The channel funnels through
 * `associationAccessorName` (leading symbol verbatim) + `associationModelConstant`
 * (class_name override OR Rails singularize+camelize convention), so these cases
 * also cover the override branches (string / bare constant / namespaced
 * scope_resolution) and the class-body-form guard.
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { collectRubyAssociationTypes } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";

function assocTypes(src: string): Record<string, Record<string, string>> {
  const parser = new Parser();
  parser.setLanguage(RbLang as unknown as Parser.Language);
  return collectRubyAssociationTypes(parser.parse(src).rootNode);
}

describe("collectRubyAssociationTypes — Rails association type map", () => {
  it("maps has_many/belongs_to accessors to their convention model constants", () => {
    // accessor name is the symbol verbatim (`posts`), model is singularized +
    // camelized (`Post`) — the two derivations differ on purpose.
    expect(assocTypes("class User\n  has_many :posts\n  belongs_to :author\nend\n")).toEqual({
      User: { posts: "Post", author: "Author" },
    });
  });

  it("honours an explicit string `class_name:` override", () => {
    expect(assocTypes("class User\n  belongs_to :author, class_name: 'Writer'\nend\n")).toEqual({
      User: { author: "Writer" },
    });
  });

  it("honours a bare-constant `class_name:` override", () => {
    // `class_name: Writer` (a constant node, not a string literal) — the model
    // is the constant text verbatim.
    expect(assocTypes("class User\n  belongs_to :author, class_name: Writer\nend\n")).toEqual({
      User: { author: "Writer" },
    });
  });

  it("honours a namespaced `class_name:` (scope_resolution) override", () => {
    expect(assocTypes("class User\n  belongs_to :author, class_name: Acme::Writer\nend\n")).toEqual({
      User: { author: "Acme::Writer" },
    });
  });

  it("keys a nested class by its fully-qualified scope name", () => {
    expect(assocTypes("module Blog\n  class Post\n    has_many :comments\n  end\nend\n")).toEqual({
      "Blog::Post": { comments: "Comment" },
    });
  });

  it("returns an empty map for a class with no association macros", () => {
    expect(assocTypes("class Plain\n  def m; end\nend\n")).toEqual({});
  });

  it("ignores a receiver-qualified instance call (`obj.has_many`) — class-body form only", () => {
    expect(assocTypes("class C\n  def m\n    obj.has_many(:x)\n  end\nend\n")).toEqual({});
  });
});

/**
 * Where the walk stops, and why Ruby says so.
 *
 * `has_many` is a class method of `ActiveRecord::Base`. It declares an
 * association only where `self` is the class — which is the class body, and
 * everything a block reaches from it, because a Ruby block keeps the `self` of
 * the scope that wrote it. A `def` body is the one place that is NOT true: at
 * call time `self` is an instance, `has_many` is not in its method table, and a
 * bare `has_many :posts` written there raises NoMethodError or names some
 * unrelated app method. Either way it declares nothing, and typing every
 * `x.posts` in the project off it is a claim the source does not make.
 *
 * `def self.x` is excluded on a second ground: `self` IS the class there, but the
 * macro only runs if something calls that class method, at a time the walker
 * cannot know. The association map types receivers unconditionally, so a
 * conditionally-declared association does not belong in it.
 */
describe("collectRubyAssociationTypes — class-body scope boundary", () => {
  it("does NOT record an association declared inside an instance method body", () => {
    // `self` is an instance when this runs — not the class. Nothing is declared.
    expect(assocTypes("class User\n  def setup\n    has_many :posts\n  end\nend\n")).toEqual({});
  });

  it("does NOT record an association declared inside a `def self.` class method", () => {
    // `self` is the class, but only when someone calls `User.setup` — unknowable
    // statically, so the unconditional type map must not carry it.
    expect(assocTypes("class User\n  def self.setup\n    has_many :posts\n  end\nend\n")).toEqual({});
  });

  it("keeps the class's real associations when a method body also mentions one", () => {
    const src = "class User\n  has_many :posts\n  def setup\n    belongs_to :author\n  end\nend\n";
    expect(assocTypes(src)).toEqual({ User: { posts: "Post" } });
  });

  it("still records an association guarded by a class-body conditional", () => {
    // An `if` in a class body runs at load time with `self` still the class —
    // this is class-body scope and must keep working.
    expect(assocTypes("class User\n  if legacy?\n    has_many :posts\n  end\nend\n")).toEqual({
      User: { posts: "Post" },
    });
  });

  it("still records an association inside a Concern's `included do … end` block", () => {
    // A block carries the enclosing `self`, so the macro genuinely declares here.
    // Attributed to the CONCERN, which every includer reaches through its MRO.
    expect(assocTypes("module Trackable\n  included do\n    has_many :audits\n  end\nend\n")).toEqual({
      Trackable: { audits: "Audit" },
    });
  });
});
