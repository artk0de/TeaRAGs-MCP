import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type NamedSymbol,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import { firstDefinerAfter } from "../../../../../../../src/core/domains/language/ruby/resolver/strategies/shared.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

// Mirrors the harness in strategies.test.ts.
const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

const tableWith = (...files: [string, NamedSymbol[]][]): InMemoryGlobalSymbolTable => {
  const t = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of files) t.upsertFile(relPath, defs);
  return t;
};

const ctx = (over: Partial<CallContext> & Pick<CallContext, "symbolTable">): CallContext => ({
  callerFile: "caller.rb",
  callerScope: [],
  imports: [],
  ...over,
});

describe("firstDefinerAfter — MRO after X (cai0/2oky5)", () => {
  it("finds the next definer after an INCLUDED module in C's ancestor chain", () => {
    // class C: ancestors [M, Base]; Base defines `m`. super from M#m → Base#m.
    const symbolTable = tableWith([
      "base.rb",
      [sym("Base", "Base", "base.rb", []), sym("Base#m", "m", "base.rb", ["Base"])],
    ]);
    const t = firstDefinerAfter(
      "M",
      "m",
      "C",
      ctx({ symbolTable, classAncestors: { C: ["M", "Base"] } }),
      DEFAULT_AMBIGUOUS_RESOLVE_MODE,
    );
    expect(t).toEqual({ targetRelPath: "base.rb", targetSymbolId: "Base#m" });
  });

  it("skips PAST a prepended module to the class itself (Wrapper → Agent)", () => {
    // Agent prepends Wrapper; Agent defines `save`. super from Wrapper#save → Agent#save.
    const symbolTable = tableWith([
      "agent.rb",
      [sym("Agent", "Agent", "agent.rb", []), sym("Agent#save", "save", "agent.rb", ["Agent"])],
    ]);
    const t = firstDefinerAfter(
      "Wrapper",
      "save",
      "Agent",
      ctx({ symbolTable, classPrependedAncestors: { Agent: ["Wrapper"] } }),
      DEFAULT_AMBIGUOUS_RESOLVE_MODE,
    );
    expect(t).toEqual({ targetRelPath: "agent.rb", targetSymbolId: "Agent#save" });
  });

  it("returns null when startAfter is not in klass's MRO", () => {
    const symbolTable = tableWith([
      "base.rb",
      [sym("Base", "Base", "base.rb", []), sym("Base#m", "m", "base.rb", ["Base"])],
    ]);
    expect(
      firstDefinerAfter(
        "NotInChain",
        "m",
        "C",
        ctx({ symbolTable, classAncestors: { C: ["Base"] } }),
        DEFAULT_AMBIGUOUS_RESOLVE_MODE,
      ),
    ).toBeNull();
  });

  it("reorders walker-stored [superclass, include] to Ruby MRO [include, superclass] via classExtends (cai0/2oky5 Task 5)", () => {
    // Walker stores classAncestors["Sub"] = ["Base", "M"] (superclass FIRST).
    // Ruby MRO is [M, Base] — includes before the superclass.
    // classExtends["Sub"] = "Base" identifies the superclass so mroOrderedChain
    // can move it last, making firstDefinerAfter("M","m","Sub") find Base#m.
    const symbolTable = tableWith([
      "base.rb",
      [sym("Base", "Base", "base.rb", []), sym("Base#m", "m", "base.rb", ["Base"])],
    ]);
    const t = firstDefinerAfter(
      "M",
      "m",
      "Sub",
      ctx({
        symbolTable,
        classAncestors: { Sub: ["Base", "M"] }, // walker order: superclass first
        classExtends: { Sub: "Base" },
      }),
      DEFAULT_AMBIGUOUS_RESOLVE_MODE,
    );
    expect(t).toEqual({ targetRelPath: "base.rb", targetSymbolId: "Base#m" });
  });
});
