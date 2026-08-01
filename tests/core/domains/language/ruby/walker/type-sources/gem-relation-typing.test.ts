/**
 * Gem-gated RELATION vocabulary at walk time (bd tea-rags-mcp-lo9u2). A gem that
 * adds query verbs to `ActiveRecord::Relation` extends the chain the AST
 * type-source walks: `Post.page(1).per(20)` is still a relation OF Post, and
 * `Post.page(1).first` is still a Post. The `relationReturning` facet is what
 * states that, and `catalogueForGemfile(input.gemfileContent)` is what gates it —
 * a project without the gem infers nothing from the same source.
 *
 * These are END-TO-END through `rubyAstInferenceTypeSource`, not facet-membership
 * assertions (those live in `dsl/catalogue-gating.test.ts`): the fact the codegraph
 * consumes is the emitted `RubyTypeFact`, so that is what is pinned here.
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { rubyAstInferenceTypeSource } from "../../../../../../../src/core/domains/language/ruby/walker/type-sources/ast-inference.js";
import type { RubyExtractInput } from "../../../../../../../src/core/domains/language/ruby/walker/walker.js";

function makeInput(code: string, gemfileContent?: string): RubyExtractInput {
  const parser = new Parser();
  parser.setLanguage(RbLang as unknown as Parser.Language);
  return { tree: parser.parse(code), code, relPath: "test.rb", language: "ruby", chunks: [], gemfileContent };
}

const typeOf = (code: string, gemfile?: string): unknown =>
  rubyAstInferenceTypeSource.extract(makeInput(code, gemfile))[0]?.type;

const containerOf = (name: string): unknown => ({ form: "container", element: { form: "instance", name } });

describe("kaminari pagination chains — gem-gated relation typing", () => {
  const PAGE_CHAIN = "def call\n  posts = Post.page(1).per(20)\nend\n";

  it("`Post.page(1).per(20)` binds a relation OF Post when kaminari is declared", () => {
    expect(typeOf(PAGE_CHAIN, "gem 'kaminari'")).toEqual(containerOf("Post"));
  });

  it("the same chain binds NOTHING when the project's Gemfile lacks kaminari", () => {
    expect(rubyAstInferenceTypeSource.extract(makeInput(PAGE_CHAIN, "gem 'rails'"))).toHaveLength(0);
  });

  it("a terminal instance verb on a paginated relation still yields the model instance", () => {
    const code = "def call\n  post = Post.page(1).first\nend\n";
    expect(typeOf(code, "gem 'kaminari'")).toEqual({ form: "instance", name: "Post" });
  });

  it("pagination composes with the Rails query verbs in one chain", () => {
    const code = "def call\n  posts = Post.where(active: true).page(2).padding(5)\nend\n";
    expect(typeOf(code, "gem 'kaminari'")).toEqual(containerOf("Post"));
  });

  it("FULL catalogue (no Gemfile) keeps the pagination grammar active — byte-neutral", () => {
    expect(typeOf(PAGE_CHAIN)).toEqual(containerOf("Post"));
  });
});
