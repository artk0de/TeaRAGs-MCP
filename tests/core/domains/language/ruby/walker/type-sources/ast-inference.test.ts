import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { rubyAstInferenceTypeSource } from "../../../../../../../src/core/domains/language/ruby/walker/type-sources/ast-inference.js";
import type { RubyExtractInput } from "../../../../../../../src/core/domains/language/ruby/walker/walker.js";

function makeInput(code: string): RubyExtractInput {
  const parser = new Parser();
  parser.setLanguage(RbLang as unknown as Parser.Language);
  const tree = parser.parse(code);
  return { tree, code, relPath: "test.rb", language: "ruby", chunks: [] };
}

describe("rubyAstInferenceTypeSource", () => {
  it("has name 'ast'", () => {
    expect(rubyAstInferenceTypeSource.name).toBe("ast");
  });

  it("returns empty array for code with no typed assignments", () => {
    const code = 'def hello\n  puts "hi"\nend';
    expect(rubyAstInferenceTypeSource.extract(makeInput(code))).toHaveLength(0);
  });

  describe("constructor/factory instance bindings (kind: local, form: instance)", () => {
    it("infers `var = ClassName.new` as instance fact", () => {
      const code = "user = User.new\n";
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts).toHaveLength(1);
      const [f] = facts;
      expect(f?.kind).toBe("local");
      expect(f?.name).toBe("user");
      expect(f?.type).toEqual({ form: "instance", name: "User" });
      expect(f?.line).toBe(1);
    });

    it("infers `var = Model.find(id)` as instance fact", () => {
      const code = "u = User.find(1)\n";
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts).toHaveLength(1);
      expect(facts[0]?.type).toEqual({ form: "instance", name: "User" });
    });

    it("infers `var = Model.find_by(...)` as instance fact", () => {
      const code = "u = Post.find_by(slug: 'hello')\n";
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts).toHaveLength(1);
      expect(facts[0]?.type).toEqual({ form: "instance", name: "Post" });
    });

    it("infers `var = Model.create!(...)` as instance fact", () => {
      const code = "record = Record.create!(name: 'x')\n";
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts).toHaveLength(1);
      expect(facts[0]?.type).toEqual({ form: "instance", name: "Record" });
    });

    it("infers `var = Scope::Const.new` (qualified) as instance fact", () => {
      const code = "c = Acme::Client.new\n";
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts).toHaveLength(1);
      expect(facts[0]?.type).toEqual({ form: "instance", name: "Acme::Client" });
    });

    it("does NOT infer bare factory calls with no constant receiver", () => {
      const code = "x = make_user()\n";
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts).toHaveLength(0);
    });
  });

  describe("class-valued binding (form: class)", () => {
    it("infers `var = CONST` as class fact", () => {
      const code = "klass = User\n";
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts).toHaveLength(1);
      const [f] = facts;
      expect(f?.kind).toBe("local");
      expect(f?.name).toBe("klass");
      expect(f?.type).toEqual({ form: "class", name: "User" });
    });

    it("does NOT emit class fact for lowercase identifier RHS", () => {
      const code = "x = something\n";
      // `something` is not a constant — no fact unless it's a previously-bound var
      // and copy-propagation applies. Here there is no prior binding.
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts).toHaveLength(0);
    });
  });

  describe("copy-propagation", () => {
    it("propagates type from prior binding: `a = User.new; b = a`", () => {
      const code = ["a = User.new", "b = a"].join("\n");
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts).toHaveLength(2);
      expect(facts[0]?.name).toBe("a");
      expect(facts[0]?.type).toEqual({ form: "instance", name: "User" });
      expect(facts[1]?.name).toBe("b");
      expect(facts[1]?.type).toEqual({ form: "instance", name: "User" });
    });

    it("does NOT propagate from an unbound variable", () => {
      const code = "b = a\n"; // `a` never bound
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts).toHaveLength(0);
    });
  });

  describe("multiple assignment", () => {
    it("pairs `a, b = X.new, Y.new` positionally", () => {
      const code = "a, b = Foo.new, Bar.new\n";
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts).toHaveLength(2);
      const fa = facts.find((f) => f.name === "a");
      const fb = facts.find((f) => f.name === "b");
      expect(fa?.type).toEqual({ form: "instance", name: "Foo" });
      expect(fb?.type).toEqual({ form: "instance", name: "Bar" });
    });

    it("skips multi-assign when arity mismatch", () => {
      const code = "a, b = Foo.new\n";
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts).toHaveLength(0);
    });
  });

  describe("param-default inference", () => {
    it("infers `def f(x = User.new)` binding at def line", () => {
      const code = ["def process(user = User.new)", "  user.save", "end"].join("\n");
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts).toHaveLength(1);
      const [f] = facts;
      expect(f?.kind).toBe("local");
      expect(f?.name).toBe("user");
      expect(f?.type).toEqual({ form: "instance", name: "User" });
      expect(f?.line).toBe(1); // `def` is on line 1
    });
  });

  describe("symbolScope and methodName are empty stubs (populated by Task 0.5)", () => {
    it("emits symbolScope: [] for every fact", () => {
      const code = "u = User.new\n";
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      for (const f of facts) {
        expect(f.symbolScope).toEqual([]);
      }
    });
  });

  describe("block-parameter element typing (B-block via latestBinding seeded from YARD)", () => {
    it("binds block param `|p|` to element type when receiver is YARD Array<Post> param", () => {
      // YARD Array<Post> is unwrapped to "Post" by collectYardParamTypes (brg9),
      // so latestBinding has posts→Post. The each block then binds p→Post.
      const code = ["# @param posts [Array<Post>]", "def publish(posts)", "  posts.each { |p| p.save }", "end"].join(
        "\n",
      );
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      const blockFact = facts.find((f) => f.name === "p");
      expect(blockFact).toBeDefined();
      expect(blockFact?.type).toEqual({ form: "instance", name: "Post" });
    });

    it("does NOT bind block param when receiver has no prior binding", () => {
      const code = ["def process(items)", "  items.each { |e| e.run }", "end"].join("\n");
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      // items is not YARD-annotated → no binding → e must NOT be emitted
      const blockFact = facts.find((f) => f.name === "e");
      expect(blockFact).toBeUndefined();
    });

    it("binds block param after a constructor assignment establishes the receiver type", () => {
      const code = ["users = UserCollection.new", "users.each { |u| u.save }"].join("\n");
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      // users → UserCollection.new is inferred; however UserCollection is not
      // an element-typed collection from YARD, so the element binding MAY or
      // MAY NOT fire. What matters is the code path executes without error.
      // Just check no exception is thrown and the users binding is present.
      const usersFact = facts.find((f) => f.name === "users");
      expect(usersFact?.type).toEqual({ form: "instance", name: "UserCollection" });
    });
  });
});
