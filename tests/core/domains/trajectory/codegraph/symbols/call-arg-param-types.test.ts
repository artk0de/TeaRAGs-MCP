/**
 * bd tea-rags-mcp-bvalc — barrier half of constructor-arg param typing.
 *
 * The fold is pure over injected maps so the agreement discipline is testable
 * without the provider: one type across every known-target call site binds the
 * parameter, ANY disagreement is silence, and an absent hint neither votes nor
 * vetoes. Increment 1 never majority-votes.
 */

import { describe, expect, it } from "vitest";

import type { KnownTargetCallArgs, LocalBinding } from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  deriveClassFieldTypesFromParams,
  foldKnownTargetParamTypes,
  mergeDerivedClassFieldTypes,
  seedParamLocalBindings,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/call-arg-param-types.js";

const FIRM = { form: "instance", name: "Firm" } as const;
const USER = { form: "instance", name: "User" } as const;

const site = (targets: string[], argTypes: KnownTargetCallArgs["argTypes"]): KnownTargetCallArgs => ({
  targets,
  argTypes,
});

describe("foldKnownTargetParamTypes (bvalc)", () => {
  const params = { "Service#initialize": ["firm", "user"] };

  it("binds a position when every known call site agrees", () => {
    const out = foldKnownTargetParamTypes(
      [site(["Service#initialize"], [FIRM]), site(["Service#initialize"], [FIRM])],
      params,
    );
    expect(out).toEqual({ "Service#initialize": { firm: FIRM } });
  });

  it("is SILENT on the position where two call sites disagree", () => {
    const out = foldKnownTargetParamTypes(
      [site(["Service#initialize"], [FIRM]), site(["Service#initialize"], [USER])],
      params,
    );
    expect(out["Service#initialize"]?.firm).toBeUndefined();
  });

  it("disagreement poisons only the offending position, not the whole callee", () => {
    const out = foldKnownTargetParamTypes(
      [site(["Service#initialize"], [FIRM, USER]), site(["Service#initialize"], [USER, USER])],
      params,
    );
    expect(out["Service#initialize"]).toEqual({ user: USER });
  });

  it("an absent hint neither votes nor vetoes", () => {
    const out = foldKnownTargetParamTypes(
      [site(["Service#initialize"], [null]), site(["Service#initialize"], [FIRM])],
      params,
    );
    expect(out).toEqual({ "Service#initialize": { firm: FIRM } });
  });

  it("binds from a SINGLE call site — one witness with no contradiction is enough", () => {
    const out = foldKnownTargetParamTypes([site(["Service#initialize"], [FIRM])], params);
    expect(out).toEqual({ "Service#initialize": { firm: FIRM } });
  });

  it("emits nothing when no call site carries a known hint", () => {
    const out = foldKnownTargetParamTypes([site(["Service#initialize"], [null, null])], params);
    expect(out).toEqual({});
  });

  it("ignores argument positions past the callee's known parameter names", () => {
    const out = foldKnownTargetParamTypes([site(["Service#initialize"], [FIRM, USER, FIRM])], params);
    expect(out).toEqual({ "Service#initialize": { firm: FIRM, user: USER } });
  });

  it("picks the first candidate that is a real definition — Ruby's own lookup order", () => {
    const out = foldKnownTargetParamTypes([site(["Billing::Service#initialize", "Service#initialize"], [FIRM])], {
      "Service#initialize": ["firm"],
    });
    expect(out).toEqual({ "Service#initialize": { firm: FIRM } });
  });

  it("prefers the innermost candidate when BOTH are real definitions", () => {
    const out = foldKnownTargetParamTypes([site(["Billing::Service#initialize", "Service#initialize"], [FIRM])], {
      "Billing::Service#initialize": ["scoped"],
      "Service#initialize": ["firm"],
    });
    expect(out).toEqual({ "Billing::Service#initialize": { scoped: FIRM } });
  });

  it("a constant that names no in-project definition contributes nothing", () => {
    expect(foldKnownTargetParamTypes([site(["Gem::Client#initialize"], [FIRM])], params)).toEqual({});
  });

  it("treats structurally equal refs as agreement, not conflict", () => {
    const out = foldKnownTargetParamTypes(
      [
        site(["Service#initialize"], [{ form: "instance", name: "Firm" }]),
        site(["Service#initialize"], [{ form: "instance", name: "Firm" }]),
      ],
      params,
    );
    expect(out).toEqual({ "Service#initialize": { firm: FIRM } });
  });

  it("a class-form and an instance-form of the same name DISAGREE", () => {
    const out = foldKnownTargetParamTypes(
      [site(["Service#initialize"], [{ form: "class", name: "Firm" }]), site(["Service#initialize"], [FIRM])],
      params,
    );
    expect(out).toEqual({});
  });
});

