import { describe, expect, it } from "vitest";

import type { AritySignature, CallRef, SymbolDefinition } from "../../../../src/core/contracts/types/codegraph.js";

describe("xlnub substrate fields", () => {
  it("AritySignature carries the positional arity envelope", () => {
    const a: AritySignature = {
      minRequired: 1,
      maxPositional: 2,
      hasSplat: false,
    };
    expect(a.minRequired).toBe(1);
    expect(a.maxPositional).toBe(2);
    expect(a.hasSplat).toBe(false);
  });

  it("SymbolDefinition.arity/visibility are OPTIONAL (legacy row still valid)", () => {
    const legacy: SymbolDefinition = {
      symbolId: "A#m",
      fqName: "A#m",
      shortName: "m",
      relPath: "a.rb",
      scope: ["A"],
    };
    expect(legacy.arity).toBeUndefined();
    expect(legacy.visibility).toBeUndefined();
    const enriched: SymbolDefinition = {
      ...legacy,
      arity: { minRequired: 0, maxPositional: 0, hasSplat: false },
      visibility: "private",
    };
    expect(enriched.visibility).toBe("private");
  });

  it("CallRef.argCount is OPTIONAL", () => {
    const call: CallRef = {
      callText: "x.m(1)",
      receiver: "x",
      member: "m",
      startLine: 1,
      argCount: 1,
    };
    expect(call.argCount).toBe(1);
  });
});
