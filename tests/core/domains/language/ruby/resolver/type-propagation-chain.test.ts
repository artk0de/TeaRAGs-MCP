/**
 * Task 1.4: multi-hop chain-call threading in `typeOfReceiver`.
 *
 * Tests that cover:
 * - structuredReturnTypes chain threading (2-hop)
 * - flat functionReturnTypes fallback (single hop via fallback path)
 * - STOP-at-unknown-hop precision invariant
 * - CODEGRAPH_RB_CHAIN_MAX_HOPS cap
 * - Rails association DSL chain threading
 * - ancestor MRO walk for inherited return types
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../src/core/contracts/types/codegraph.js";
import { typeOfReceiver } from "../../../../../../src/core/domains/language/ruby/resolver/type-propagation.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const emptyCtx = (over: Partial<CallContext> = {}): CallContext => ({
  callerFile: "app/caller.rb",
  callerScope: [],
  imports: [],
  symbolTable: new InMemoryGlobalSymbolTable(),
  ...over,
});

// ── structuredReturnTypes chain threading ──────────────────────────────────

describe("typeOfReceiver — multi-hop via structuredReturnTypes", () => {
  it("threads seed through 2-hop chain using structuredReturnTypes", () => {
    // u : User, User#account → Account, Account#owner → User
    const ctx = emptyCtx({
      localBindings: {
        u: [{ line: 1, type: "User", valueKind: "instance" }],
      },
      structuredReturnTypes: {
        "User#account": { form: "instance", name: "Account" },
        "Account#owner": { form: "instance", name: "User" },
      },
    });
    expect(typeOfReceiver("u.account.owner", 5, ctx)).toEqual({ form: "instance", name: "User" });
  });

  it("resolves single-hop chain via structuredReturnTypes", () => {
    const ctx = emptyCtx({
      localBindings: {
        u: [{ line: 1, type: "User", valueKind: "instance" }],
      },
      structuredReturnTypes: {
        "User#account": { form: "instance", name: "Account" },
      },
    });
    expect(typeOfReceiver("u.account", 5, ctx)).toEqual({ form: "instance", name: "Account" });
  });

  it("returns class form when structuredReturnTypes declares class form", () => {
    const ctx = emptyCtx({
      localBindings: {
        u: [{ line: 1, type: "User", valueKind: "instance" }],
      },
      structuredReturnTypes: {
        "User#class_ref": { form: "class", name: "Account" },
      },
    });
    expect(typeOfReceiver("u.class_ref", 5, ctx)).toEqual({ form: "class", name: "Account" });
  });
});

// ── flat functionReturnTypes fallback ─────────────────────────────────────

describe("typeOfReceiver — single-hop via flat functionReturnTypes fallback", () => {
  it("resolves u.account when only functionReturnTypes has account → Account", () => {
    const ctx = emptyCtx({
      localBindings: {
        u: [{ line: 1, type: "User", valueKind: "instance" }],
      },
      // No structuredReturnTypes — only flat fallback
      functionReturnTypes: { account: "Account" },
    });
    expect(typeOfReceiver("u.account", 5, ctx)).toEqual({ form: "instance", name: "Account" });
  });

  it("structuredReturnTypes wins over functionReturnTypes when both present", () => {
    const ctx = emptyCtx({
      localBindings: {
        u: [{ line: 1, type: "User", valueKind: "instance" }],
      },
      structuredReturnTypes: {
        "User#account": { form: "class", name: "AccountClass" },
      },
      functionReturnTypes: { account: "AccountFlat" },
    });
    // structured wins — class form
    expect(typeOfReceiver("u.account", 5, ctx)).toEqual({ form: "class", name: "AccountClass" });
  });
});

// ── STOP-at-unknown-hop precision invariant ────────────────────────────────

describe("typeOfReceiver — STOP at unknown hop (precision invariant)", () => {
  it("returns undefined when middle hop is unknown", () => {
    // u.account.mystery.x — account resolves but mystery does not → STOP
    const ctx = emptyCtx({
      localBindings: {
        u: [{ line: 1, type: "User", valueKind: "instance" }],
      },
      structuredReturnTypes: {
        "User#account": { form: "instance", name: "Account" },
        // mystery not registered → undefined
        "Account#x": { form: "instance", name: "Whatever" },
      },
    });
    expect(typeOfReceiver("u.account.mystery.x", 5, ctx)).toBeUndefined();
  });

  it("returns undefined when head is untyped", () => {
    const ctx = emptyCtx({
      structuredReturnTypes: {
        "User#account": { form: "instance", name: "Account" },
      },
    });
    // no localBindings → head type unknown
    expect(typeOfReceiver("u.account", 5, ctx)).toBeUndefined();
  });

  it("returns undefined for union receiver (not threaded in Task 1.4)", () => {
    const ctx = emptyCtx({
      localBindings: {
        u: [{ line: 1, type: "User", valueKind: "instance" }],
      },
      structuredReturnTypes: {
        "User#account": {
          form: "union",
          members: [
            { form: "instance", name: "Account" },
            { form: "instance", name: "Other" },
          ],
        },
      },
    });
    // union form → returnTypeOf returns undefined (handled by later tasks)
    expect(typeOfReceiver("u.account.owner", 5, ctx)).toBeUndefined();
  });
});

// ── CODEGRAPH_RB_CHAIN_MAX_HOPS cap ──────────────────────────────────────

describe("typeOfReceiver — CODEGRAPH_RB_CHAIN_MAX_HOPS cap", () => {
  const original = process.env.CODEGRAPH_RB_CHAIN_MAX_HOPS;

  beforeEach(() => {
    process.env.CODEGRAPH_RB_CHAIN_MAX_HOPS = "2";
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.CODEGRAPH_RB_CHAIN_MAX_HOPS;
    } else {
      process.env.CODEGRAPH_RB_CHAIN_MAX_HOPS = original;
    }
  });

  it("returns undefined for a chain exceeding the hop cap", () => {
    // cap = 2, chain a.b.c has 2 hops — this is AT the cap, fine
    // chain a.b.c.d has 3 hops — exceeds cap=2 → undefined
    const ctx = emptyCtx({
      localBindings: {
        a: [{ line: 1, type: "A", valueKind: "instance" }],
      },
      structuredReturnTypes: {
        "A#b": { form: "instance", name: "B" },
        "B#c": { form: "instance", name: "C" },
        "C#d": { form: "instance", name: "D" },
      },
    });
    // 3 hops: a→b, b→c, c→d — exceeds cap of 2
    expect(typeOfReceiver("a.b.c.d", 5, ctx)).toBeUndefined();
  });

  it("resolves a chain exactly at the hop cap", () => {
    // cap = 2, chain a.b.c has exactly 2 hops — should resolve
    const ctx = emptyCtx({
      localBindings: {
        a: [{ line: 1, type: "A", valueKind: "instance" }],
      },
      structuredReturnTypes: {
        "A#b": { form: "instance", name: "B" },
        "B#c": { form: "instance", name: "C" },
      },
    });
    expect(typeOfReceiver("a.b.c", 5, ctx)).toEqual({ form: "instance", name: "C" });
  });
});

// ── Rails association DSL chain threading ─────────────────────────────────

describe("typeOfReceiver — Rails association DSL chain threading", () => {
  it("threads belongs_to association (singular: user → User)", () => {
    // post : Post, Post belongs_to :user (→ User via associationTypes)
    const ctx = emptyCtx({
      localBindings: {
        post: [{ line: 1, type: "Post", valueKind: "instance" }],
      },
      associationTypes: {
        Post: { user: "User" },
      },
    });
    expect(typeOfReceiver("post.user", 5, ctx)).toEqual({ form: "instance", name: "User" });
  });

  it("threads has_many association (plural: posts → Post)", () => {
    const ctx = emptyCtx({
      localBindings: {
        u: [{ line: 1, type: "User", valueKind: "instance" }],
      },
      associationTypes: {
        User: { posts: "Post" },
      },
    });
    expect(typeOfReceiver("u.posts", 5, ctx)).toEqual({ form: "instance", name: "Post" });
  });

  it("chains 2 Rails associations: post.user.account → Account", () => {
    const ctx = emptyCtx({
      localBindings: {
        post: [{ line: 1, type: "Post", valueKind: "instance" }],
      },
      associationTypes: {
        Post: { user: "User" },
        User: { account: "Account" },
      },
    });
    expect(typeOfReceiver("post.user.account", 5, ctx)).toEqual({ form: "instance", name: "Account" });
  });

  it("structuredReturnTypes wins over associationTypes when both present for same key", () => {
    const ctx = emptyCtx({
      localBindings: {
        post: [{ line: 1, type: "Post", valueKind: "instance" }],
      },
      structuredReturnTypes: {
        "Post#user": { form: "class", name: "UserClass" },
      },
      associationTypes: {
        Post: { user: "UserAssoc" },
      },
    });
    expect(typeOfReceiver("post.user", 5, ctx)).toEqual({ form: "class", name: "UserClass" });
  });
});

// ── ancestor MRO walk ────────────────────────────────────────────────────

describe("typeOfReceiver — ancestor MRO inheritance", () => {
  it("finds inherited return type from direct superclass", () => {
    // u : User, User#account not present, but ApplicationRecord#account → Account is
    const ctx = emptyCtx({
      localBindings: {
        u: [{ line: 1, type: "User", valueKind: "instance" }],
      },
      structuredReturnTypes: {
        "ApplicationRecord#account": { form: "instance", name: "Account" },
      },
      classAncestors: {
        User: ["ApplicationRecord"],
      },
    });
    expect(typeOfReceiver("u.account", 5, ctx)).toEqual({ form: "instance", name: "Account" });
  });

  it("direct class entry wins over ancestor", () => {
    const ctx = emptyCtx({
      localBindings: {
        u: [{ line: 1, type: "User", valueKind: "instance" }],
      },
      structuredReturnTypes: {
        "User#account": { form: "instance", name: "UserAccount" },
        "ApplicationRecord#account": { form: "instance", name: "BaseAccount" },
      },
      classAncestors: {
        User: ["ApplicationRecord"],
      },
    });
    expect(typeOfReceiver("u.account", 5, ctx)).toEqual({ form: "instance", name: "UserAccount" });
  });
});
