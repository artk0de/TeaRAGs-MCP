/**
 * The `TypeMemberLookup` port's kernel half (bd tea-rags-mcp-m99j1.1.4): the
 * form gate every language implementation sits behind. Only a NOMINAL ref
 * (`class` / `instance`) names one type a member can be looked up on; a union is
 * fanned out by its caller (K2), and a tuple, container or nil dispatches to
 * nothing.
 */
import { describe, expect, it, vi } from "vitest";

import type { CallContext, SymbolResolutionTarget } from "../../../../../src/core/contracts/types/codegraph.js";
import type { TypeRef } from "../../../../../src/core/contracts/types/language.js";
import {
  createTypeMemberLookup,
  typeMemberLookupDefinedFor,
} from "../../../../../src/core/domains/language/kernel/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const ctx: CallContext = {
  callerFile: "app/caller.rb",
  callerScope: [],
  imports: [],
  symbolTable: new InMemoryGlobalSymbolTable(),
};

const target: SymbolResolutionTarget = { targetRelPath: "a.rb", targetSymbolId: "A#foo" };

const nominal: Record<"class" | "instance", TypeRef> = {
  class: { form: "class", name: "A" },
  instance: { form: "instance", name: "A" },
};

const nonNominal: Record<"union" | "tuple" | "container" | "nil", TypeRef> = {
  union: { form: "union", members: [nominal.instance, { form: "instance", name: "B" }] },
  tuple: { form: "tuple", elements: [nominal.instance] },
  container: { form: "container", element: nominal.instance },
  nil: { form: "nil" },
};

describe("typeMemberLookupDefinedFor", () => {
  it.each(Object.entries(nominal))("is defined for the %s form", (_form, ref) => {
    expect(typeMemberLookupDefinedFor(ref)).toBe(true);
  });

  it.each(Object.entries(nonNominal))("is NOT defined for the %s form", (_form, ref) => {
    expect(typeMemberLookupDefinedFor(ref)).toBe(false);
  });
});

describe("createTypeMemberLookup", () => {
  it.each(Object.entries(nominal))("hands a %s ref to the language lookup verbatim", (_form, ref) => {
    const findNominal = vi.fn(() => target);
    const lookup = createTypeMemberLookup(findNominal);
    expect(lookup.findMember(ref, "foo", ctx)).toBe(target);
    expect(findNominal).toHaveBeenCalledExactlyOnceWith(ref, "foo", ctx);
  });

  it("passes the language lookup's miss through as null", () => {
    const lookup = createTypeMemberLookup(() => null);
    expect(lookup.findMember(nominal.instance, "foo", ctx)).toBeNull();
  });

  it.each(Object.entries(nonNominal))("answers null for a %s ref without calling the language lookup", (_form, ref) => {
    const findNominal = vi.fn(() => target);
    const lookup = createTypeMemberLookup(findNominal);
    expect(lookup.findMember(ref, "foo", ctx)).toBeNull();
    expect(findNominal).not.toHaveBeenCalled();
  });
});
