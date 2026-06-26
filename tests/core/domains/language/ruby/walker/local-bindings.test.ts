/**
 * Direct behavioral tests for collectLocalBindingsForChunk and related
 * exported functions in local-bindings.ts.
 *
 * These functions were decoupled from extractFromRubyFile in the
 * INLINE_TYPE_SOURCES refactor — the walker no longer calls
 * collectLocalBindingsForChunk directly, so the end-to-end tests in
 * ruby-walker.test.ts no longer exercise it. This file restores coverage
 * by driving the function directly with real parsed ASTs.
 */

import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import type { LocalBinding } from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  bindCompoundReceiverChains,
  collectLocalBindingsForChunk,
  collectRubyBodyReturnTypes,
  collectRubyIvarFieldTypes,
  collectRubyLocalCallBindingsForChunk,
  localTypeTrackingEnabled,
} from "../../../../../../src/core/domains/language/ruby/walker/local-bindings.js";

function parse(src: string) {
  const parser = new Parser();
  parser.setLanguage(RbLang as unknown as Parser.Language);
  return parser.parse(src).rootNode;
}

// ---------------------------------------------------------------------------
// localTypeTrackingEnabled
// ---------------------------------------------------------------------------

describe("localTypeTrackingEnabled", () => {
  it("returns true when env var is absent", () => {
    delete process.env.CODEGRAPH_RB_LOCAL_TYPE_TRACKING;
    expect(localTypeTrackingEnabled()).toBe(true);
  });

  it('returns false when env var is "false"', () => {
    process.env.CODEGRAPH_RB_LOCAL_TYPE_TRACKING = "false";
    try {
      expect(localTypeTrackingEnabled()).toBe(false);
    } finally {
      delete process.env.CODEGRAPH_RB_LOCAL_TYPE_TRACKING;
    }
  });

  it('returns false when env var is "0"', () => {
    process.env.CODEGRAPH_RB_LOCAL_TYPE_TRACKING = "0";
    try {
      expect(localTypeTrackingEnabled()).toBe(false);
    } finally {
      delete process.env.CODEGRAPH_RB_LOCAL_TYPE_TRACKING;
    }
  });

  it('returns true when env var is any truthy string other than "false"/"0"', () => {
    process.env.CODEGRAPH_RB_LOCAL_TYPE_TRACKING = "true";
    try {
      expect(localTypeTrackingEnabled()).toBe(true);
    } finally {
      delete process.env.CODEGRAPH_RB_LOCAL_TYPE_TRACKING;
    }
  });
});

// ---------------------------------------------------------------------------
// collectLocalBindingsForChunk — constructor/factory assignments
// ---------------------------------------------------------------------------

