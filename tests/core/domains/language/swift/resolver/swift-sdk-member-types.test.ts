/**
 * `SwiftSdkMemberTypes` — the substitution that turns an SDK member's declared
 * type TEXT into the type a receiver's member denotes (bd tea-rags-mcp-y99pg.25).
 *
 * Driven over a small hand-written substrate rather than the generated one, so
 * each rule is pinned by a declaration that exists only to exercise it: generic
 * parameters bound by the receiver's arguments or else by their constraint (as
 * a bound), `Self` / `Self.X`, collection, metatype and function-typed
 * declarations, disagreeing overloads, and the alias chains that must stop
 * rather than loop. The generated substrate's own facts are pinned in
 * `vocabulary/sdk-vocabulary.test.ts`; the resolver-level behaviour in
 * `swift-resolver.test.ts`.
 */

import { describe, expect, it } from "vitest";

import type { TypeRef } from "../../../../../../src/core/contracts/types/language.js";
import {
  boundedBy,
  SwiftSdkMemberTypes,
  type SwiftNominalTypeRef,
} from "../../../../../../src/core/domains/language/swift/resolver/swift-sdk-member-types.js";
import { SwiftSdkVocabulary } from "../../../../../../src/core/domains/language/swift/vocabulary/sdk-vocabulary.js";

const substrate = new SwiftSdkVocabulary({
  v: 1,
  types: {
    Codable: { k: "p", m: {} },
    Int: { k: "s", m: {} },
    String: { k: "s", m: {} },
    Box: {
      k: "s",
      g: ["T"],
      gc: { T: "Codable" },
      t: { Element: "T", Broken: "<<<", Loop: "Self.Loop" },
      m: {
        value: ["p>T"],
        pairs: ["p>[String: T]"],
        kind: ["p>T.Type"],
        handler: ["p>(T) -> Void"],
        both: ["m>T", "m>Int"],
        touch: ["m", "m>T"],
        empty: ["cS"],
        nested: ["m^U:Codable>U.Element"],
        selfish: ["p>Self"],
        elementish: ["p>Self.Element"],
        deep: ["p>Self.A.B"],
        missing: ["p>Self.Missing"],
        broken: ["p>Self.Broken"],
        loop: ["p>Self.Loop"],
        each: ["m|(T, Int) -> Void", "m|(T) -> Void"],
        mixed: ["m|(Int) -> Void", "m|(String) -> Void"],
      },
    },
  },
  functions: { withBox: ["m^V:Codable|(V) -> Void"] },
  labelled: { "make(a:)": ["m>Int", "m"], "mix(a:)": ["m>Int", "m>String"], "bad(a:)": ["m>((("] },
});

const members = new SwiftSdkMemberTypes(substrate);
const ORDER = ["Box"];
const INT: TypeRef = { form: "instance", name: "Int" };
const boxOf = (arg: TypeRef): SwiftNominalTypeRef => ({ form: "instance", name: "Box", args: [arg] });

describe("SwiftSdkMemberTypes.memberType", () => {
  it("binds the declaring type's generic parameter by the receiver's argument, through every type form", () => {
    const box = boxOf(INT);

    expect(members.memberType(box, "value", ORDER)).toEqual(INT);
    expect(members.memberType(box, "pairs", ORDER)).toEqual({
      form: "instance",
      name: "Dictionary",
      args: [{ form: "instance", name: "String" }, INT],
    });
    expect(members.memberType(box, "kind", ORDER)).toEqual({ form: "class", name: "Int" });
    expect(members.memberType(box, "selfish", ORDER)).toEqual(box);
    expect(members.memberType(box, "elementish", ORDER)).toEqual(INT);
  });

  it("binds an unbound generic parameter by its constraint, marked as a bound", () => {
    expect(members.memberType({ form: "instance", name: "Box" }, "value", ORDER)).toEqual({
      form: "instance",
      name: "Codable",
      upperBound: true,
    });
  });

  it("carries a bound receiver's mark onto what its member denotes", () => {
    const bounded: SwiftNominalTypeRef = { ...boxOf(INT), upperBound: true };

    expect(members.memberType(bounded, "value", ORDER)).toEqual({ ...INT, upperBound: true });
    expect(boundedBy({ form: "union", members: [] } as unknown as TypeRef, INT)).toEqual(INT);
  });

  it("skips a Void overload of a hop, whose value is used, and refuses overloads that disagree", () => {
    const box = boxOf(INT);

    expect(members.memberType(box, "touch", ORDER)).toEqual(INT);
    // `-> T` and `-> Int` agree only when the receiver binds `T` to `Int`.
    expect(members.memberType(box, "both", ORDER)).toEqual(INT);
    expect(members.memberType(boxOf({ form: "instance", name: "String" }), "both", ORDER)).toBeUndefined();
  });

  it("reads an enum case as a value of its own type, on the type itself", () => {
    expect(members.memberType({ form: "class", name: "Box" }, "empty", ORDER)).toEqual({
      form: "instance",
      name: "Box",
    });
  });

  it.each([
    ["a function-typed property", "handler"],
    ["an associated type of the member's own generic parameter", "nested"],
    ["a dotted associated-type path", "deep"],
    ["an alias the type does not declare", "missing"],
    ["an alias whose text does not parse", "broken"],
    ["an alias that names itself", "loop"],
    ["a member the substrate does not declare", "absent"],
  ])("types nothing for %s", (_label, member) => {
    expect(members.memberType(boxOf(INT), member, ORDER)).toBeUndefined();
  });
});

describe("SwiftSdkMemberTypes — closure parameters", () => {
  it("types a trailing closure's parameter when every overload taking one agrees", () => {
    const box = boxOf(INT);

    expect(members.closureParameterType(box, "each", 0, ORDER)).toEqual(INT);
    // Only the two-parameter overload has a second slot; the other is not a candidate.
    expect(members.closureParameterType(box, "each", 1, ORDER)).toEqual(INT);
    expect(members.closureParameterType(box, "mixed", 0, ORDER)).toBeUndefined();
    expect(members.closureParameterType(box, "absent", 0, ORDER)).toBeUndefined();
  });

  it("types a free function's closure parameter by the function's own generic constraint", () => {
    expect(members.functionClosureParameterType("withBox", 0)).toEqual({
      form: "instance",
      name: "Codable",
      upperBound: true,
    });
    expect(members.functionClosureParameterType("noSuchFunction", 0)).toBeUndefined();
  });
});

describe("SwiftSdkMemberTypes — free functions, sequences and constructions", () => {
  it("returns what a labelled free function's value-returning overloads agree on", () => {
    expect(members.functionReturnType("make(a:)")).toEqual(INT);
    expect(members.functionReturnType("mix(a:)")).toBeUndefined();
    expect(members.functionReturnType("bad(a:)")).toBeUndefined();
  });

  it("draws a sequence's Element only off a value, never off the type itself", () => {
    expect(members.sequenceElementType(boxOf(INT))).toEqual(INT);
    expect(members.sequenceElementType({ form: "class", name: "Box" })).toBeUndefined();
    // An element known only by a bound is no element type.
    expect(members.sequenceElementType({ form: "instance", name: "Box" })).toBeUndefined();
  });

  it("types an SDK construction with the arguments its spelling states", () => {
    expect(members.constructionType("Box<Int>")).toEqual(boxOf(INT));
    expect(members.constructionType("Box")).toEqual({ form: "instance", name: "Box" });
    expect(members.constructionType("ProjectType<Int>")).toBeUndefined();
  });
});
