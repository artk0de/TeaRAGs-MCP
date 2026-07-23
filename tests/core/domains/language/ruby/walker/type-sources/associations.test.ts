/**
 * G1a — ActiveRecord association / scope return-type source.
 *
 * `walker/type-sources/associations.ts` reads the SAME class-body macro
 * invocations the codegraph already parses and emits `kind:"return"` facts so
 * `firm.owner` / `firm.employees` / `Post.active` receivers get a static type:
 *
 *   - `belongs_to` / `has_one`  → INSTANCE of the associated model
 *   - `has_many` / `habtm`      → CONTAINER of the associated model (a relation)
 *   - `scope`                   → CONTAINER of the ENCLOSING model (a relation)
 *
 * Precision gates (SILENCE — never fabricate): `polymorphic: true` and a
 * non-literal `class_name:` emit NO fact. `class_name:` literal wins over
 * inflection; YARD `@return` wins over an association of the same name.
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { RubyTypeFactStore } from "../../../../../../../src/core/domains/language/ruby/walker/type-fact-store.js";
import { rubyAssociationTypeSource } from "../../../../../../../src/core/domains/language/ruby/walker/type-sources/associations.js";
import { rubyYardTypeSource } from "../../../../../../../src/core/domains/language/ruby/walker/type-sources/yard.js";
import {
  extractFromRubyFile,
  type RubyExtractInput,
} from "../../../../../../../src/core/domains/language/ruby/walker/walker.js";

function parse(src: string) {
  const parser = new Parser();
  parser.setLanguage(RbLang as unknown as Parser.Language);
  return parser.parse(src);
}

function makeInput(code: string): RubyExtractInput {
  return { code, relPath: "test.rb", language: "ruby", tree: parse(code), chunks: [] };
}

/** All return facts the source emits for `code`, keyed by accessor method name. */
function returnFacts(code: string) {
  return rubyAssociationTypeSource.extract(makeInput(code)).filter((f) => f.kind === "return");
}

describe("rubyAssociationTypeSource — singular associations (belongs_to / has_one)", () => {
  it("belongs_to with class_name literal → instance of the literal model (class_name wins)", () => {
    const facts = returnFacts(['class Firm', '  belongs_to :owner, class_name: "User"', 'end'].join("\n"));
    const owner = facts.find((f) => f.methodName === "owner");
    expect(owner?.symbolScope).toEqual(["Firm"]);
    expect(owner?.type).toEqual({ form: "instance", name: "User" });
  });

  it("belongs_to without class_name → instance of the inflected (camelized) model", () => {
    const facts = returnFacts(["class Account", "  belongs_to :firm", "end"].join("\n"));
    expect(facts.find((f) => f.methodName === "firm")?.type).toEqual({ form: "instance", name: "Firm" });
  });

  it("has_one → instance of the inflected model", () => {
    const facts = returnFacts(["class User", "  has_one :profile", "end"].join("\n"));
    expect(facts.find((f) => f.methodName === "profile")?.type).toEqual({ form: "instance", name: "Profile" });
  });
});

describe("rubyAssociationTypeSource — collection associations (has_many / habtm)", () => {
  it("has_many → container(model) with singularize+camelize element", () => {
    const facts = returnFacts(["class Firm", "  has_many :employees", "end"].join("\n"));
    expect(facts.find((f) => f.methodName === "employees")?.type).toEqual({
      form: "container",
      element: { form: "instance", name: "Employee" },
    });
  });

  it("has_and_belongs_to_many → container(model)", () => {
    const facts = returnFacts(["class Post", "  has_and_belongs_to_many :tags", "end"].join("\n"));
    expect(facts.find((f) => f.methodName === "tags")?.type).toEqual({
      form: "container",
      element: { form: "instance", name: "Tag" },
    });
  });

  it("has_many :through → container of the association's OWN model (through ignored for target)", () => {
    const facts = returnFacts(["class User", "  has_many :comments, through: :posts", "end"].join("\n"));
    expect(facts.find((f) => f.methodName === "comments")?.type).toEqual({
      form: "container",
      element: { form: "instance", name: "Comment" },
    });
  });
});

