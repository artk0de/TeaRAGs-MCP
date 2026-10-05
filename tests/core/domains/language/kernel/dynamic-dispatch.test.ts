/**
 * K1 kernel dynamic dispatch (bd tea-rags-mcp-m99j1.1.14): an untyped receiver
 * resolves its member by short name and fans out over the survivors of the
 * kernel narrowing cascade. The language supplies the gate runner
 * (`suppressed`), the short-name lookup, the cascade options, the discount, the
 * population and an optional tighter cap; the kernel owns the order — gate,
 * lookup, cascade, terminal.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, CallRef, SymbolDefinition } from "../../../../../src/core/contracts/types/codegraph.js";
import type { DispatchFanoutPopulation } from "../../../../../src/core/contracts/types/language.js";
import {
  DynamicDispatchResolver,
  receiverIsAssignedLocal,
  type DynamicDispatchPorts,
  type ExactChainAnswerProbe,
} from "../../../../../src/core/domains/language/kernel/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const ctx: CallContext = {
  callerFile: "app/caller.rb",
  callerScope: [],
  imports: [],
  symbolTable: new InMemoryGlobalSymbolTable(),
};

const def = (id: string, arity?: SymbolDefinition["arity"]): SymbolDefinition => ({
  symbolId: id,
  fqName: id,
  shortName: id.split("#")[1] ?? id,
  relPath: `${id.split("#")[0]}.rb`,
  scope: [],
  arity,
});

const call = (member: string, argCount?: number): CallRef => ({
  callText: `x.${member}`,
  receiver: "x",
  member,
  startLine: 1,
  argCount,
});

const population: DispatchFanoutPopulation = {
  family: "k1-test",
  ownsPath: (relPath) => relPath.endsWith(".rb"),
  calleeKinds: new Set(["method"]),
};

const ports = (over: Partial<DynamicDispatchPorts> = {}): DynamicDispatchPorts => ({
  suppressed: () => false,
  lookupByShortName: (c) => [def(`A#${c.member}`), def(`B#${c.member}`)],
  cascade: {},
  discount: 0.6,
  population,
  ...over,
});

describe("DynamicDispatchResolver (K1)", () => {
  it("returns an empty fan-out when the language gate runner suppresses the call", () => {
    let looked = false;
    const resolver = new DynamicDispatchResolver(
      ports({
        suppressed: () => true,
        lookupByShortName: () => {
          looked = true;
          return [def("A#m")];
        },
      }),
    );
    expect(resolver.resolveDispatch(call("m"), ctx)).toEqual({ kind: "edges", edges: [] });
    expect(looked).toBe(false);
  });

  it("returns an empty fan-out when the short-name lookup finds nothing", () => {
    const resolver = new DynamicDispatchResolver(ports({ lookupByShortName: () => [] }));
    expect(resolver.resolveDispatch(call("m"), ctx)).toEqual({ kind: "edges", edges: [] });
  });

  it("narrows the candidates through the kernel cascade built from the language options", () => {
    const resolver = new DynamicDispatchResolver(
      ports({
        lookupByShortName: () => [
          def("A#m", { minRequired: 2, maxPositional: 2, hasSplat: false }),
          def("B#m", { minRequired: 0, maxPositional: 1, hasSplat: false }),
        ],
      }),
    );
    // Arity narrows to B#m alone → one survivor, confidence 1.0.
    expect(resolver.resolveDispatch(call("m", 1), ctx)).toEqual({
      kind: "edges",
      edges: [
        { sourceSymbolId: null, targetRelPath: "B.rb", targetSymbolId: "B#m", edgeKind: "dynamic", confidence: 1 },
      ],
    });
  });

  it("applies the language cascade options — a duck-vocabulary member empties the set", () => {
    const resolver = new DynamicDispatchResolver(ports({ cascade: { duckVocabulary: new Set(["each"]) } }));
    expect(resolver.resolveDispatch(call("each"), ctx)).toEqual({ kind: "edges", edges: [] });
  });

  it("returns `ambiguous` when the survivors exceed the language cap", () => {
    const resolver = new DynamicDispatchResolver(
      ports({ cap: 2, lookupByShortName: () => [def("A#m"), def("B#m"), def("C#m")] }),
    );
    expect(resolver.resolveDispatch(call("m"), ctx)).toEqual({ kind: "ambiguous", member: "m", candidateCount: 3 });
  });

  it("splits the language discount over the survivors", () => {
    const resolver = new DynamicDispatchResolver(ports({ discount: 0.6 }));
    const outcome = resolver.resolveDispatch(call("m"), ctx);
    expect(outcome.kind).toBe("edges");
    if (outcome.kind !== "edges") return;
    expect(outcome.edges.map((e) => [e.targetSymbolId, e.confidence])).toEqual([
      ["A#m", 0.3],
      ["B#m", 0.3],
    ]);
  });

  it("lets the gate runner consult an ExactChainAnswerProbe — an answered call never fans out", () => {
    const probe: ExactChainAnswerProbe = { answers: (c) => c.member === "answered" };
    const resolver = new DynamicDispatchResolver(ports({ suppressed: (c, cx) => probe.answers(c, cx) }));
    expect(resolver.resolveDispatch(call("answered"), ctx)).toEqual({ kind: "edges", edges: [] });
    expect(resolver.resolveDispatch(call("open"), ctx).kind).toBe("edges");
  });
});

describe("receiverIsAssignedLocal (bd tea-rags-mcp-m99j1.1.59)", () => {
  it("answers true only when the caller's def assigns the exact receiver name", () => {
    const assigned: CallContext = { ...ctx, assignedLocals: ["x", "conn"] };
    expect(receiverIsAssignedLocal(call("bar"), assigned)).toBe(true);
    expect(receiverIsAssignedLocal({ ...call("bar"), receiver: "y" }, assigned)).toBe(false);
    expect(receiverIsAssignedLocal({ ...call("bar"), receiver: "x.y" }, assigned)).toBe(false);
  });

  it("answers false when the chunk carries no assigned locals or the call has no receiver", () => {
    expect(receiverIsAssignedLocal(call("bar"), ctx)).toBe(false);
    expect(receiverIsAssignedLocal({ ...call("bar"), receiver: null }, { ...ctx, assignedLocals: ["x"] })).toBe(false);
  });
});
