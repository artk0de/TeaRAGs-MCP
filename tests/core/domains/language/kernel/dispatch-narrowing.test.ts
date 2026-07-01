import { describe, expect, it } from "vitest";

import type { CallRef, SymbolDefinition } from "../../../../../src/core/contracts/types/codegraph.js";
import {
  ArityNarrower,
  BlockNarrower,
  DuckVocabularyNarrower,
  KwargNarrower,
  resolveNarrowedFanout,
  VisibilityNarrower,
} from "../../../../../src/core/domains/language/kernel/dispatch-narrowing.js";

const def = (
  id: string,
  arity?: SymbolDefinition["arity"],
  visibility?: SymbolDefinition["visibility"],
): SymbolDefinition => ({
  symbolId: id,
  fqName: id,
  shortName: id.split("#")[1] ?? id,
  relPath: `${id}.rb`,
  scope: [],
  arity,
  visibility,
});
const call = (member: string, argCount?: number): CallRef => ({
  callText: `x.${member}`,
  receiver: "x",
  member,
  startLine: 1,
  argCount,
});
const ctx = {} as never;

describe("ArityNarrower", () => {
  it("drops a candidate whose minRequired exceeds argCount", () => {
    const cands = [
      def("A#m", { minRequired: 2, maxPositional: 2, hasSplat: false }),
      def("B#m", { minRequired: 0, maxPositional: 1, hasSplat: false }),
    ];
    expect(new ArityNarrower().narrow(call("m", 1), cands, ctx).map((c) => c.symbolId)).toEqual(["B#m"]);
  });
  it("drops a candidate whose argCount exceeds maxPositional without splat", () => {
    const cands = [
      def("A#m", { minRequired: 0, maxPositional: 1, hasSplat: false }),
      def("B#m", { minRequired: 0, maxPositional: 0, hasSplat: true }),
    ];
    expect(new ArityNarrower().narrow(call("m", 3), cands, ctx).map((c) => c.symbolId)).toEqual(["B#m"]);
  });
  it("keeps candidates with no recorded arity OR a call with no argCount", () => {
    const cands = [def("A#m"), def("B#m", { minRequired: 5, maxPositional: 5, hasSplat: false })];
    expect(new ArityNarrower().narrow(call("m", undefined), cands, ctx).length).toBe(2); // no argCount → keep all
    expect(new ArityNarrower().narrow(call("m", 0), [def("A#m")], ctx).length).toBe(1); // no arity → keep
  });
});

describe("KwargNarrower", () => {
  const kdef = (id: string, required: string[], hasSplat = false): SymbolDefinition => ({
    symbolId: id,
    fqName: id,
    shortName: id.split("#")[1] ?? id,
    relPath: `${id}.rb`,
    scope: [],
    kwargs: { required, hasSplat },
  });
  const kcall = (kwargKeys?: string[], hasKwargSplat?: boolean): CallRef => ({
    callText: "x.m",
    receiver: "x",
    member: "m",
    startLine: 1,
    kwargKeys,
    hasKwargSplat,
  });

  it("drops a candidate whose required kwarg the call omits", () => {
    const cands = [kdef("A#m", ["b", "c"]), kdef("B#m", ["b"])];
    expect(new KwargNarrower().narrow(kcall(["b"]), cands, ctx).map((c) => c.symbolId)).toEqual(["B#m"]);
  });
  it("keeps all when the call passes a ** double-splat (unknown runtime keys)", () => {
    const cands = [kdef("A#m", ["b", "c"])];
    expect(new KwargNarrower().narrow(kcall(["b"], true), cands, ctx).length).toBe(1);
  });
  it("keeps a candidate with no recorded kwargs (missing data)", () => {
    expect(new KwargNarrower().narrow(kcall(["z"]), [def("P#m")], ctx).length).toBe(1);
  });
  it("keeps all when the call has no captured kwargKeys", () => {
    expect(new KwargNarrower().narrow(kcall(undefined), [kdef("A#m", ["b"])], ctx).length).toBe(1);
  });
});

describe("VisibilityNarrower", () => {
  it("drops private candidates under explicit receiver, keeps protected/public/unknown", () => {
    const cands = [
      def("A#m", undefined, "private"),
      def("B#m", undefined, "protected"),
      def("C#m", undefined, "public"),
      def("D#m"),
    ];
    expect(new VisibilityNarrower().narrow(call("m"), cands, ctx).map((c) => c.symbolId)).toEqual([
      "B#m",
      "C#m",
      "D#m",
    ]);
  });
});

describe("BlockNarrower", () => {
  const bdef = (id: string, acceptsBlock?: boolean): SymbolDefinition => ({
    symbolId: id,
    fqName: id,
    shortName: id.split("#")[1] ?? id,
    relPath: `${id}.rb`,
    scope: [],
    acceptsBlock,
  });
  const bcall = (passesBlock?: boolean): CallRef => ({
    callText: "x.m",
    receiver: "x",
    member: "m",
    startLine: 1,
    passesBlock,
  });

  it("keeps only yielders (true/undefined) when a block is passed and yielders exist", () => {
    const cands = [bdef("A#m", true), bdef("B#m", false), bdef("C#m", undefined)];
    expect(new BlockNarrower().narrow(bcall(true), cands, ctx).map((c) => c.symbolId)).toEqual(["A#m", "C#m"]);
  });
  it("keeps ALL when every candidate is a proven non-yielder (defensive block / missed detection)", () => {
    const cands = [bdef("A#m", false), bdef("B#m", false)];
    expect(new BlockNarrower().narrow(bcall(true), cands, ctx).length).toBe(2);
  });
  it("keeps all when the call passes no block", () => {
    const cands = [bdef("A#m", false)];
    expect(new BlockNarrower().narrow(bcall(false), cands, ctx).length).toBe(1);
    expect(new BlockNarrower().narrow(bcall(undefined), cands, ctx).length).toBe(1);
  });
});

describe("DuckVocabularyNarrower", () => {
  it("empties the set when member is in the vocabulary", () => {
    const n = new DuckVocabularyNarrower(new Set(["to_s", "each"]));
    expect(n.narrow(call("to_s"), [def("A#to_s")], ctx)).toEqual([]);
    expect(n.narrow(call("perform"), [def("A#perform")], ctx).length).toBe(1);
  });
});

describe("resolveNarrowedFanout terminal", () => {
  const arity0 = { minRequired: 0, maxPositional: 0, hasSplat: false };
  it("1 survivor → one edge confidence 1.0", () => {
    const edges = resolveNarrowedFanout(
      call("m", 1),
      [def("A#m", { minRequired: 1, maxPositional: 1, hasSplat: false }), def("B#m", arity0)],
      ctx,
      [new ArityNarrower()],
      0.3,
    );
    expect(edges).toEqual([
      {
        sourceSymbolId: null,
        targetRelPath: "A#m.rb",
        targetSymbolId: "A#m",
        edgeKind: "dynamic",
        confidence: 1.0,
      },
    ]);
  });
  it("m>1 survivors → m edges confidence discount/m", () => {
    const edges = resolveNarrowedFanout(call("m"), [def("A#m"), def("B#m")], ctx, [], 0.3);
    expect(edges.map((e) => e.confidence)).toEqual([0.15, 0.15]);
    expect(edges.every((e) => e.edgeKind === "dynamic")).toBe(true);
  });
  it("0 survivors → []", () => {
    expect(
      resolveNarrowedFanout(call("to_s"), [def("A#to_s")], ctx, [new DuckVocabularyNarrower(new Set(["to_s"]))], 0.3),
    ).toEqual([]);
  });
});
