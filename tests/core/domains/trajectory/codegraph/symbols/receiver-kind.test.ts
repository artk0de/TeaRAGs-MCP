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

  it("unbound lowercase receiver → dynamic", () => {
    expect(classifyReceiverKind(call("items"), {})).toBe("dynamic");
    expect(classifyReceiverKind(call("obj"), { other: "X" })).toBe("dynamic");
  });

  it("super sentinel wins over constant-shaped check", () => {
    // sentinel begins with '<', never matches the constant regex anyway, but
    // the explicit super branch must take precedence regardless of ordering.
    expect(classifyReceiverKind(call(SUPER_RECEIVER_SENTINEL, "save"), { x: "Y" })).toBe("super");
  });
});
