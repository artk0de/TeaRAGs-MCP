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
  collectRubyScopedBodyReturnTypes,
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
// collectRubyIvarFieldTypes — ||= memoization (F1b)
// ---------------------------------------------------------------------------

describe("collectRubyIvarFieldTypes — ||= memoization (F1b)", () => {
  it("@user ||= User.find(@id) types the ivar", () => {
    const src = ["class Session", "  def user", "    @user ||= User.find(@id)", "  end", "end"].join("\n");
    const root = parse(`${src}\n`);
    const result = collectRubyIvarFieldTypes(root);
    expect(result["Session"]).toMatchObject({ "@user": "User" });
  });

  it("@n += 1 does NOT type the ivar", () => {
    const src = ["class Counter", "  def bump", "    @n += 1", "  end", "end"].join("\n");
    const root = parse(`${src}\n`);
    const result = collectRubyIvarFieldTypes(root);
    expect(result["Counter"]?.["@n"]).toBeUndefined();
  });

  it("@posts ||= Post.where(a: 1) does NOT type the ivar (container defer, spec F2)", () => {
    const src = ["class Feed", "  def posts", "    @posts ||= Post.where(a: 1)", "  end", "end"].join("\n");
    const root = parse(`${src}\n`);
    const result = collectRubyIvarFieldTypes(root);
    expect(result["Feed"]?.["@posts"]).toBeUndefined();
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
// collectRubyScopedBodyReturnTypes — the owner-qualified twin (bd rwv3o)
//
// Same inference as collectRubyBodyReturnTypes, keyed by the DECLARING class
// instead of the bare method name, so a reader that knows the receiver's class
// (or, for a bare self-call, the caller's class) can ask about THAT method
// rather than about every same-named method in the corpus.
// ---------------------------------------------------------------------------

describe("collectRubyScopedBodyReturnTypes", () => {
  it("keys the inferred return by the declaring class, not the bare method name", () => {
    const src = ["class Report", "  def data", "    ReportRow.new", "  end", "end"].join("\n");
    expect(collectRubyScopedBodyReturnTypes(parse(`${src}\n`))).toEqual({
      "Report#data": { form: "instance", name: "ReportRow" },
    });
  });

  it("qualifies by the full lexical scope, so same-named methods do not collide", () => {
    const src = [
      "module Billing",
      "  class Invoice",
      "    def data",
      "      InvoiceRow.new",
      "    end",
      "  end",
      "end",
      "class Report",
      "  def data",
      "    ReportRow.new",
      "  end",
      "end",
    ].join("\n");
    expect(collectRubyScopedBodyReturnTypes(parse(`${src}\n`))).toEqual({
      "Billing::Invoice#data": { form: "instance", name: "InvoiceRow" },
      "Report#data": { form: "instance", name: "ReportRow" },
    });
  });

  it("keys a `def self.x` singleton with `#` — the shared coordinate the engine reads", () => {
    const src = ["class Factory", "  def self.build", "    Widget.new", "  end", "end"].join("\n");
    expect(collectRubyScopedBodyReturnTypes(parse(`${src}\n`))).toEqual({
      "Factory#build": { form: "instance", name: "Widget" },
    });
  });

  it("emits nothing for a method declared outside any class — there is no owner", () => {
    const src = ["def build", "  Widget.new", "end"].join("\n");
    expect(collectRubyScopedBodyReturnTypes(parse(`${src}\n`))).toEqual({});
  });

  it("stays silent on the shapes the flat inference is silent on", () => {
    const src = [
      "class Report",
      "  def branching",
      "    cond ? A.new : B.new",
      "  end",
      "  def opaque",
      "    other.thing",
      "  end",
      "end",
    ].join("\n");
    expect(collectRubyScopedBodyReturnTypes(parse(`${src}\n`))).toEqual({});
  });

  it("covers exactly what the flat map covers for a scoped method (same shapes)", () => {
    const src = ["class Report", "  def load", "    User.find(1)", "  rescue => e", "    nil", "  end", "end"].join(
      "\n",
    );
    const root = parse(`${src}\n`);
    expect(collectRubyBodyReturnTypes(root)["load"]).toBe("User");
    expect(collectRubyScopedBodyReturnTypes(root)["Report#load"]).toEqual({ form: "instance", name: "User" });
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

// ---------------------------------------------------------------------------
// bd tea-rags-mcp-j9xpf — a CONSTANT receiver names the exact type whose method
// is being called, so the binding keeps it: `result = Billing::X::Create.call(…)`
// records `Billing::X::Create.call`, not the bare `call`. Without the receiver
// the resolver can only consult the FLAT, project-wide `functionReturnTypes`
// keyed by the bare name — and `call` is the single most collided method name in
// a Rails codebase. Non-constant receivers keep the bare form (their type is not
// statically known here — that stays the resolver's job).
// ---------------------------------------------------------------------------
describe("collectRubyLocalCallBindingsForChunk — constant receiver keeps its scope", () => {
  it("`x = Svc.call(y)` → scope-qualified `Svc.call`", () => {
    const result = collectRubyLocalCallBindingsForChunk(parse("x = Svc.call(y)\n"), 1, 1);
    expect(result["x"]).toBe("Svc.call");
  });

  it("`x = Billing::Invoices::ApplyStatus.call(y)` → fully-qualified constant preserved", () => {
    const result = collectRubyLocalCallBindingsForChunk(parse("x = Billing::Invoices::ApplyStatus.call(y)\n"), 1, 1);
    expect(result["x"]).toBe("Billing::Invoices::ApplyStatus.call");
  });

  it("`x = client.fetch` (lowercase receiver) keeps the bare method name", () => {
    const result = collectRubyLocalCallBindingsForChunk(parse("x = client.fetch\n"), 1, 1);
    expect(result["x"]).toBe("fetch");
  });

  it("`x = @client.fetch` (ivar receiver) keeps the bare method name", () => {
    const result = collectRubyLocalCallBindingsForChunk(parse("x = @client.fetch\n"), 1, 1);
    expect(result["x"]).toBe("fetch");
  });

  it("`x = Svc.build.call` (chained tail off a constant) keeps the bare method name", () => {
    const result = collectRubyLocalCallBindingsForChunk(parse("x = Svc.build.call\n"), 1, 1);
    expect(result["x"]).toBe("call");
  });
});
