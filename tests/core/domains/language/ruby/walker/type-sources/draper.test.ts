/**
 * adx5p.9 — draper decorated-model return-type source.
 *
 * A Draper decorator wraps one model and exposes it as `object` / `model`.
 * `delegate_all` opts the class into forwarding every undefined method to that
 * wrapped instance, which is exactly the statement "this class decorates a
 * model" — the model itself is named by the class (`UserDecorator` → `User`) or
 * explicitly by `decorates :article`.
 *
 * The source emits `kind:"return"` facts for `object` / `model` so a call like
 * `object.full_name` inside the decorator resolves onto the MODEL's method
 * rather than staying untyped.
 *
 * Precision gates (SILENCE — never fabricate): a class that opts into neither
 * `delegate_all` nor `decorates` emits nothing, and a class whose name carries
 * no `Decorator` suffix has no model to infer.
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { rubyDraperTypeSource } from "../../../../../../../src/core/domains/language/ruby/walker/type-sources/draper.js";
import type { RubyExtractInput } from "../../../../../../../src/core/domains/language/ruby/walker/walker.js";

function parse(src: string) {
  const parser = new Parser();
  parser.setLanguage(RbLang as unknown as Parser.Language);
  return parser.parse(src);
}

function makeInput(code: string, gemfileContent?: string): RubyExtractInput {
  return { code, relPath: "app/decorators/x.rb", language: "ruby", tree: parse(code), chunks: [], gemfileContent };
}

/** Return facts the source emits for `code`. */
function returnFacts(code: string, gemfileContent?: string) {
  return rubyDraperTypeSource.extract(makeInput(code, gemfileContent)).filter((f) => f.kind === "return");
}

describe("rubyDraperTypeSource — delegate_all decorators", () => {
  it("types `object` and `model` as an instance of the decorated model", () => {
    const facts = returnFacts(["class UserDecorator < Draper::Decorator", "  delegate_all", "end"].join("\n"));
    expect(facts).toContainEqual(
      expect.objectContaining({
        kind: "return",
        source: "draper",
        symbolScope: ["UserDecorator"],
        methodName: "object",
        type: { form: "instance", name: "User" },
      }),
    );
    expect(facts).toContainEqual(
      expect.objectContaining({ methodName: "model", type: { form: "instance", name: "User" } }),
    );
  });

  it("strips only the `Decorator` suffix from a multi-word decorator name", () => {
    const facts = returnFacts(["class BlogPostDecorator < Draper::Decorator", "  delegate_all", "end"].join("\n"));
    expect(facts.map((f) => f.type)).toContainEqual({ form: "instance", name: "BlogPost" });
  });

  it("attributes facts to the FULL lexical scope of a namespaced decorator", () => {
    const src = [
      "module Admin",
      "  class UserDecorator < Draper::Decorator",
      "    delegate_all",
      "  end",
      "end",
    ].join("\n");
    const facts = returnFacts(src);
    expect(facts[0]?.symbolScope).toEqual(["Admin", "UserDecorator"]);
    expect(facts[0]?.type).toEqual({ form: "instance", name: "User" });
  });

  it("an explicit `decorates :article` wins over the class-name inflection", () => {
    const src = ["class ProfileDecorator < Draper::Decorator", "  decorates :article", "  delegate_all", "end"].join(
      "\n",
    );
    expect(returnFacts(src).map((f) => f.type)).toContainEqual({ form: "instance", name: "Article" });
  });

  it("`decorates` alone (no delegate_all) still names the decorated model", () => {
    const src = ["class ProfileDecorator < Draper::Decorator", "  decorates :article", "end"].join("\n");
    expect(returnFacts(src).map((f) => f.type)).toContainEqual({ form: "instance", name: "Article" });
  });
});

describe("rubyDraperTypeSource — silence", () => {
  it("emits NOTHING for a class that opts into neither delegate_all nor decorates", () => {
    expect(returnFacts(["class UserDecorator", "  def object", "  end", "end"].join("\n"))).toEqual([]);
  });

  it("emits NOTHING when the class name carries no `Decorator` suffix and nothing is declared", () => {
    expect(returnFacts(["class UserPresenter < Draper::Decorator", "  delegate_all", "end"].join("\n"))).toEqual([]);
  });

  it("emits NOTHING when the project does not declare draper (gem-gated grammar)", () => {
    const src = ["class UserDecorator < Draper::Decorator", "  delegate_all", "end"].join("\n");
    expect(returnFacts(src, 'gem "rails"\n')).toEqual([]);
  });

  it("emits the facts when the project DOES declare draper", () => {
    const src = ["class UserDecorator < Draper::Decorator", "  delegate_all", "end"].join("\n");
    expect(returnFacts(src, 'gem "rails"\ngem "draper"\n').map((f) => f.type)).toContainEqual({
      form: "instance",
      name: "User",
    });
  });

  it("does not leak the outer decorator's model into a NESTED class", () => {
    const src = [
      "class UserDecorator < Draper::Decorator",
      "  delegate_all",
      "  class Inner",
      "  end",
      "end",
    ].join("\n");
    for (const fact of returnFacts(src)) expect(fact.symbolScope).toEqual(["UserDecorator"]);
  });
});
