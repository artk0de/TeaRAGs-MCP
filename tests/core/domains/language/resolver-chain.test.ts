import { describe, expect, it, vi } from "vitest";

import type { CallContext, CallRef, ResolvedTarget } from "../../../../src/core/contracts/types/codegraph.js";
import type { ResolverComponent } from "../../../../src/core/contracts/types/language.js";
import { resolveViaChain } from "../../../../src/core/domains/language/resolver-chain.js";

const target = (id: string): ResolvedTarget =>
  ({ targetRelPath: "a.ts", targetSymbolId: id }) as unknown as ResolvedTarget;
const component = (hit: ResolvedTarget | null): ResolverComponent => ({
  resolve: vi.fn().mockReturnValue(hit),
});
const call = {} as CallRef;
const ctx = {} as CallContext;

describe("resolveViaChain", () => {
  it("returns the first non-null hit and short-circuits later components", () => {
    const second = component(target("Second#m"));
    const third = component(target("Third#m"));
    const result = resolveViaChain([component(null), second, third], call, ctx);
    expect(result?.targetSymbolId).toBe("Second#m");
    // precedence: earlier wins, later component is never consulted
    expect(third.resolve).not.toHaveBeenCalled();
  });

  it("returns null when every component misses", () => {
    expect(resolveViaChain([component(null), component(null)], call, ctx)).toBeNull();
  });

  it("returns null for an empty chain", () => {
    expect(resolveViaChain([], call, ctx)).toBeNull();
  });
});