describe("collectLocalBindingsForChunk — constructor assignment", () => {
  it("binds `var = ClassName.new` to instance type within chunk range", () => {
    const root = parse("def m\n  user = User.new\nend\n");
    const bindings = collectLocalBindingsForChunk(root, 1, 3, new Map());
    expect(bindings["user"]).toEqual([{ line: 2, type: "User" }]);
  });

  it("binds `var = Model.find(id)` to instance type", () => {
    const root = parse("post = Post.find(1)\n");
    const bindings = collectLocalBindingsForChunk(root, 1, 1, new Map());
    expect(bindings["post"]).toEqual([{ line: 1, type: "Post" }]);
  });

  it("skips assignments outside the line range", () => {
    const src = "a = A.new\nb = B.new\nc = C.new\n";
    const root = parse(src);
    // Only line 2 is in range
    const bindings = collectLocalBindingsForChunk(root, 2, 2, new Map());
    expect(bindings["a"]).toBeUndefined();
    expect(bindings["b"]).toEqual([{ line: 2, type: "B" }]);
    expect(bindings["c"]).toBeUndefined();
  });

  it("binds copy-propagation: `b = a` inherits a's most-recent type", () => {
    const src = "a = User.new\nb = a\n";
    const root = parse(src);
    const bindings = collectLocalBindingsForChunk(root, 1, 2, new Map());
    expect(bindings["a"]).toEqual([{ line: 1, type: "User" }]);
    expect(bindings["b"]).toEqual([{ line: 2, type: "User" }]);
  });

  it("does NOT copy-propagate from an unbound variable", () => {
    const root = parse("b = a\n");
    const bindings = collectLocalBindingsForChunk(root, 1, 1, new Map());
    expect(bindings["b"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// collectLocalBindingsForChunk — YARD @param bindings via yardByLine
// ---------------------------------------------------------------------------

describe("collectLocalBindingsForChunk — YARD @param bindings", () => {
  it("injects YARD @param binding from yardByLine at the def line", () => {
    const root = parse("def process(user)\n  user.save\nend\n");
    // yardByLine: line 1 (the `def` line) → { user: "User" }
    const yardByLine = new Map([[1, { user: "User" }]]);
    const bindings = collectLocalBindingsForChunk(root, 1, 3, yardByLine);
    expect(bindings["user"]).toEqual([{ line: 1, type: "User" }]);
  });

  it("skips YARD entries whose def line is outside the chunk range", () => {
    const root = parse("x = 1\n");
    // def line 99 is outside range [1..5]
    const yardByLine = new Map([[99, { user: "User" }]]);
    const bindings = collectLocalBindingsForChunk(root, 1, 5, yardByLine);
    expect(bindings["user"]).toBeUndefined();
  });

  it("injects multiple YARD params for a single def", () => {
    const root = parse("def ship(order, user)\n  order.ship(user)\nend\n");
    const yardByLine = new Map([[1, { order: "Order", user: "User" }]]);
    const bindings = collectLocalBindingsForChunk(root, 1, 3, yardByLine);
    expect(bindings["order"]).toEqual([{ line: 1, type: "Order" }]);
    expect(bindings["user"]).toEqual([{ line: 1, type: "User" }]);
  });
});

// ---------------------------------------------------------------------------
// collectLocalBindingsForChunk — param-default inference
// ---------------------------------------------------------------------------

describe("collectLocalBindingsForChunk — param-default inference", () => {
  it("binds `def f(x = User.new)` at the def line", () => {
    const src = "def process(user = User.new)\n  user.save\nend\n";
    const root = parse(src);
    const bindings = collectLocalBindingsForChunk(root, 1, 3, new Map());
    expect(bindings["user"]).toEqual([{ line: 1, type: "User" }]);
  });
});

// ---------------------------------------------------------------------------
// collectLocalBindingsForChunk — multiple assignment
// ---------------------------------------------------------------------------

describe("collectLocalBindingsForChunk — multiple assignment", () => {
  it("pairs `a, b = X.new, Y.new` positionally", () => {
    const root = parse("a, b = Foo.new, Bar.new\n");
    const bindings = collectLocalBindingsForChunk(root, 1, 1, new Map());
    expect(bindings["a"]).toEqual([{ line: 1, type: "Foo" }]);
    expect(bindings["b"]).toEqual([{ line: 1, type: "Bar" }]);
  });

  it("skips multi-assign when LHS and RHS counts differ", () => {
    const root = parse("a, b = Foo.new\n");
    const bindings = collectLocalBindingsForChunk(root, 1, 1, new Map());
    expect(bindings["a"]).toBeUndefined();
    expect(bindings["b"]).toBeUndefined();
  });

  it("propagates copy-binding in multi-assign RHS: `a, b = X.new, a`", () => {
    const src = "x = Order.new\na, b = Foo.new, x\n";
    const root = parse(src);
    const bindings = collectLocalBindingsForChunk(root, 1, 2, new Map());
    expect(bindings["a"]).toEqual([{ line: 2, type: "Foo" }]);
    expect(bindings["b"]).toEqual([{ line: 2, type: "Order" }]);
  });
});

// ---------------------------------------------------------------------------
// collectLocalBindingsForChunk — class-valued binding (var = CONST)
// ---------------------------------------------------------------------------

describe("collectLocalBindingsForChunk — class-valued binding", () => {
  it("binds `klass = User` as a class-valued binding with valueKind: 'class'", () => {
    const root = parse("klass = User\n");
    const bindings = collectLocalBindingsForChunk(root, 1, 1, new Map());
    expect(bindings["klass"]).toEqual([{ line: 1, type: "User", valueKind: "class" }]);
  });

  it("binds `klass = Acme::Auth` (qualified constant) as class-valued", () => {
    const root = parse("klass = Acme::Auth\n");
    const bindings = collectLocalBindingsForChunk(root, 1, 1, new Map());
    expect(bindings["klass"]).toEqual([{ line: 1, type: "Acme::Auth", valueKind: "class" }]);
  });

  it("does NOT bind lowercase identifier RHS as class-valued", () => {
    const root = parse("klass = something\n");
    const bindings = collectLocalBindingsForChunk(root, 1, 1, new Map());
    expect(bindings["klass"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// collectLocalBindingsForChunk — block-parameter element typing
// ---------------------------------------------------------------------------

describe("collectLocalBindingsForChunk — block-parameter element typing", () => {
  it("binds block param `|p|` to element type when receiver is YARD-typed via yardByLine", () => {
    const src = ["# @param posts [Array<Post>]", "def run(posts)", "  posts.each { |p| p.publish }", "end"].join("\n");
    const root = parse(`${src}\n`);
    // YARD param: posts → "Post" (element type already unwrapped by collectYardParamTypes)
    const yardByLine = new Map([[2, { posts: "Post" }]]);
    const bindings = collectLocalBindingsForChunk(root, 2, 4, yardByLine);
    expect(bindings["p"]).toBeDefined();
    expect(bindings["p"][0].type).toBe("Post");
  });

  it("does NOT bind block param when receiver is untyped", () => {
    const src = ["def run(items)", "  items.each { |e| e.do_it }", "end"].join("\n");
    const root = parse(`${src}\n`);
    const bindings = collectLocalBindingsForChunk(root, 1, 3, new Map());
    // items has no binding → e must not be bound
    expect(bindings["e"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// bindCompoundReceiverChains — direct export
// ---------------------------------------------------------------------------

describe("bindCompoundReceiverChains (direct export)", () => {
  it("binds each prefix of `event.user.agents` given association types", () => {
    const src = ["# @param event [Event]", "def go(event)", "  event.user.agents.size", "end"].join("\n");
    const root = parse(`${src}\n`);
    // Seed the out-bindings as if YARD already bound event → Event
    const out: Record<string, LocalBinding[]> = { event: [{ line: 2, type: "Event" }] };
    const pushed: { name: string; type: string; line: number }[] = [];
    const push = (name: string, type: string, line: number): void => {
      pushed.push({ name, type, line });
      (out[name] ??= []).push({ line, type } as LocalBinding);
    };
    const associationTypes: Record<string, Record<string, string>> = {
      Event: { user: "User" },
      User: { agents: "Agent" },
    };
    bindCompoundReceiverChains(root, 2, 4, associationTypes, out, push);
    const names = pushed.map((p) => p.name);
    expect(names).toContain("event.user");
    expect(names).toContain("event.user.agents");
    const userBind = pushed.find((p) => p.name === "event.user");
    const agentBind = pushed.find((p) => p.name === "event.user.agents");
    expect(userBind?.type).toBe("User");
    expect(agentBind?.type).toBe("Agent");
  });

  it("does NOT walk when chain root has no binding (honest fan-out)", () => {
    const src = ["def go(thing)", "  thing.user.agents", "end"].join("\n");
    const root = parse(`${src}\n`);
    const out: Record<string, LocalBinding[]> = {};
    const pushed: string[] = [];
    const push = (name: string, _t: string, _l: number): void => {
      pushed.push(name);
    };
    bindCompoundReceiverChains(root, 1, 3, { Thing: { user: "User" } }, out, push);
    expect(pushed).toHaveLength(0);
  });

  it("stops at an unknown hop and does NOT push past it", () => {
    const src = ["# @param e [Event]", "def go(e)", "  e.user.mystery.field", "end"].join("\n");
    const root = parse(`${src}\n`);
    const out: Record<string, LocalBinding[]> = { e: [{ line: 2, type: "Event" }] };
    const pushed: string[] = [];
    const push = (name: string, type: string, line: number): void => {
      pushed.push(name);
      (out[name] ??= []).push({ line, type } as LocalBinding);
    };
    const associationTypes = { Event: { user: "User" } };
    bindCompoundReceiverChains(root, 2, 4, associationTypes, out, push);
    expect(pushed).toContain("e.user");
    expect(pushed).not.toContain("e.user.mystery");
  });

  it("cycle-guard: self-referential has_many does not loop", () => {
    const src = ["# @param cat [Category]", "def list(cat)", "  cat.subcategories.size", "end"].join("\n");
    const root = parse(`${src}\n`);
    const out: Record<string, LocalBinding[]> = { cat: [{ line: 2, type: "Category" }] };
    const pushed: string[] = [];
    const push = (name: string, type: string, line: number): void => {
      pushed.push(name);
      (out[name] ??= []).push({ line, type } as LocalBinding);
    };
    // Category.subcategories → Category (self-referential)
    const associationTypes = { Category: { subcategories: "Category" } };
    expect(() => {
      bindCompoundReceiverChains(root, 2, 4, associationTypes, out, push);
    }).not.toThrow();
    // The first hop is allowed (cat.subcategories → Category)
    expect(pushed).toContain("cat.subcategories");
    // No further re-entry after seeing Category again
    expect(pushed.filter((n) => n.startsWith("cat.subcategories."))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// collectRubyIvarFieldTypes — uncovered paths
// ---------------------------------------------------------------------------

describe("collectRubyIvarFieldTypes — edge cases", () => {
  it("handles a class with a scope_resolution name (Outer::Inner)", () => {
    const src = [
      "module Outer",
      "  class Inner",
      "    def init",
      "      @client = HttpClient.new",
      "    end",
      "  end",
      "end",
    ].join("\n");
    const root = parse(`${src}\n`);
    const result = collectRubyIvarFieldTypes(root);
    expect(result["Outer::Inner"]).toEqual({ "@client": "HttpClient" });
  });

  it("attributes @ivar assignments in nested class separately from outer class", () => {
    const src = [
      "class Outer",
      "  def setup",
      "    @a = Foo.new",
      "  end",
      "  class Inner",
      "    def setup",
      "      @b = Bar.new",
      "    end",
      "  end",
      "end",
    ].join("\n");
    const root = parse(`${src}\n`);
    const result = collectRubyIvarFieldTypes(root);
    expect(result["Outer"]).toEqual({ "@a": "Foo" });
    expect(result["Outer::Inner"]).toEqual({ "@b": "Bar" });
  });
});

// ---------------------------------------------------------------------------
// collectRubyBodyReturnTypes — uncovered paths
// ---------------------------------------------------------------------------

describe("collectRubyBodyReturnTypes — edge cases", () => {
  it("skips rescue/ensure/else bodies when finding the last statement", () => {
    const src = ["class Foo", "  def load", "    User.find(1)", "  rescue => e", "    nil", "  end", "end"].join("\n");
    const root = parse(`${src}\n`);
    // rescue tail is filtered out — last stmt is User.find(1) → "User"
    const result = collectRubyBodyReturnTypes(root);
    expect(result["load"]).toBe("User");
  });

  it("records nothing when method body has no statements after filtering rescue", () => {
    // Edge: a method body that only has rescue/ensure (unusual but valid parse)
    const src = ["class Foo", "  def empty_body", "  end", "end"].join("\n");
    const root = parse(`${src}\n`);
    const result = collectRubyBodyReturnTypes(root);
    expect(result["empty_body"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// collectRubyLocalCallBindingsForChunk — uncovered paths
// ---------------------------------------------------------------------------

describe("collectRubyLocalCallBindingsForChunk — do_block / method_call shape", () => {
  it("binds `x = client.fetch` (call RHS with known method) to the called method name", () => {
    const src = "x = client.fetch\n";
    const root = parse(src);
    const result = collectRubyLocalCallBindingsForChunk(root, 1, 1);
    expect(result["x"]).toBe("fetch");
  });

  it("excludes constructor calls — constInstanceType short-circuits", () => {
    const root = parse("x = User.new\n");
    const result = collectRubyLocalCallBindingsForChunk(root, 1, 1);
    // User.new → constInstanceType fires → NOT captured by localCallBindings
    expect(result["x"]).toBeUndefined();
  });

  it("captures the outermost method for a chained call RHS", () => {
    const src = "x = a.b.second_call\n";
    const root = parse(src);
    const result = collectRubyLocalCallBindingsForChunk(root, 1, 1);
    expect(result["x"]).toBe("second_call");
  });

  it("last-write-wins when the same variable is assigned twice in range", () => {
    const src = "x = a.first_call\nx = b.second_call\n";
    const root = parse(src);
    const result = collectRubyLocalCallBindingsForChunk(root, 1, 2);
    expect(result["x"]).toBe("second_call");
  });
});
