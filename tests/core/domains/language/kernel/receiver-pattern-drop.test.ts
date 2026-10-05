import { describe, expect, it, vi } from "vitest";

import { CONTINUE, DROP } from "../../../../../src/core/contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../src/core/contracts/types/codegraph.js";
import { ReceiverPatternDropSymbolResolutionStrategy } from "../../../../../src/core/domains/language/kernel/receiver-pattern-drop.js";

const call = (receiver: string | null): CallRef =>
  ({ callerFile: "a.rb", callerScope: [], callee: "m", receiver, line: 1 }) as unknown as CallRef;
const ctx = {} as CallContext;

describe("ReceiverPatternDropSymbolResolutionStrategy", () => {
  it("exposes the given name", () => {
    expect(new ReceiverPatternDropSymbolResolutionStrategy("x", []).name).toBe("x");
  });

  it("DROPs when the first matching rule matches", () => {
    const s = new ReceiverPatternDropSymbolResolutionStrategy("x", [
      { name: "never", matches: () => false },
      { name: "has-receiver", matches: (c) => c.receiver !== null },
    ]);
    expect(s.attempt(call("foo"), ctx)).toBe(DROP);
  });

  it("CONTINUEs when no rule matches, and with no rules", () => {
    const s = new ReceiverPatternDropSymbolResolutionStrategy("x", [{ name: "r", matches: () => false }]);
    expect(s.attempt(call("foo"), ctx)).toBe(CONTINUE);
    expect(new ReceiverPatternDropSymbolResolutionStrategy("y", []).attempt(call("foo"), ctx)).toBe(CONTINUE);
  });

  it("evaluates rules in order and stops at the first match", () => {
    const order: string[] = [];
    const rule = (name: string, hit: boolean) => ({
      name,
      matches: vi.fn(() => {
        order.push(name);
        return hit;
      }),
    });
    const s = new ReceiverPatternDropSymbolResolutionStrategy("x", [
      rule("a", false),
      rule("b", true),
      rule("c", true),
    ]);
    s.attempt(call("foo"), ctx);
    expect(order).toEqual(["a", "b"]);
  });
});
