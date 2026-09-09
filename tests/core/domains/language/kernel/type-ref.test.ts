import { describe, expect, it } from "vitest";

import type { TypeRef } from "../../../../../src/core/contracts/types/language.js";
import {
  NIL_TYPE_REF,
  typeRefEquals,
  typeRefNonNilArms,
  typeRefReceiverForm,
  typeRefUnionOf,
} from "../../../../../src/core/domains/language/kernel/type-ref.js";
import {
  RUBY_NIL_TYPE_REF,
  rubyNonNilArms,
  rubyReceiverForm,
  rubyTypeRefEquals,
  rubyUnionOf,
} from "../../../../../src/core/domains/language/ruby/type-ref.js";

const firm: TypeRef = { form: "instance", name: "Firm" };
const user: TypeRef = { form: "instance", name: "User" };

describe("kernel TypeRef algebra", () => {
  it("compares every form structurally, unions arm-by-arm in order", () => {
    expect(typeRefEquals(firm, { form: "instance", name: "Firm" })).toBe(true);
    expect(typeRefEquals(firm, { form: "class", name: "Firm" })).toBe(false);
    expect(typeRefEquals(NIL_TYPE_REF, { form: "nil" })).toBe(true);
    expect(typeRefEquals({ form: "union", members: [firm, user] }, { form: "union", members: [user, firm] })).toBe(
      false,
    );
    expect(typeRefEquals({ form: "container", element: firm }, { form: "container", element: firm })).toBe(true);
  });

  it("flattens nested unions, collapses equal arms, and a single arm IS that arm", () => {
    expect(typeRefUnionOf([])).toBeUndefined();
    expect(typeRefUnionOf([firm])).toEqual(firm);
    expect(typeRefUnionOf([firm, firm])).toEqual(firm);
    expect(typeRefUnionOf([{ form: "union", members: [firm, user] }, user])).toEqual({
      form: "union",
      members: [firm, user],
    });
  });

  it("strips nil arms without unwrapping containers", () => {
    expect(typeRefNonNilArms(NIL_TYPE_REF)).toEqual([]);
    expect(typeRefNonNilArms(firm)).toEqual([firm]);
    const arr: TypeRef = { form: "container", element: firm };
    expect(typeRefNonNilArms({ form: "union", members: [arr, NIL_TYPE_REF] })).toEqual([arr]);
  });

  it("collapses a nilable receiver to its one reachable arm, keeps a real two-arm union", () => {
    expect(typeRefReceiverForm(undefined)).toBeUndefined();
    expect(typeRefReceiverForm(NIL_TYPE_REF)).toBeUndefined();
    expect(typeRefReceiverForm({ form: "union", members: [firm, NIL_TYPE_REF] })).toEqual(firm);
    const twoArm: TypeRef = { form: "union", members: [firm, user] };
    expect(typeRefReceiverForm(twoArm)).toEqual(twoArm);
  });
});

describe("ruby/type-ref.ts shim", () => {
  it("re-exports the kernel functions themselves, not copies", () => {
    expect(rubyTypeRefEquals).toBe(typeRefEquals);
    expect(rubyUnionOf).toBe(typeRefUnionOf);
    expect(rubyNonNilArms).toBe(typeRefNonNilArms);
    expect(rubyReceiverForm).toBe(typeRefReceiverForm);
    expect(RUBY_NIL_TYPE_REF).toBe(NIL_TYPE_REF);
  });
});
