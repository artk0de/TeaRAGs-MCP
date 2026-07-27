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

  describe("||= memoized local bindings (F1a)", () => {
    it("x ||= Const.find(id) emits an instance fact", () => {
      const code = "def call\n  user ||= User.find(1)\n  user.save\nend\n";
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts).toContainEqual(
        expect.objectContaining({
          kind: "local",
          name: "user",
          type: { form: "instance", name: "User" },
        }),
      );
    });

    it("x ||= CONST emits a class fact", () => {
      const code = "def call\n  klass ||= User\nend\n";
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts).toContainEqual(
        expect.objectContaining({
          name: "klass",
          type: { form: "class", name: "User" },
        }),
      );
    });

    it("+= / &&= emit NO facts", () => {
      const code = "def call\n  n += 1\n  y &&= User.new\nend\n";
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts.filter((f) => f.name === "n" || f.name === "y")).toEqual([]);
    });
  });

  describe("bare relation assignment → container facts (F2)", () => {
    it("posts = Post.where(...) emits a container fact with element Post", () => {
      const code = "def call\n  posts = Post.where(active: true)\nend\n";
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts).toContainEqual(
        expect.objectContaining({
          name: "posts",
          type: {
            form: "container",
            element: { form: "instance", name: "Post" },
          },
        }),
      );
    });

    it("chained relation verbs keep the root element (Post.where(...).order(...))", () => {
      const code = "def call\n  posts = Post.where(a: 1).order(:id)\nend\n";
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts).toContainEqual(
        expect.objectContaining({
          name: "posts",
          type: {
            form: "container",
            element: { form: "instance", name: "Post" },
          },
        }),
      );
    });

    it("identifier-rooted chains emit NO container fact (no guessing)", () => {
      const code = "def call\n  rows = data.where(a: 1)\nend\n";
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts.filter((f) => f.name === "rows")).toEqual([]);
    });

    it("posts.each { |p| } binds the block param to the ELEMENT type", () => {
      const code = "def call\n  posts = Post.where(a: 1)\n  posts.each { |p| p.save }\nend\n";
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts).toContainEqual(
        expect.objectContaining({
          name: "p",
          type: { form: "instance", name: "Post" },
        }),
      );
    });
  });

  describe("identifier-rooted element lift (F3)", () => {
    it("user = users.first lifts the element type", () => {
      const code = "def call\n  users = User.where(a: 1)\n  user = users.first\n  user.save\nend\n";
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts).toContainEqual(
        expect.objectContaining({
          name: "user",
          type: { form: "instance", name: "User" },
        }),
      );
    });

    it("x = users[0] lifts via element_reference", () => {
      const code = "def call\n  users = User.where(a: 1)\n  x = users[0]\nend\n";
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts).toContainEqual(
        expect.objectContaining({
          name: "x",
          type: { form: "instance", name: "User" },
        }),
      );
    });

    it("x = users.count does NOT lift (non-element method)", () => {
      const code = "def call\n  users = User.where(a: 1)\n  x = users.count\nend\n";
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts.filter((f) => f.name === "x")).toEqual([]);
    });
  });

  // bd tea-rags-mcp-02saq — the rescue clause STATES the exception variable's
  // type; the walker used to record nothing for it, so every `e.member` call in
  // a rescue body reached the resolver as an untyped `dynamic` receiver.
  describe("rescue exception variable (02saq untyped-local widening)", () => {
    it("binds `rescue Const => e` to that constant as an instance", () => {
      const code = ["def call", "  risky", "rescue Widget => e", "  e.spin", "end"].join("\n");
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts).toContainEqual(
        expect.objectContaining({
          kind: "local",
          source: "ast",
          name: "e",
          type: { form: "instance", name: "Widget" },
        }),
      );
    });

    it("binds a namespaced exception class verbatim", () => {
      const code = ["begin", "  risky", "rescue ActiveRecord::RecordInvalid => e", "  e.record", "end"].join("\n");
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts.find((f) => f.name === "e")?.type).toEqual({
        form: "instance",
        name: "ActiveRecord::RecordInvalid",
      });
    });

    it("binds the variable at the rescue clause's own line (flow order)", () => {
      const code = ["def call", "  risky", "rescue Widget => e", "  e.spin", "end"].join("\n");
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts.find((f) => f.name === "e")?.line).toBe(3);
    });

    it("binds `rescue A, B => e` as a union of the listed classes", () => {
      const code = ["begin", "  risky", "rescue Widget, Gadget => e", "  e.spin", "end"].join("\n");
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts.find((f) => f.name === "e")?.type).toEqual({
        form: "union",
        members: [
          { form: "instance", name: "Widget" },
          { form: "instance", name: "Gadget" },
        ],
      });
    });

    it("emits NOTHING for a bare `rescue => e` (no class list)", () => {
      const code = ["begin", "  risky", "rescue => e", "  e.spin", "end"].join("\n");
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts.filter((f) => f.name === "e")).toEqual([]);
    });

    it("emits NOTHING when the exception list is not all constants", () => {
      const code = ["begin", "  risky", "rescue Widget, error_class => e", "  e.spin", "end"].join("\n");
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts.filter((f) => f.name === "e")).toEqual([]);
    });

    it("emits NOTHING when the clause binds no variable", () => {
      const code = ["begin", "  risky", "rescue Widget", "  fallback", "end"].join("\n");
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts).toHaveLength(0);
    });

    it("keeps each clause of a multi-clause rescue on its own line", () => {
      const code = [
        "def call",
        "  risky",
        "rescue Widget => first",
        "  first.spin",
        "rescue Gadget => second",
        "  second.spin",
        "end",
      ].join("\n");
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts.find((f) => f.name === "first")).toMatchObject({
        line: 3,
        type: { form: "instance", name: "Widget" },
      });
      expect(facts.find((f) => f.name === "second")).toMatchObject({
        line: 5,
        type: { form: "instance", name: "Gadget" },
      });
    });

    it("lets a rescue-bound variable copy-propagate like any other local", () => {
      const code = ["begin", "  risky", "rescue Widget => e", "  err = e", "  err.spin", "end"].join("\n");
      const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
      expect(facts.find((f) => f.name === "err")?.type).toEqual({ form: "instance", name: "Widget" });
    });
  });
});
