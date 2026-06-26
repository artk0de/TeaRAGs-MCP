import { describe, expect, it } from "vitest";

import { rubyYardTypeSource } from "../../../../../../../src/core/domains/language/ruby/walker/type-sources/yard.js";
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