describe("deriveClassFieldTypesFromParams (bvalc)", () => {
  const links = { Service: { "@firm": { method: "initialize", param: "firm" } } };
  const paramTypes = { "Service#initialize": { firm: FIRM } };

  it("completes an ivar from the parameter it copies", () => {
    expect(deriveClassFieldTypesFromParams(links, paramTypes, new Set())).toEqual({ Service: { "@firm": "Firm" } });
  });

  it("yields to a field the walker already typed — declared beats derived", () => {
    expect(deriveClassFieldTypesFromParams(links, paramTypes, new Set(["Service|@firm"]))).toEqual({});
  });

  it("is silent when the parameter never got a type", () => {
    expect(deriveClassFieldTypesFromParams(links, {}, new Set())).toEqual({});
  });

  it("skips a CLASS-valued parameter — the field would read as an instance", () => {
    const out = deriveClassFieldTypesFromParams(
      links,
      { "Service#initialize": { firm: { form: "class", name: "Firm" } } },
      new Set(),
    );
    expect(out).toEqual({});
  });
});

describe("seedParamLocalBindings (bvalc)", () => {
  it("seeds a derived parameter type at the def line", () => {
    const out = seedParamLocalBindings(undefined, { firm: FIRM }, 10);
    expect(out).toEqual({ firm: [{ line: 10, type: "Firm" }] });
  });

  it("NEVER displaces an existing binding — a YARD @param wins", () => {
    const existing: Record<string, LocalBinding[]> = { firm: [{ line: 10, type: "Declared" }] };
    expect(seedParamLocalBindings(existing, { firm: FIRM }, 10)).toBe(existing);
  });

  it("returns the input untouched when there is nothing to derive", () => {
    const existing: Record<string, LocalBinding[]> = { x: [{ line: 1, type: "X" }] };
    expect(seedParamLocalBindings(existing, undefined, 1)).toBe(existing);
    expect(seedParamLocalBindings(existing, {}, 1)).toBe(existing);
  });

  it("is a no-op without a def line — a binding needs a position", () => {
    expect(seedParamLocalBindings(undefined, { firm: FIRM }, undefined)).toBeUndefined();
  });

  it("marks a class-valued parameter so a call on it resolves statically", () => {
    const out = seedParamLocalBindings(undefined, { klass: { form: "class", name: "Firm" } }, 3);
    expect(out).toEqual({ klass: [{ line: 3, type: "Firm", valueKind: "class" }] });
  });
});

describe("mergeDerivedClassFieldTypes (bvalc)", () => {
  it("returns the walker's own map by identity when nothing was derived", () => {
    const own = { A: { "@x": "X" } };
    expect(mergeDerivedClassFieldTypes(own, {})).toBe(own);
  });

  it("adds derived classes the file itself never typed", () => {
    expect(mergeDerivedClassFieldTypes({ A: { "@x": "X" } }, { B: { "@y": "Y" } })).toEqual({
      A: { "@x": "X" },
      B: { "@y": "Y" },
    });
  });

  it("the file's own field type wins over the derived one at the same coordinate", () => {
    expect(mergeDerivedClassFieldTypes({ A: { "@x": "Own" } }, { A: { "@x": "Derived", "@y": "Y" } })).toEqual({
      A: { "@x": "Own", "@y": "Y" },
    });
  });

  it("works for a file that typed no fields at all", () => {
    expect(mergeDerivedClassFieldTypes(undefined, { A: { "@x": "X" } })).toEqual({ A: { "@x": "X" } });
  });
});
