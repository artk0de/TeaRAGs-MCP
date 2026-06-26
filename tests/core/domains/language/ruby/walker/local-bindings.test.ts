/**
 * Direct behavioral tests for the live exported helpers in local-bindings.ts:
 * bindCompoundReceiverChains, collectRubyIvarFieldTypes,
 * collectRubyBodyReturnTypes, collectRubyLocalCallBindingsForChunk, and
 * localTypeTrackingEnabled. Each is driven directly with real parsed ASTs.
 */

import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import type { LocalBinding } from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  bindCompoundReceiverChains,
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
