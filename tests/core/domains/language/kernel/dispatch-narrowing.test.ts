import { describe, expect, it } from "vitest";

import type { CallRef, SymbolDefinition } from "../../../../../src/core/contracts/types/codegraph.js";
import {
  ArityNarrower,
  BlockNarrower,
  DuckVocabularyNarrower,
  KwargNarrower,
  LiteralReceiverNarrower,
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

  // extra-unknown-kwarg direction (bd d9o7o Spec #2 B1): a passed key the def
  // cannot accept (not declared, no ** splat) → ArgumentError → drop.
  const withOpt = (id: string, required: string[], optional: string[], hasSplat = false): SymbolDefinition => ({
    ...kdef(id, required, hasSplat),
    kwargs: { required, optional, hasSplat },
  });

  it("drops a candidate when the call passes an undeclared kwarg key (no ** splat)", () => {
    const cands = [withOpt("A#m", [], ["limit"]), withOpt("B#m", [], ["offset"])];
    expect(new KwargNarrower().narrow(kcall(["limit"]), cands, ctx).map((c) => c.symbolId)).toEqual(["A#m"]);
  });
  it("keeps a def with ** splat even on an undeclared key", () => {
    const cands = [withOpt("A#m", [], [], true)];
    expect(new KwargNarrower().narrow(kcall(["whatever"]), cands, ctx).length).toBe(1);
  });
  it("keeps a def whose declared set (required ∪ optional) covers every passed key", () => {
    const cands = [withOpt("A#m", ["mode"], ["limit"])];
    expect(new KwargNarrower().narrow(kcall(["mode", "limit"]), cands, ctx).length).toBe(1);
  });
  it("skips the extra-unknown check when optional is not captured (conservative keep)", () => {
    // kdef → kwargs.optional undefined ⇒ full declared set unknown ⇒ keep.
    expect(new KwargNarrower().narrow(kcall(["anything"]), [kdef("A#m", [])], ctx).length).toBe(1);
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

describe("LiteralReceiverNarrower", () => {
  // Toy classifier: string literal → String, array literal → Array, else null.
  const classify = (r: string | null): string | null =>
    r === null ? null : r.startsWith('"') ? "String" : r.startsWith("[") ? "Array" : null;
  const sdef = (id: string, scope: string[]): SymbolDefinition => ({
    symbolId: id,
    fqName: id,
    shortName: id.split("#")[1] ?? id,
    relPath: `${id}.rb`,
    scope,
  });
  const litCall = (receiver: string): CallRef => ({ callText: `${receiver}.m`, receiver, member: "m", startLine: 1 });

  it("keeps only in-project reopens of the literal's core type", () => {
    const cands = [sdef("String#m", ["String"]), sdef("Foo#m", ["Foo"])];
    expect(new LiteralReceiverNarrower(classify).narrow(litCall('"s"'), cands, ctx).map((c) => c.symbolId)).toEqual([
      "String#m",
    ]);
  });
  it("empties the fan-out when no candidate reopens the core type", () => {
    const cands = [sdef("Foo#m", ["Foo"]), sdef("Bar#m", ["Bar"])];
    expect(new LiteralReceiverNarrower(classify).narrow(litCall('"s"'), cands, ctx)).toEqual([]);
  });
  it("keeps all when the receiver is not a recognised literal", () => {
    const cands = [sdef("Foo#m", ["Foo"])];
    expect(new LiteralReceiverNarrower(classify).narrow(litCall("user"), cands, ctx).length).toBe(1);
  });
});

describe("resolveNarrowedFanout terminal", () => {
  const arity0 = { minRequired: 0, maxPositional: 0, hasSplat: false };
  // Flat 1-def-per-member corpus → adaptive cap sits at the floor (16).
  const fanCtx = {
    symbolTable: {
      upsertFile: () => undefined,
      removeFile: () => undefined,
      lookup: () => [],
      lookupByShortName: () => [],
      size: () => 0,
      hydrate: () => undefined,
      shortNameDefCounts: () => new Map([["m", 1]]),
    },
  } as never;
  it("1 survivor → one edge confidence 1.0", () => {
    const outcome = resolveNarrowedFanout(
      call("m", 1),
      [def("A#m", { minRequired: 1, maxPositional: 1, hasSplat: false }), def("B#m", arity0)],
      fanCtx,
      [new ArityNarrower()],
      0.3,
    );
    expect(outcome).toEqual({
      kind: "edges",
      edges: [
        {
          sourceSymbolId: null,
          targetRelPath: "A#m.rb",
          targetSymbolId: "A#m",
          edgeKind: "dynamic",
          confidence: 1.0,
        },
      ],
    });
  });
  it("m>1 survivors → m edges confidence discount/m", () => {
    const outcome = resolveNarrowedFanout(call("m"), [def("A#m"), def("B#m")], fanCtx, [], 0.3);
    if (outcome.kind !== "edges") throw new Error("expected edges");
    expect(outcome.edges.map((e) => e.confidence)).toEqual([0.15, 0.15]);
    expect(outcome.edges.every((e) => e.edgeKind === "dynamic")).toBe(true);
  });
  it("0 survivors → empty edges", () => {
    expect(
      resolveNarrowedFanout(
        call("to_s"),
        [def("A#to_s")],
        fanCtx,
        [new DuckVocabularyNarrower(new Set(["to_s"]))],
        0.3,
      ),
    ).toEqual({ kind: "edges", edges: [] });
  });
  it("survivors above the adaptive cap → ambiguous outcome, NO edges (bd f2jsb)", () => {
    const candidates = Array.from({ length: 17 }, (_, i) => def(`C${i}#firm`)); // 17 > floor cap 16
    const outcome = resolveNarrowedFanout(call("firm"), candidates, fanCtx, [], 0.3);
    expect(outcome).toEqual({ kind: "ambiguous", member: "firm", candidateCount: 17 });
  });
  it("survivors exactly at the cap still materialize edges", () => {
    const candidates = Array.from({ length: 16 }, (_, i) => def(`C${i}#firm`));
    const outcome = resolveNarrowedFanout(call("firm"), candidates, fanCtx, [], 0.32);
    if (outcome.kind !== "edges") throw new Error("expected edges");
    expect(outcome.edges).toHaveLength(16);
    expect(outcome.edges[0].confidence).toBeCloseTo(0.02);
  });
});
