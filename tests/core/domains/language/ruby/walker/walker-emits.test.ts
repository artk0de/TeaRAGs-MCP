/**
 * Declarative `emits` descriptor — membership-parity + shape tests (pg5ya C1).
 *
 * The four class-body macro edge families (alias_method redirect, delegate
 * target, callback self-instance, association model-constant) were relocated
 * from four `if (receiverText === null && <predicate>)` branches in
 * collectRubyCalls into ONE descriptor-driven dispatch (emitDslEdges, selected
 * by `RubyDslEntry.emits`). The four predicates used FOUR DIFFERENT dispatch
 * keys (redirectTarget, a hardcoded `delegate` name, isRubyCallbackMacro, and
 * the RUBY_ASSOCIATION_MACROS set). For byte-identity, routing through `emits`
 * must fire for the EXACT same set of macro names. These tests PROVE that
 * membership parity — a missed name is a silently dropped class of call-graph
 * edges (graph corruption). The shape block re-asserts the emitted
 * `{receiver, member}` via the public extractFromRubyFile entry.
 */

import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { RUBY_DSL } from "../../../../../../src/core/domains/language/ruby/dsl/index.js";
import {
  extractFromRubyFile,
  isRubyCallbackMacro,
  RUBY_ASSOCIATION_MACROS,
} from "../../../../../../src/core/domains/language/ruby/walker/walker.js";

const NAMES = Object.keys(RUBY_DSL);

function parse(src: string) {
  const parser = new Parser();
  parser.setLanguage(RbLang as unknown as Parser.Language);
  return parser.parse(src);
}

/** All synthetic + literal CallRefs flattened across every chunk. */
function callsOf(src: string, chunks: { symbolId: string; scope: string[]; startLine: number; endLine: number }[]) {
  const tree = parse(src);
  const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks });
  return r.chunks.flatMap((c) => c.calls);
}

describe("emits descriptor — membership parity with the four former dispatch predicates", () => {
  it("`emits === 'self-instance'` ⟺ isRubyCallbackMacro (category === 'callback'), for ALL names", () => {
    for (const name of NAMES) {
      expect(RUBY_DSL[name]?.emits === "self-instance").toBe(isRubyCallbackMacro(name));
    }
  });

  it("`emits === 'model-constant-ref'` ⟺ RUBY_ASSOCIATION_MACROS.has(name), for ALL names", () => {
    for (const name of NAMES) {
      expect(RUBY_DSL[name]?.emits === "model-constant-ref").toBe(RUBY_ASSOCIATION_MACROS.has(name));
    }
    // Reverse direction: every association set member exists in RUBY_DSL and
    // carries the descriptor (a set-only name with no entry would silently drop).
    for (const name of RUBY_ASSOCIATION_MACROS) {
      expect(RUBY_DSL[name]?.emits).toBe("model-constant-ref");
    }
  });

  it("`emits === 'delegate-target'` ⟺ name === 'delegate', for ALL names", () => {
    for (const name of NAMES) {
      expect(RUBY_DSL[name]?.emits === "delegate-target").toBe(name === "delegate");
    }
  });

  it("`emits === 'alias-redirect'` ⟺ redirectTarget === 'second-symbol', for ALL names", () => {
    for (const name of NAMES) {
      expect(RUBY_DSL[name]?.emits === "alias-redirect").toBe(RUBY_DSL[name]?.redirectTarget === "second-symbol");
    }
  });

  it("`emits === 'serialized-attribute'` ⟺ name === 'attributes' (AMS), for ALL names", () => {
    for (const name of NAMES) {
      expect(RUBY_DSL[name]?.emits === "serialized-attribute").toBe(name === "attributes");
    }
  });

  it("every populated `emits` is one of the known shapes (no stray value)", () => {
    const known = new Set([
      "self-instance",
      "model-constant-ref",
      "delegate-target",
      "alias-redirect",
      "policy-dispatch",
      "route-action",
      "serialized-attribute",
    ]);
    for (const name of NAMES) {
      const e = RUBY_DSL[name]?.emits;
      if (e !== undefined) expect(known.has(e)).toBe(true);
    }
  });

  it("the callback family carries the descriptor on EVERY callback entry (28-name list)", () => {
    const callbacks = NAMES.filter((n) => RUBY_DSL[n]?.category === "callback");
    expect(callbacks.length).toBeGreaterThanOrEqual(28);
    for (const name of callbacks) expect(RUBY_DSL[name]?.emits).toBe("self-instance");
  });
});

