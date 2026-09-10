import { describe, expect, it } from "vitest";

import type { CallRef, SymbolDefinition } from "../../../../../src/core/contracts/types/codegraph.js";
import { buildDispatchCascade } from "../../../../../src/core/domains/language/kernel/dispatch-cascade.js";
import {
  ArityNarrower,
  BlockNarrower,
  DuckVocabularyNarrower,
  KwargNarrower,
  LiteralReceiverNarrower,
  VisibilityNarrower,
} from "../../../../../src/core/domains/language/kernel/dispatch-narrowing.js";

const def = (id: string): SymbolDefinition => ({
  symbolId: id,
  fqName: id,
  shortName: id.split("#")[1] ?? id,
  relPath: `${id}.rb`,
  scope: ["String"],
});
const call = (member: string, receiver: string | null = "x"): CallRef => ({
  callText: `${receiver ?? ""}.${member}`,
  receiver,
  member,
  startLine: 1,
});
const ctx = {} as never;

/** Run the whole cascade the way `resolveNarrowedFanout` does. */
const survivors = (
  cascade: readonly { narrow: (c: CallRef, s: SymbolDefinition[], x: never) => SymbolDefinition[] }[],
  c: CallRef,
  candidates: SymbolDefinition[],
): SymbolDefinition[] => cascade.reduce((s, n) => n.narrow(c, s, ctx), candidates);

describe("buildDispatchCascade", () => {
  it("with no language data → the four signature narrowers, in order", () => {
    const cascade = buildDispatchCascade();
    expect(cascade).toHaveLength(4);
    expect(cascade[0]).toBeInstanceOf(ArityNarrower);
    expect(cascade[1]).toBeInstanceOf(KwargNarrower);
    expect(cascade[2]).toBeInstanceOf(VisibilityNarrower);
    expect(cascade[3]).toBeInstanceOf(BlockNarrower);
  });

  it("a duck vocabulary prepends DuckVocabularyNarrower FIRST", () => {
    const cascade = buildDispatchCascade({ duckVocabulary: new Set(["each"]) });
    expect(cascade).toHaveLength(5);
    expect(cascade[0]).toBeInstanceOf(DuckVocabularyNarrower);
    expect(cascade[1]).toBeInstanceOf(ArityNarrower);
  });

  it("a literal classifier alone prepends LiteralReceiverNarrower FIRST", () => {
    const cascade = buildDispatchCascade({ classifyLiteralReceiver: () => null });
    expect(cascade).toHaveLength(5);
    expect(cascade[0]).toBeInstanceOf(LiteralReceiverNarrower);
    expect(cascade[1]).toBeInstanceOf(ArityNarrower);
  });

  it("both injections → Ruby's exact six, duck before literal before the signature four", () => {
    const cascade = buildDispatchCascade({
      duckVocabulary: new Set(["each"]),
      classifyLiteralReceiver: () => null,
    });
    expect(cascade.map((n) => n.constructor.name)).toEqual([
      "DuckVocabularyNarrower",
      "LiteralReceiverNarrower",
      "ArityNarrower",
      "KwargNarrower",
      "VisibilityNarrower",
      "BlockNarrower",
    ]);
  });

  it("empties the candidate set for a member in the injected duck vocabulary", () => {
    const cascade = buildDispatchCascade({ duckVocabulary: new Set(["each"]) });
    expect(survivors(cascade, call("each"), [def("A#each")])).toEqual([]);
    expect(survivors(cascade, call("perform"), [def("A#perform")])).toHaveLength(1);
  });

  it("keeps only candidates reopening the literal receiver's core type", () => {
    const cascade = buildDispatchCascade({
      classifyLiteralReceiver: (receiver) => (receiver === '"s"' ? "String" : null),
    });
    const candidates = [def("String#m"), { ...def("Other#m"), scope: ["Other"] }];
    expect(survivors(cascade, call("m", '"s"'), candidates).map((c) => c.symbolId)).toEqual(["String#m"]);
    expect(survivors(cascade, call("m", "obj"), candidates)).toHaveLength(2);
  });
});
