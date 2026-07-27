import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import {
  collectYardParamTypes,
  collectYardReturnTypes,
  rubyYardTypeSource,
} from "../../../../../../../src/core/domains/language/ruby/walker/type-sources/yard.js";
import { RubyTypeFactStore } from "../../../../../../../src/core/domains/language/ruby/walker/type-fact-store.js";
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

    it("emits param fact for bracket-first `@param [Type] name` (mastodon/Rails style) — b4rb5", () => {
      const code = ["# @param [Account] account from which to post", "def call(account)", "end"].join("\n");
      const facts = rubyYardTypeSource.extract(makeInput(code));
      expect(facts).toHaveLength(1);
      expect(facts[0]?.name).toBe("account");
      expect(facts[0]?.type).toEqual({ form: "instance", name: "Account" });
      expect(facts[0]?.line).toBe(2);
    });

    it("emits container typeRef for bracket-first `@param [Array<Post>] posts` — b4rb5", () => {
      const code = ["# @param [Array<Post>] posts", "def publish(posts)", "end"].join("\n");
      const facts = rubyYardTypeSource.extract(makeInput(code));
      expect(facts).toHaveLength(1);
      expect(facts[0]?.type).toEqual({ form: "container", element: { form: "instance", name: "Post" } });
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
describe("collectYardParamTypes — accepts both YARD param orders (rvw34)", () => {
  it("parses name-first `@param name [Type]`", () => {
    const code = ["# @param account [Account]", "def call(account)", "end"].join("\n");
    expect(collectYardParamTypes(code).get(2)).toEqual({ account: "Account" });
  });

  it("parses bracket-first `@param [Type] name` (mastodon/Rails style)", () => {
    const code = ["# @param [Account] account from which to post", "def call(account)", "end"].join("\n");
    expect(collectYardParamTypes(code).get(2)).toEqual({ account: "Account" });
  });

  it("reduces a container bracket to its element type (`[Array<Status>] items`)", () => {
    const code = ["# @param [Array<Status>] items", "def call(items)", "end"].join("\n");
    expect(collectYardParamTypes(code).get(2)).toEqual({ items: "Status" });
  });
});

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

// ── @!method directive self-naming (bd tea-rags-mcp-8ypeu) ──────────────────
//
// `# @!method self.call` DOCUMENTS a method the class defines dynamically. Its
// nested `@return` belongs to THAT method, never to whatever `def` happens to
// follow — attaching it to `def initialize` publishes a wrong declared fact at a
// real coordinate, and declared facts beat inference by design.

describe("@!method directive does not leak onto the following def (bd tea-rags-mcp-8ypeu)", () => {
  const taxdomeShape = [
    "class ApplyStatus",
    "  # @!method self.call(firm)",
    "  #   @param firm [Firm]",
    "  #   @return [ServiceResult]",
    "  def initialize(firm)",
    "    @firm = firm",
    "  end",
    "end",
  ].join("\n");

  it("does NOT bind the directive's @return to the following def", () => {
    expect(collectYardReturnTypes(taxdomeShape)).toEqual({});
  });

  it("types the directive's OWN coordinate (self.call → the class's call member)", () => {
    const facts = rubyYardTypeSource.extract(makeInput(taxdomeShape)).filter((f) => f.kind === "return");
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      methodName: "call",
      type: { form: "instance", name: "ServiceResult" },
    });
  });

  it("keys a self.NAME directive at the CLASS coordinate, never the instance one", () => {
    // `def self.call` and `def call` are different methods. Storing the class
    // directive's return under `Class#call` would claim the INSTANCE method
    // returns it — the same wrong-fact-at-a-real-coordinate bug, one level over.
    const store = RubyTypeFactStore.fromFacts(rubyYardTypeSource.extract(makeInput(taxdomeShape)));
    const keys = Object.keys(store.structuredReturnTypesMap());
    expect(keys).toEqual([".call"]); // stub tree → empty scope; the SEPARATOR is the invariant
  });

  it("keys a BARE NAME directive at the instance coordinate", () => {
    const code = ["# @!method render", "#   @return [Fragment]", "def initialize", "end"].join("\n");
    const store = RubyTypeFactStore.fromFacts(rubyYardTypeSource.extract(makeInput(code)));
    expect(Object.keys(store.structuredReturnTypesMap())).toEqual(["#render"]);
  });

  it("attributes the directive's fact to the ENCLOSING class scope", () => {
    // Real tree: the directive sits on a comment line, so its scope comes from
    // the class range, not from a def line.
    const parser = new Parser();
    parser.setLanguage(RbLang as unknown as Parser.Language);
    const input = { ...makeInput(taxdomeShape), tree: parser.parse(taxdomeShape) } as RubyExtractInput;
    const facts = rubyYardTypeSource.extract(input).filter((f) => f.kind === "return");
    expect(facts).toHaveLength(1);
    expect(facts[0]?.symbolScope).toEqual(["ApplyStatus"]);
    expect(facts[0]?.methodName).toBe("call");
  });

  it("types a BARE @!method name as an instance member of the same class", () => {
    const code = [
      "class Widget",
      "  # @!method render",
      "  #   @return [Fragment]",
      "  def initialize",
      "  end",
      "end",
    ].join("\n");
    const facts = rubyYardTypeSource.extract(makeInput(code)).filter((f) => f.kind === "return");
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ methodName: "render", type: { form: "instance", name: "Fragment" } });
    expect(collectYardReturnTypes(code)).toEqual({});
  });

  it("leaves a def with its OWN separate docblock untouched", () => {
    const code = [
      "# @!method self.call(x)",
      "#   @return [Result]",
      "def initialize(x)",
      "end",
      "",
      "# @return [String]",
      "def label",
      "end",
    ].join("\n");
    expect(collectYardReturnTypes(code)).toEqual({ label: "String" });
  });

  it("claims the rest of the block at the directive's OWN indentation (flat shape)", () => {
    // taxdome writes both shapes; `services/billing/invoices/apply_status.rb`
    // — the file this bug was reported from — puts every tag at the directive's
    // own column, so indentation cannot decide ownership.
    const code = [
      "class ApplyStatus",
      "  # @!method self.call(invoice, status, payload)",
      "  # @param invoice [Invoice]",
      "  # @return [KindOfService::Result]",
      "  def initialize(invoice, status, payload = {})",
      "  end",
      "end",
    ].join("\n");
    expect(collectYardReturnTypes(code)).toEqual({});
  });

  it("a bare `#` separator ends the directive's block, so the next tag reaches the def", () => {
    const code = [
      "# @!method self.call(x)",
      "#   @return [Result]",
      "#",
      "# @return [Widget]",
      "def initialize(x)",
      "end",
    ].join("\n");
    expect(collectYardReturnTypes(code)).toEqual({ initialize: "Widget" });
  });

  it("leaves BOTH @param orders working across a directive block", () => {
    const code = [
      "# @!method self.call(firm)",
      "#   @return [ServiceResult]",
      "# @param firm [Firm]",
      "def initialize(firm)",
      "end",
    ].join("\n");
    expect(collectYardParamTypes(code).get(4)).toEqual({ firm: "Firm" });
    const bracketFirst = [
      "# @!method self.call(firm)",
      "#   @return [ServiceResult]",
      "# @param [Firm] firm",
      "def initialize(firm)",
      "end",
    ].join("\n");
    expect(collectYardParamTypes(bracketFirst).get(4)).toEqual({ firm: "Firm" });
  });
});
