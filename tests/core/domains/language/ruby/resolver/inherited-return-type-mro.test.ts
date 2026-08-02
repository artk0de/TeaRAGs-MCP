/**
 * `returnTypeOf` step 3 — the INHERITED structured-return-fact channel — reaches
 * the ancestor Ruby reaches (bd tea-rags-mcp-mo5ur).
 *
 * The channel used to iterate `ctx.classAncestors[className]` directly. That is
 * walker STORAGE order (`[superclass, ...includes]`), one level deep: the
 * superclass outranked every mixin, and a fact declared on a grandparent or on a
 * mixin's own ancestor was invisible. `selfMemberReturnType` already asks the
 * same question as a single `linearizeAncestors` walk; this pins that step 3
 * does too, so the two cannot drift on which coordinate answers.
 *
 * Facts live on BOTH the mixin and the superclass in the ordering fixtures, so
 * storage order and MRO order give DIFFERENT answers.
 */
import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../src/core/contracts/types/codegraph.js";
import { returnTypeOf } from "../../../../../../src/core/domains/language/ruby/resolver/type-propagation.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const ctx = (over: Partial<CallContext> = {}): CallContext => ({
  callerFile: "app/caller.rb",
  callerScope: [],
  imports: [],
  symbolTable: new InMemoryGlobalSymbolTable(),
  ...over,
});

const instance = (name: string) => ({ form: "instance", name }) as const;

describe("returnTypeOf — inherited return fact follows the MRO (mo5ur)", () => {
  it("prefers a fact on an INCLUDE over one on the superclass (class Sub < Base; include M)", () => {
    // Ruby: Sub.ancestors == [Sub, M, Base] → `sub.m` reaches M#m, whose fact wins.
    const result = returnTypeOf(
      instance("Sub"),
      "m",
      ctx({
        classAncestors: { Sub: ["Base", "M"] },
        classExtends: { Sub: "Base" },
        structuredReturnTypes: { "Base#m": instance("FromBase"), "M#m": instance("FromMixin") },
      }),
    );
    expect(result).toEqual(instance("FromMixin"));
  });

  it("prefers a fact on the LAST include over an earlier one (class C; include A; include B)", () => {
    const result = returnTypeOf(
      instance("C"),
      "m",
      ctx({
        classAncestors: { C: ["A", "B"] },
        structuredReturnTypes: { "A#m": instance("FromA"), "B#m": instance("FromB") },
      }),
    );
    expect(result).toEqual(instance("FromB"));
  });

  it("reaches a TRANSITIVE ancestor's fact (grandparent, two `<` hops up)", () => {
    // One level of `classAncestors` stopped at Base, which declares nothing; the
    // linearization keeps walking into Root, which does.
    const result = returnTypeOf(
      instance("Sub"),
      "m",
      ctx({
        classAncestors: { Sub: ["Base"], Base: ["Root"] },
        classExtends: { Sub: "Base", Base: "Root" },
        structuredReturnTypes: { "Root#m": instance("FromRoot") },
      }),
    );
    expect(result).toEqual(instance("FromRoot"));
  });

  it("still lets the receiver's OWN fact outrank every ancestor", () => {
    // Channel precedence guard: step 1 asks the class itself before step 3 runs,
    // and widening step 3's reach must not disturb that.
    const result = returnTypeOf(
      instance("Sub"),
      "m",
      ctx({
        classAncestors: { Sub: ["Base", "M"] },
        classExtends: { Sub: "Base" },
        structuredReturnTypes: {
          "Sub#m": instance("FromSelf"),
          "Base#m": instance("FromBase"),
          "M#m": instance("FromMixin"),
        },
      }),
    );
    expect(result).toEqual(instance("FromSelf"));
  });

  it("returns undefined when no ancestor in the MRO declares the member", () => {
    const result = returnTypeOf(
      instance("Sub"),
      "m",
      ctx({
        classAncestors: { Sub: ["Base", "M"] },
        classExtends: { Sub: "Base" },
        structuredReturnTypes: { "Other#m": instance("Unrelated") },
      }),
    );
    expect(result).toBeUndefined();
  });
});