describe("rubyAssociationTypeSource — scope", () => {
  it("scope → container of the ENCLOSING model (self relation)", () => {
    const facts = returnFacts(["class Post", "  scope :active, -> { where(active: true) }", "end"].join("\n"));
    const active = facts.find((f) => f.methodName === "active");
    expect(active?.symbolScope).toEqual(["Post"]);
    expect(active?.type).toEqual({ form: "container", element: { form: "instance", name: "Post" } });
  });

  it("scope in a nested model → container of the fully-qualified enclosing model", () => {
    const facts = returnFacts(
      ["module Acme", "  class Post", "    scope :recent, -> { order(:id) }", "  end", "end"].join("\n"),
    );
    expect(facts.find((f) => f.methodName === "recent")?.type).toEqual({
      form: "container",
      element: { form: "instance", name: "Acme::Post" },
    });
  });
});

describe("rubyAssociationTypeSource — silence gates (precision, never fabricate)", () => {
  it("polymorphic: true → NO fact", () => {
    const facts = returnFacts(["class Comment", "  belongs_to :owner, polymorphic: true", "end"].join("\n"));
    expect(facts.find((f) => f.methodName === "owner")).toBeUndefined();
  });

  it("non-literal class_name (an expression, not a string/constant) → NO fact", () => {
    const facts = returnFacts(["class Firm", "  belongs_to :owner, class_name: owner_class", "end"].join("\n"));
    expect(facts.find((f) => f.methodName === "owner")).toBeUndefined();
  });
});

describe("rubyAssociationTypeSource — concern included-do attribution (ancestor lookup)", () => {
  it("association inside `included do` attributes the fact to the CONCERN, not the includer", () => {
    const code = [
      "module Trackable",
      "  extend ActiveSupport::Concern",
      "  included do",
      '    belongs_to :owner, class_name: "User"',
      "  end",
      "end",
    ].join("\n");
    const facts = returnFacts(code);
    const owner = facts.find((f) => f.methodName === "owner");
    expect(owner?.symbolScope).toEqual(["Trackable"]);
    // Store surfaces it as a `Concern#member` key the resolver reaches via
    // the includer's ancestor MRO (classAncestors[includer] contains Trackable).
    const map = RubyTypeFactStore.fromFacts(facts).structuredReturnTypesMap();
    expect(map["Trackable#owner"]).toEqual({ form: "instance", name: "User" });
  });
});

describe("rubyAssociationTypeSource — store precedence (YARD > associations)", () => {
  it("a YARD @return of the same name wins over the association's inflected type", () => {
    const code = [
      "class Firm",
      "  # @return [Admin]",
      "  def owner; end",
      '  belongs_to :owner, class_name: "User"',
      "end",
    ].join("\n");
    const input = makeInput(code);
    const facts = [...rubyYardTypeSource.extract(input), ...rubyAssociationTypeSource.extract(input)];
    const map = RubyTypeFactStore.fromFacts(facts).structuredReturnTypesMap();
    // YARD annotation beats association inflection.
    expect(map["Firm#owner"]).toEqual({ form: "instance", name: "Admin" });
  });

  it("emits facts tagged with the `associations` source", () => {
    const facts = returnFacts(["class Account", "  belongs_to :firm", "end"].join("\n"));
    expect(facts.find((f) => f.methodName === "firm")?.source).toBe("associations");
  });
});

describe("rubyAssociationTypeSource — registered in the inline source pipeline", () => {
  it("extractFromRubyFile surfaces association return types in structuredReturnTypes end-to-end", () => {
    const code = [
      "class Firm",
      '  belongs_to :owner, class_name: "User"',
      "  has_many :employees",
      "end",
    ].join("\n");
    const r = extractFromRubyFile({ tree: parse(code), code, relPath: "app/models/firm.rb", language: "ruby", chunks: [] });
    expect(r.structuredReturnTypes?.["Firm#owner"]).toEqual({ form: "instance", name: "User" });
    expect(r.structuredReturnTypes?.["Firm#employees"]).toEqual({
      form: "container",
      element: { form: "instance", name: "Employee" },
    });
  });
});
