import { describe, expect, it, vi } from "vitest";

import type {
  CallContext,
  CallRef,
  DispatchEdge,
  DispatchFanoutOutcome,
  SymbolResolutionTarget,
} from "../../../../src/core/contracts/types/codegraph.js";
import type {
  DispatchResolverComponent,
  SymbolResolutionOutcome,
  SymbolResolutionStrategy,
} from "../../../../src/core/contracts/types/language.js";
import { resolveDispatchViaComponents, resolveViaChain } from "../../../../src/core/domains/language/resolver-chain.js";

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

const edge = (rel: string): DispatchEdge =>
  ({
    sourceSymbolId: null,
    targetRelPath: rel,
    targetSymbolId: null,
    edgeKind: "dynamic",
    confidence: 1,
  }) as DispatchEdge;
const component = (edges: DispatchEdge[]): DispatchResolverComponent => ({
  resolveDispatch: () => ({ kind: "edges", edges }),
});

// bd f2jsb: resolveDispatch now returns DispatchFanoutOutcome; existing
// assertions target the edges payload, so unwrap (throwing on `ambiguous`
// keeps the assertion strict — these fixtures never exceed the fan-out cap).
const edgesOf = (outcome: DispatchFanoutOutcome): DispatchEdge[] => {
  if (outcome.kind !== "edges") throw new Error(`expected edges outcome, got ${outcome.kind}`);
  return outcome.edges;
};

describe("resolveDispatchViaComponents", () => {
  it("returns the first non-empty component result (precedence = array order)", () => {
    const result = resolveDispatchViaComponents(
      [component([]), component([edge("a.rb")]), component([edge("b.rb")])],
      call,
      ctx,
    );
    expect(edgesOf(result)).toEqual([edge("a.rb")]);
  });

  it("returns [] when every component is empty", () => {
    expect(edgesOf(resolveDispatchViaComponents([component([]), component([])], call, ctx))).toEqual([]);
  });
});
