import { describe, expect, it } from "vitest";

import {
  alignHead,
  alignQualifiers,
  establishedModifiers,
  modifierLift,
  type ModifierUse,
} from "../../../../../src/core/domains/explore/naming-lexicon/term-alignment.js";

function mod(word: string, heads: string[], dirs: string[], count: number): ModifierUse {
  return { word, heads: new Set(heads), dirs: new Set(dirs), count };
}

describe("alignHead", () => {
  it("aligns the head to the dominant spelling", () => {
    expect(
      alignHead(
        { head: ["document"], qualifiers: [] },
        new Map([
          ["doc", 200],
          ["document", 3],
        ]),
      ),
    ).toBe("doc");
  });

  it("keeps a head that already is the dominant spelling", () => {
    expect(
      alignHead(
        { head: ["doc"], qualifiers: ["calculated"] },
        new Map([
          ["doc", 200],
          ["document", 3],
        ]),
      ),
    ).toBeUndefined();
  });

  it("does not treat an unrelated word as a spelling variant", () => {
    // `preset` / `presenter`: `preset` is not short enough to abbreviate `presenter`.
    expect(
      alignHead(
        { head: ["presenter"], qualifiers: [] },
        new Map([
          ["preset", 90],
          ["presenter", 2],
        ]),
      ),
    ).toBeUndefined();
  });

  it("an empty head aligns to nothing", () => {
    expect(alignHead({ head: [], qualifiers: [] }, new Map([["doc", 1]]))).toBeUndefined();
  });
});

describe("establishedModifiers", () => {
  it("keeps a modifier combining with several heads in several directories", () => {
    const uses = [
      mod("predefined", ["template", "field"], ["src/templates", "src/fields"], 12),
      mod("cached", ["file"], ["src/a", "src/b"], 5),
      mod("local", ["binding", "scope"], ["src/a"], 7),
    ];
    expect(establishedModifiers(uses).map((use) => use.word)).toEqual(["predefined"]);
  });
});

describe("alignQualifiers", () => {
  it("offers an established modifier with lift above the floor", () => {
    const uses = [mod("predefined", ["template", "field"], ["src/templates", "src/fields"], 12)];
    const lift = modifierLift(establishedModifiers(uses), ["PredefinedTemplate", "PredefinedField"], 4000);
    expect(alignQualifiers({ head: ["doc"], qualifiers: ["calculated"] }, establishedModifiers(uses), lift, 2)).toEqual(
      [
        expect.objectContaining({
          word: "predefined",
          heads: ["field", "template"],
        }),
      ],
    );
  });

  it("nothing above the floor is a new concept", () => {
    const uses = [mod("predefined", ["template", "field"], ["src/templates", "src/fields"], 12)];
    const established = establishedModifiers(uses);
    // The concept search returned code where `predefined` never qualifies a name.
    const lift = modifierLift(established, ["CalculatedTotal", "TaxAmount"], 4000);
    expect(lift.get("predefined")).toBe(0);
    expect(alignQualifiers({ head: ["doc"], qualifiers: ["calculated"] }, established, lift, 2)).toEqual([]);
  });

  it("computes lift as concept frequency over project frequency", () => {
    const established = [mod("predefined", ["template", "field"], ["src/templates", "src/fields"], 40)];
    // 1 of 4 concept names (0.25) against 40 of 4000 project types (0.01) → 25.
    const lift = modifierLift(established, ["PredefinedTemplate", "Doc", "TaxDoc", "Field"], 4000);
    expect(lift.get("predefined")).toBeCloseTo(25);
  });

  it("returns alternatives by lift, with heads and domains sorted", () => {
    const established = [
      mod("predefined", ["template", "field"], ["src/templates", "src/fields"], 12),
      mod("shared", ["config", "cache"], ["src/b", "src/a"], 30),
    ];
    const lift = new Map([
      ["predefined", 10],
      ["shared", 40],
    ]);
    expect(alignQualifiers({ head: ["doc"], qualifiers: ["calculated"] }, established, lift, 2)).toEqual([
      { word: "shared", heads: ["cache", "config"], domains: ["src/a", "src/b"], lift: 40 },
      { word: "predefined", heads: ["field", "template"], domains: ["src/fields", "src/templates"], lift: 10 },
    ]);
  });

  it("offers nothing when the draft's qualifier is already established", () => {
    const established = [mod("predefined", ["template", "field"], ["src/templates", "src/fields"], 12)];
    const lift = new Map([["predefined", 50]]);
    expect(alignQualifiers({ head: ["doc"], qualifiers: ["predefined"] }, established, lift, 2)).toEqual([]);
  });

  it("offers nothing to a name without qualifiers", () => {
    const established = [mod("predefined", ["template", "field"], ["src/templates", "src/fields"], 12)];
    expect(alignQualifiers({ head: ["doc"], qualifiers: [] }, established, new Map([["predefined", 50]]), 2)).toEqual(
      [],
    );
  });
});