describe("emitDslEdges — per-emits edge shape via extractFromRubyFile", () => {
  it("alias-redirect: `alias_method :new_name, :old_name` → {receiver:null, member:'old_name'}", () => {
    const src = "class C\n  alias_method :new_name, :old_name\nend\n";
    const calls = callsOf(src, [{ symbolId: "C", scope: ["C"], startLine: 1, endLine: 3 }]);
    expect(calls).toContainEqual(expect.objectContaining({ receiver: null, member: "old_name", startLine: 2 }));
  });

  it("delegate-target: `delegate :a, :b, to: :client` → {receiver:'client', member:'a'|'b'}", () => {
    const src = "class C\n  delegate :a, :b, to: :client\nend\n";
    const calls = callsOf(src, [{ symbolId: "C", scope: ["C"], startLine: 1, endLine: 3 }]);
    expect(calls).toContainEqual(expect.objectContaining({ receiver: "client", member: "a", startLine: 2 }));
    expect(calls).toContainEqual(expect.objectContaining({ receiver: "client", member: "b", startLine: 2 }));
  });

  it("self-instance: `before_action :auth` → {receiver:null, member:'auth'}", () => {
    const src = "class C\n  before_action :auth\nend\n";
    const calls = callsOf(src, [{ symbolId: "C", scope: ["C"], startLine: 1, endLine: 3 }]);
    expect(calls).toContainEqual(expect.objectContaining({ receiver: null, member: "auth", startLine: 2 }));
  });

  it("model-constant-ref: `has_many :posts` → {receiver:'Post', member:'Post'}", () => {
    const src = "class User\n  has_many :posts\nend\n";
    const calls = callsOf(src, [{ symbolId: "User", scope: ["User"], startLine: 1, endLine: 3 }]);
    expect(calls).toContainEqual(expect.objectContaining({ receiver: "Post", member: "Post", startLine: 2 }));
  });

  it("policy-dispatch: `authorize :relay, :update?` → {receiver:'RelayPolicy', member:'update?'}", () => {
    const src = "class Admin::RelaysController\n  def update\n    authorize :relay, :update?\n  end\nend\n";
    const calls = callsOf(src, [
      {
        symbolId: "Admin::RelaysController#update",
        scope: ["Admin", "RelaysController", "update"],
        startLine: 2,
        endLine: 4,
      },
    ]);
    expect(calls).toContainEqual(expect.objectContaining({ receiver: "RelayPolicy", member: "update?" }));
  });

  it("route-action: `get \"/x\", to: \"posts#index\"` → {receiver:'PostsController', member:'index'}", () => {
    const src = 'Rails.application.routes.draw do\n  get "/x", to: "posts#index"\nend\n';
    const calls = callsOf(src, [{ symbolId: "config/routes", scope: [], startLine: 1, endLine: 3 }]);
    expect(calls).toContainEqual(expect.objectContaining({ receiver: "PostsController", member: "index" }));
  });

  it("serialized-attribute: `attributes :id, :name` (AMS) → {receiver:null, member:'id'|'name'}", () => {
    const src = "class UserSerializer\n  attributes :id, :name\nend\n";
    const calls = callsOf(src, [{ symbolId: "UserSerializer", scope: ["UserSerializer"], startLine: 1, endLine: 3 }]);
    expect(calls).toContainEqual(expect.objectContaining({ receiver: null, member: "id", startLine: 2 }));
    expect(calls).toContainEqual(expect.objectContaining({ receiver: null, member: "name", startLine: 2 }));
  });

  it("class-body-only: a receiver-qualified `obj.before_action :x` emits NO synthetic edge", () => {
    const src = "class C\n  def m\n    obj.before_action(:x)\n  end\nend\n";
    const calls = callsOf(src, [{ symbolId: "C#m", scope: ["C", "m"], startLine: 2, endLine: 4 }]);
    expect(calls.filter((c) => c.receiver === null).map((c) => c.member)).not.toContain("x");
  });

  it("non-emitting macro (`attr_accessor :name`) produces no synthetic class-body edge", () => {
    const src = "class C\n  attr_accessor :name\nend\n";
    const calls = callsOf(src, [{ symbolId: "C", scope: ["C"], startLine: 1, endLine: 3 }]);
    // attr_accessor has no `emits` → only the literal `attr_accessor` call edge,
    // never a bare-receiver `name` edge from the (absent) emit path.
    expect(calls.filter((c) => c.receiver === null && c.member === "name")).toHaveLength(0);
  });
});
