import { describe, expect, it } from "vitest";

import {
  collectYardReturnTypes,
  rubyYardTypeSource,
} from "../../../../../../../src/core/domains/language/ruby/walker/type-sources/yard.js";
import type { RubyExtractInput } from "../../../../../../../src/core/domains/language/ruby/walker/walker.js";

/** Minimal stub for RubyExtractInput — adapter only uses `code`. */
function makeInput(code: string): RubyExtractInput {
  return {
    code,
    relPath: "test.rb",
    language: "ruby",
    tree: {} as RubyExtractInput["tree"],
    chunks: [],
  };
}

describe("rubyYardTypeSource", () => {
  it("has name 'yard'", () => {
    expect(rubyYardTypeSource.name).toBe("yard");
  });

  describe("@param facts", () => {
    it("emits instance fact for bare constant param", () => {
      const code = ["# @param user [User]", "def process(user)", "  user.save", "end"].join("\n");
      const facts = rubyYardTypeSource.extract(makeInput(code));
      expect(facts).toHaveLength(1);
      const [f] = facts;
      expect(f?.kind).toBe("param");
      expect(f?.name).toBe("user");
      expect(f?.type).toEqual({ form: "instance", name: "User" });
      expect(f?.symbolScope).toEqual([]);
      expect(f?.line).toBe(2);
    });

    it("emits container typeRef for Array<T> param (INFRA-A: full RubyTypeRef)", () => {
      // INFRA-A: yardBracketToRef now receives the raw bracket "Array<Post>" and
      // returns a container RubyTypeRef so the engine can handle element-method dispatch.
      const code = ["# @param posts [Array<Post>]", "def publish(posts)", "end"].join("\n");
      const facts = rubyYardTypeSource.extract(makeInput(code));
      expect(facts).toHaveLength(1);
      expect(facts[0]?.type).toEqual({ form: "container", element: { form: "instance", name: "Post" } });
    });

    it("emits instance fact for qualified constant (Acme::User)", () => {
      const code = ["# @param client [Acme::ApiClient]", "def call(client)", "end"].join("\n");
      const facts = rubyYardTypeSource.extract(makeInput(code));
      expect(facts).toHaveLength(1);
      expect(facts[0]?.type).toEqual({ form: "instance", name: "Acme::ApiClient" });
    });

    it("ignores lowercase-token param types", () => {
      const code = ["# @param name [string]", "def greet(name)", "end"].join("\n");
      const facts = rubyYardTypeSource.extract(makeInput(code));
      expect(facts).toHaveLength(0);
    });

    it("emits union typeRef for comma-separated param types (INFRA-A)", () => {
      const code = ["# @param val [String, Integer]", "def set(val)", "end"].join("\n");
      // INFRA-A: unions now emit a fact with {form:"union", members:[...]}.
      const facts = rubyYardTypeSource.extract(makeInput(code));
      expect(facts).toHaveLength(1);
      expect(facts[0]?.type).toEqual({
        form: "union",
        members: [
          { form: "instance", name: "String" },
          { form: "instance", name: "Integer" },
        ],
      });
    });
  });

  describe("@return facts", () => {
    it("emits return fact for bare constant", () => {
      const code = ["# @return [User]", "def current_user", "  @user", "end"].join("\n");
      const facts = rubyYardTypeSource.extract(makeInput(code));
      expect(facts).toHaveLength(1);
      const [f] = facts;
      expect(f?.kind).toBe("return");
      expect(f?.methodName).toBe("current_user");
      expect(f?.type).toEqual({ form: "instance", name: "User" });
      expect(f?.symbolScope).toEqual([]);
    });

    it("does NOT unwrap container return types (single-instance discipline)", () => {
      // @return [Array<Post>] should NOT emit a fact (collection, not dispatch target)
      const code = ["# @return [Array<Post>]", "def all_posts", "end"].join("\n");
      const facts = rubyYardTypeSource.extract(makeInput(code));
      expect(facts).toHaveLength(0);
    });

    it("ignores @return with lowercase type", () => {
      const code = ["# @return [void]", "def setup", "end"].join("\n");
      const facts = rubyYardTypeSource.extract(makeInput(code));
      expect(facts).toHaveLength(0);
    });
  });

  describe("mixed param and return", () => {
    it("collects both param and return facts from the same method", () => {
      const code = ["# @param record [ActiveRecord::Base]", "# @return [Boolean]", "def save(record)", "end"].join(
        "\n",
      );
      const facts = rubyYardTypeSource.extract(makeInput(code));
      const paramFact = facts.find((f) => f.kind === "param");
      const returnFact = facts.find((f) => f.kind === "return");
      expect(paramFact?.type).toEqual({ form: "instance", name: "ActiveRecord::Base" });
      expect(returnFact?.type).toEqual({ form: "instance", name: "Boolean" });
    });
  });

  it("returns empty array for code with no YARD annotations", () => {
    const code = "def hello\n  puts 'hi'\nend";
    expect(rubyYardTypeSource.extract(makeInput(code))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// collectYardReturnTypes — exported twin (dead path in extract(), tested directly)
// ---------------------------------------------------------------------------
// This exported function mirrors the @return scanning logic of collectYardReturnFacts
// but produces a plain `{ methodName → typeName }` map. The new @!attribute guard
// (`seenAttrName` / `pendingAttrOwner`) was added here in the same commit that added
// it to collectYardReturnFacts, so these tests cover both the guard code AND the
// basic function body that no other test exercised.
describe("collectYardReturnTypes", () => {
  it("maps @return [Type] to the following def name", () => {
    const code = ["# @return [User]", "def current_user", "  @user", "end"].join("\n");
    expect(collectYardReturnTypes(code)).toEqual({ current_user: "User" });
  });

  it("ignores collection @return types (Array<T> is not a dispatch target)", () => {
    const code = ["# @return [Array<User>]", "def all_users", "end"].join("\n");
    expect(collectYardReturnTypes(code)).toEqual({});
  });

  it("ignores lowercase @return types", () => {
    const code = ["# @return [void]", "def setup", "end"].join("\n");
    expect(collectYardReturnTypes(code)).toEqual({});
  });

  it("maps multiple @return annotations to their respective def names", () => {
    const code = ["# @return [User]", "def current_user", "end", "# @return [Post]", "def latest_post", "end"].join(
      "\n",
    );
    expect(collectYardReturnTypes(code)).toEqual({ current_user: "User", latest_post: "Post" });
  });

  it("@!attribute [r] name + @return [Type] + matching def binds the return (attr reader)", () => {
    // The @!attribute guard: a @return nested under @!attribute attaches only to
    // the same-named reader def. This covers seenAttrName / pendingAttrOwner branches.
    const code = [
      "# @!attribute [r] title",
      "# @return [String]",
      "def title", // pendingAttrOwner === "title" === defMatch[1] → binds
      "end",
    ].join("\n");
    expect(collectYardReturnTypes(code)).toEqual({ title: "String" });
  });

  it("@!attribute [r] name + @return [Type] + non-matching def does NOT bind", () => {
    // The attr guard blocks the return from attaching to a def with a different name.
    const code = [
      "# @!attribute [r] email",
      "# @return [String]",
      "def build_url", // pendingAttrOwner === "email" !== "build_url" → skipped
      "end",
    ].join("\n");
    expect(collectYardReturnTypes(code)).toEqual({});
  });

  it("after @!attribute + matching def, subsequent plain @return is unguarded", () => {
    const code = [
      "# @!attribute [r] name",
      "# @return [String]",
      "def name", // attr reader — binds
      "end",
      "# @return [Integer]",
      "def count", // no @!attribute guard → plain bind
      "end",
    ].join("\n");
    expect(collectYardReturnTypes(code)).toEqual({ name: "String", count: "Integer" });
  });

  it("@!attribute with rw mode is also recognized", () => {
    const code = ["# @!attribute [rw] status", "# @return [Symbol]", "def status", "end"].join("\n");
    expect(collectYardReturnTypes(code)).toEqual({ status: "Symbol" });
  });

  it("qualified constant @return type (Acme::Post) is recorded", () => {
    const code = ["# @return [Acme::Post]", "def find_post", "end"].join("\n");
    expect(collectYardReturnTypes(code)).toEqual({ find_post: "Acme::Post" });
  });

  it("blank lines and non-YARD comments between @return and def are tolerated", () => {
    const code = ["# @return [Order]", "", "# Plain comment — not a YARD tag.", "def current_order", "end"].join("\n");
    expect(collectYardReturnTypes(code)).toEqual({ current_order: "Order" });
  });

  it("returns empty map for code with no annotations", () => {
    expect(collectYardReturnTypes("def hello; end")).toEqual({});
  });
});
