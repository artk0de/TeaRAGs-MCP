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
