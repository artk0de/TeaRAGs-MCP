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

describe("rubyYardTypeSource — exotic tags", () => {
  describe("@type tag (local var annotation)", () => {
    it("emits local fact for named @type annotation", () => {
      const code = ["# @type [User] x", "x = User.new"].join("\n");
      const facts = rubyYardTypeSource.extract(makeInput(code));
      const localFact = facts.find((f) => f.kind === "local");
      expect(localFact).toBeDefined();
      expect(localFact?.name).toBe("x");
      expect(localFact?.type).toEqual({ form: "instance", name: "User" });
      expect(localFact?.source).toBe("yard");
      expect(localFact?.symbolScope).toEqual([]);
    });

    it("emits local fact at the comment line number (1-based)", () => {
      const code = ["# comment", "# @type [Post] post", "post = Post.new"].join("\n");
      const facts = rubyYardTypeSource.extract(makeInput(code));
      const localFact = facts.find((f) => f.kind === "local");
      expect(localFact).toBeDefined();
      expect(localFact?.line).toBe(2); // 1-based, line 2 is @type comment
    });

    it("emits local fact for qualified constant type", () => {
      const code = ["# @type [Acme::Session] sess", "sess = Acme::Session.new"].join("\n");
      const facts = rubyYardTypeSource.extract(makeInput(code));
      const localFact = facts.find((f) => f.kind === "local");
      expect(localFact?.type).toEqual({ form: "instance", name: "Acme::Session" });
    });

    it("does NOT emit fact for bare @type without name", () => {
      // Conservative: bare @type [User] with no following name → skip
      const code = ["# @type [User]", "x = User.new"].join("\n");
      const facts = rubyYardTypeSource.extract(makeInput(code));
      expect(facts.filter((f) => f.kind === "local")).toHaveLength(0);
    });

    it("does NOT emit fact for @type with lowercase type token", () => {
      const code = ["# @type [string] x", "x = 'hello'"].join("\n");
      const facts = rubyYardTypeSource.extract(makeInput(code));
      expect(facts.filter((f) => f.kind === "local")).toHaveLength(0);
    });

    it("does NOT emit fact for @type without bracket type", () => {
      const code = ["# @type x User", "x = User.new"].join("\n");
      const facts = rubyYardTypeSource.extract(makeInput(code));
      expect(facts.filter((f) => f.kind === "local")).toHaveLength(0);
    });
  });

  describe("@!attribute tag (attribute macro)", () => {
    it("emits attr fact for @!attribute [rw] with paired @return type", () => {
      const code = ["# @!attribute [rw] name", "# @return [String]", ""].join("\n");
      const facts = rubyYardTypeSource.extract(makeInput(code));
      const attrFact = facts.find((f) => f.kind === "attr");
      expect(attrFact).toBeDefined();
      expect(attrFact?.name).toBe("name");
      expect(attrFact?.type).toEqual({ form: "instance", name: "String" });
      expect(attrFact?.source).toBe("yard");
      expect(attrFact?.symbolScope).toEqual([]);
    });

    it("emits attr fact for @!attribute [r] (read-only)", () => {
      const code = ["# @!attribute [r] account", "# @return [Account]", ""].join("\n");
      const facts = rubyYardTypeSource.extract(makeInput(code));
      const attrFact = facts.find((f) => f.kind === "attr");
      expect(attrFact).toBeDefined();
      expect(attrFact?.name).toBe("account");
      expect(attrFact?.type).toEqual({ form: "instance", name: "Account" });
    });

    it("emits attr fact for @!attribute [w] (write-only)", () => {
      const code = ["# @!attribute [w] token", "# @return [String]", ""].join("\n");
      const facts = rubyYardTypeSource.extract(makeInput(code));
      const allAttrFacts = facts.filter((f) => f.kind === "attr");
      expect(allAttrFacts.length).toBeGreaterThanOrEqual(1);
      const tokenFact = allAttrFacts.find((f) => f.name === "token");
      expect(tokenFact?.type).toEqual({ form: "instance", name: "String" });
    });

    it("does NOT emit fact for @!attribute without paired @return", () => {
      const code = ["# @!attribute [rw] name", ""].join("\n");
      const facts = rubyYardTypeSource.extract(makeInput(code));
      expect(facts.filter((f) => f.kind === "attr")).toHaveLength(0);
    });

    it("does NOT emit fact for @!attribute with lowercase @return type", () => {
      const code = ["# @!attribute [rw] status", "# @return [string]", ""].join("\n");
      const facts = rubyYardTypeSource.extract(makeInput(code));
      expect(facts.filter((f) => f.kind === "attr")).toHaveLength(0);
    });
  });

  describe("@!attribute @return ownership — no leak into unrelated def", () => {
    // A @!attribute directive's nested @return documents the (virtual) attribute
    // accessor, NOT the method that happens to follow it. The flat @return →
    // next-def attachment must NOT fabricate a return type for an unrelated def.
    it("does NOT leak @!attribute's @return into a following def of a DIFFERENT name", () => {
      const code = [
        "class Account",
        "  # @!attribute [r] balance",
        "  #   @return [Money]",
        "  def compute_total",
        "    0",
        "  end",
        "end",
      ].join("\n");
      const facts = rubyYardTypeSource.extract(makeInput(code));
      const leaked = facts.find((f) => f.kind === "return" && f.methodName === "compute_total");
      expect(leaked).toBeUndefined();
    });

    it("does NOT leak @!attribute's @return when an attr_accessor would otherwise be skipped past", () => {
      // No intervening non-comment line between the attribute block and the def:
      // the attribute name (owner) differs from the def name → must suppress.
      const code = ["# @!attribute [rw] owner", "#   @return [User]", "def unrelated_helper", "end"].join("\n");
      const facts = rubyYardTypeSource.extract(makeInput(code));
      expect(facts.find((f) => f.kind === "return" && f.methodName === "unrelated_helper")).toBeUndefined();
    });

    it("STILL keys the @return on a reader def of the SAME name as the attribute", () => {
      // `def full_name` IS the attribute reader — its @return is genuinely correct.
      const code = [
        "class Account",
        "  # @!attribute [r] full_name",
        "  #   @return [String]",
        "  def full_name",
        "    'x'",
        "  end",
        "end",
      ].join("\n");
      const facts = rubyYardTypeSource.extract(makeInput(code));
      const reader = facts.find((f) => f.kind === "return" && f.methodName === "full_name");
      expect(reader).toBeDefined();
      expect(reader?.type).toEqual({ form: "instance", name: "String" });
    });

    it("a bare @return (no @!attribute) still attaches to the next def — unchanged", () => {
      const code = ["# @return [Bar]", "def baz", "end"].join("\n");
      const facts = rubyYardTypeSource.extract(makeInput(code));
      const ret = facts.find((f) => f.kind === "return" && f.methodName === "baz");
      expect(ret?.type).toEqual({ form: "instance", name: "Bar" });
    });
  });

  describe("@option tag (hash option annotation)", () => {
    it("emits param fact for @option with typed key", () => {
      const code = ["# @param opts [Hash]", "# @option opts [Integer] :page", "def search(opts = {})", "end"].join(
        "\n",
      );
      const facts = rubyYardTypeSource.extract(makeInput(code));
      const optionFact = facts.find((f) => f.kind === "param" && f.name === "page");
      expect(optionFact).toBeDefined();
      expect(optionFact?.type).toEqual({ form: "instance", name: "Integer" });
      expect(optionFact?.source).toBe("yard");
    });

    it("emits param fact for @option with qualified constant type", () => {
      const code = ["# @option opts [Acme::Filter] :filter", "def search(opts = {})", "end"].join("\n");
      const facts = rubyYardTypeSource.extract(makeInput(code));
      const optionFact = facts.find((f) => f.kind === "param" && f.name === "filter");
      expect(optionFact).toBeDefined();
      expect(optionFact?.type).toEqual({ form: "instance", name: "Acme::Filter" });
    });

    it("does NOT emit option fact for lowercase bracket type", () => {
      const code = ["# @option opts [string] :name", "def search(opts = {})", "end"].join("\n");
      const facts = rubyYardTypeSource.extract(makeInput(code));
      expect(facts.filter((f) => f.kind === "param" && f.name === "name")).toHaveLength(0);
    });

    it("does NOT emit option fact when no bracket type is given", () => {
      const code = ["# @option opts :name description", "def search(opts = {})", "end"].join("\n");
      const facts = rubyYardTypeSource.extract(makeInput(code));
      expect(facts.filter((f) => f.name === "name")).toHaveLength(0);
    });

    it("does not affect existing @param facts when @option is present", () => {
      const code = ["# @param user [User]", "# @option opts [Integer] :page", "def fetch(user, opts = {})", "end"].join(
        "\n",
      );
      const facts = rubyYardTypeSource.extract(makeInput(code));
      const userFact = facts.find((f) => f.kind === "param" && f.name === "user");
      expect(userFact).toBeDefined();
      expect(userFact?.type).toEqual({ form: "instance", name: "User" });
    });
  });

  describe("conservative gating — no spurious emission", () => {
    it("no exotic facts from code with no exotic tags", () => {
      const code = ["# @param user [User]", "# @return [Boolean]", "def save(user)", "end"].join("\n");
      const facts = rubyYardTypeSource.extract(makeInput(code));
      expect(facts.filter((f) => f.kind === "local" || f.kind === "attr")).toHaveLength(0);
    });

    it("no facts from completely unannotated code", () => {
      const code = "def hello\n  puts 'hi'\nend";
      expect(rubyYardTypeSource.extract(makeInput(code))).toHaveLength(0);
    });
  });
});
