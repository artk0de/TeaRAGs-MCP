import { describe, expect, it, vi } from "vitest";

import type { CallContext, CallRef, SymbolResolutionTarget } from "../../../../src/core/contracts/types/codegraph.js";
import type {
  SymbolResolutionOutcome,
  SymbolResolutionStrategy,
} from "../../../../src/core/contracts/types/language.js";
import { resolveViaChain } from "../../../../src/core/domains/language/resolver-chain.js";

const target = (id: string): SymbolResolutionTarget =>
  ({ targetRelPath: "a.ts", targetSymbolId: id }) as unknown as SymbolResolutionTarget;
const strategy = (name: string, outcome: SymbolResolutionOutcome): SymbolResolutionStrategy => ({
  name,
  attempt: vi.fn().mockReturnValue(outcome),
});
const resolved = (id: string): SymbolResolutionOutcome => ({ kind: "resolved", target: target(id) });
const DROP: SymbolResolutionOutcome = { kind: "drop" };
const CONTINUE: SymbolResolutionOutcome = { kind: "continue" };
const call = {} as CallRef;
const ctx = {} as CallContext;

describe("resolveViaChain", () => {
  it("returns the first resolved hit and short-circuits later strategies", () => {
    const second = strategy("second", resolved("Second#m"));
    const third = strategy("third", resolved("Third#m"));
    const result = resolveViaChain([strategy("first", CONTINUE), second, third], call, ctx);
    expect(result?.targetSymbolId).toBe("Second#m");
    // precedence: earlier wins, later strategy is never consulted
    expect(third.attempt).not.toHaveBeenCalled();
  });

  it("stops the chain and returns null on a drop, never consulting later strategies", () => {
    const guard = strategy("guard", DROP);
    const later = strategy("later", resolved("Later#m"));
    const result = resolveViaChain([strategy("first", CONTINUE), guard, later], call, ctx);
    expect(result).toBeNull();
    // drop is decisive: a later strategy that WOULD resolve must not be reached
    expect(later.attempt).not.toHaveBeenCalled();
  });

  it("returns null when every strategy continues", () => {
    expect(resolveViaChain([strategy("a", CONTINUE), strategy("b", CONTINUE)], call, ctx)).toBeNull();
  });

  it("returns null for an empty chain", () => {
    expect(resolveViaChain([], call, ctx)).toBeNull();
  });
});
