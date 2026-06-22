/**
 * Receiver-kind classifier tests (bd tea-rags-mcp-j431). Pure function over a
 * CallRef + the chunk's localBindings — no resolver, no symbol table. Drives
 * the per-idiom resolveSuccessRate breakdown so each cai0 slice proves a delta
 * on its own bucket.
 */
import { describe, expect, it } from "vitest";

import type { CallRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import { SUPER_RECEIVER_SENTINEL } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";
import { classifyReceiverKind } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/receiver-kind.js";

function call(receiver: string | null, member = "m"): CallRef {
  return { callText: `${receiver ?? ""}.${member}`, receiver, member, startLine: 1 };
}

describe("classifyReceiverKind (bd j431)", () => {
  it("null receiver → bareCall", () => {
    expect(classifyReceiverKind(call(null), {})).toBe("bareCall");
  });

  it("super sentinel → super", () => {
    expect(classifyReceiverKind(call(SUPER_RECEIVER_SENTINEL), {})).toBe("super");
  });

  it("self receiver → selfMember", () => {
    expect(classifyReceiverKind(call("self"), {})).toBe("selfMember");
  });

  it("constant receiver → constant", () => {
    expect(classifyReceiverKind(call("User"), {})).toBe("constant");
    expect(classifyReceiverKind(call("Acme::Auth::Login"), {})).toBe("constant");
  });

  it("receiver bound to a local type → localVar", () => {
    expect(classifyReceiverKind(call("user"), { user: "User" })).toBe("localVar");
  });

  it("unbound bare identifier → dynamic (residual true-dynamic)", () => {
    expect(classifyReceiverKind(call("items"), {})).toBe("dynamic");
    expect(classifyReceiverKind(call("obj"), { other: "X" })).toBe("dynamic");
  });

  // bd tea-rags-mcp-7m5xz follow-up — split the former `dynamic` lump into
  // ivar / chain / index sub-idioms by receiver source markers (@, ., [).
  describe("dynamic sub-classification (ivar/chain/index)", () => {
    it("instance/class variable receiver → ivar", () => {
      expect(classifyReceiverKind(call("@foo"), {})).toBe("ivar");
      expect(classifyReceiverKind(call("@@foo"), {})).toBe("ivar");
    });

    it("element-reference receiver → index (precedence over chain/ivar)", () => {
      expect(classifyReceiverKind(call("obj[k]"), {})).toBe("index");
      // `@foo[k]` has both `[` and `@` — `[` wins.
      expect(classifyReceiverKind(call("@foo[k]"), {})).toBe("index");
    });

    it("method-chain receiver → chain (precedence over ivar)", () => {
      expect(classifyReceiverKind(call("a.b"), {})).toBe("chain");
      // `@x.y` has both `.` and `@` — `.` wins (decomposition: outer call's
      // receiver `@x.y` is a chain; the inner `@x` is separately an ivar).
      expect(classifyReceiverKind(call("@x.y"), {})).toBe("chain");
      // safe navigation still carries a `.`
      expect(classifyReceiverKind(call("a&.b"), {})).toBe("chain");
    });
  });

  it("super sentinel wins over constant-shaped check", () => {
    // sentinel begins with '<', never matches the constant regex anyway, but
    // the explicit super branch must take precedence regardless of ordering.
    expect(classifyReceiverKind(call(SUPER_RECEIVER_SENTINEL, "save"), { x: "Y" })).toBe("super");
  });
});
