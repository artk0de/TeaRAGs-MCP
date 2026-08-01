/**
 * `RubyTypeRef` union/nilable algebra (bd tea-rags-mcp-27q0z).
 *
 * The return-fact channel could carry a single nominal type only; a callee that
 * yields `Firm` on one path and `nil` on another had no honest representation.
 * These are the invariants of the constructor that builds such a ref and of the
 * equality it is folded with.
 */
import { describe, expect, it } from "vitest";

import type { RubyTypeRef } from "../../../../../src/core/contracts/types/language.js";
import {
  RUBY_NIL_TYPE_REF,
  rubyNonNilArms,
  rubyReceiverForm,
  rubyTypeRefEquals,
  rubyUnionOf,
} from "../../../../../src/core/domains/language/ruby/type-ref.js";

const inst = (name: string): RubyTypeRef => ({ form: "instance", name });
const cls = (name: string): RubyTypeRef => ({ form: "class", name });
const container = (element: RubyTypeRef): RubyTypeRef => ({ form: "container", element });

describe("rubyUnionOf — the one constructor for a union / nilable ref", () => {
  it("returns undefined for no members (nothing to state)", () => {
    expect(rubyUnionOf([])).toBeUndefined();
  });

  it("collapses a single member to that member (a one-arm union is not a union)", () => {
    expect(rubyUnionOf([inst("Firm")])).toEqual(inst("Firm"));
  });

  it("keeps the nil arm — nilable is REPRESENTED, not erased", () => {
    expect(rubyUnionOf([inst("Firm"), RUBY_NIL_TYPE_REF])).toEqual({
      form: "union",
      members: [inst("Firm"), RUBY_NIL_TYPE_REF],
    });
  });

  it("flattens a nested union so arms are always one level deep", () => {
    const nested = rubyUnionOf([rubyUnionOf([inst("A"), inst("B")]) as RubyTypeRef, inst("C")]);
    expect(nested).toEqual({ form: "union", members: [inst("A"), inst("B"), inst("C")] });
  });

  it("deduplicates structurally equal arms, first occurrence wins", () => {
    expect(rubyUnionOf([inst("A"), inst("A"), RUBY_NIL_TYPE_REF, RUBY_NIL_TYPE_REF])).toEqual({
      form: "union",
      members: [inst("A"), RUBY_NIL_TYPE_REF],
    });
  });

  it("a class arm and an instance arm of the same name are DIFFERENT arms", () => {
    expect(rubyUnionOf([cls("A"), inst("A")])).toEqual({ form: "union", members: [cls("A"), inst("A")] });
  });

  it("collapses to the sole member when dedup leaves one", () => {
    expect(rubyUnionOf([inst("A"), inst("A")])).toEqual(inst("A"));
  });

  it("a lone nil is representable on its own", () => {
    expect(rubyUnionOf([RUBY_NIL_TYPE_REF])).toEqual(RUBY_NIL_TYPE_REF);
  });
});

describe("rubyTypeRefEquals — structural equality over every form", () => {
  it("nominal arms compare by form AND name", () => {
    expect(rubyTypeRefEquals(inst("A"), inst("A"))).toBe(true);
    expect(rubyTypeRefEquals(inst("A"), inst("B"))).toBe(false);
    expect(rubyTypeRefEquals(inst("A"), cls("A"))).toBe(false);
  });

  it("two nil arms are equal", () => {
    expect(rubyTypeRefEquals(RUBY_NIL_TYPE_REF, { form: "nil" })).toBe(true);
  });

  it("nil is not equal to any nominal", () => {
    expect(rubyTypeRefEquals(RUBY_NIL_TYPE_REF, inst("A"))).toBe(false);
  });

  it("containers compare by element", () => {
    expect(rubyTypeRefEquals(container(inst("Post")), container(inst("Post")))).toBe(true);
    expect(rubyTypeRefEquals(container(inst("Post")), container(inst("User")))).toBe(false);
  });

  it("unions compare arm-wise, in order", () => {
    const ab = { form: "union", members: [inst("A"), inst("B")] } as RubyTypeRef;
    const ba = { form: "union", members: [inst("B"), inst("A")] } as RubyTypeRef;
    expect(rubyTypeRefEquals(ab, { form: "union", members: [inst("A"), inst("B")] })).toBe(true);
    expect(rubyTypeRefEquals(ab, ba)).toBe(false);
  });
});

describe("rubyNonNilArms — the arms a receiver call could actually dispatch on", () => {
  it("a nominal ref is its own single arm", () => {
    expect(rubyNonNilArms(inst("Firm"))).toEqual([inst("Firm")]);
  });

  it("nil has no dispatchable arm", () => {
    expect(rubyNonNilArms(RUBY_NIL_TYPE_REF)).toEqual([]);
  });

  it("a nilable union drops the nil arm", () => {
    expect(rubyNonNilArms({ form: "union", members: [inst("Firm"), RUBY_NIL_TYPE_REF] })).toEqual([inst("Firm")]);
  });

  it("a container is its own arm (returnTypeOf owns the element unwrap)", () => {
    expect(rubyNonNilArms(container(inst("Post")))).toEqual([container(inst("Post"))]);
  });
});

describe("rubyReceiverForm — what a call site actually dispatches on", () => {
  it("a nilable union with one reachable arm IS that arm", () => {
    expect(rubyReceiverForm({ form: "union", members: [inst("Firm"), RUBY_NIL_TYPE_REF] })).toEqual(inst("Firm"));
  });

  it("a genuinely polymorphic union stays a union — it still needs a fan-out", () => {
    const ab = { form: "union", members: [inst("A"), inst("B")] } as RubyTypeRef;
    expect(rubyReceiverForm(ab)).toEqual(ab);
  });

  it("a nilable union over two nominals keeps both arms and drops nothing", () => {
    const ref = { form: "union", members: [inst("A"), inst("B"), RUBY_NIL_TYPE_REF] } as RubyTypeRef;
    expect(rubyReceiverForm(ref)).toEqual(ref);
  });

  it("a union of nothing but nil dispatches nowhere", () => {
    expect(rubyReceiverForm({ form: "union", members: [RUBY_NIL_TYPE_REF] })).toBeUndefined();
    expect(rubyReceiverForm(RUBY_NIL_TYPE_REF)).toBeUndefined();
  });

  it("leaves every non-union form untouched", () => {
    expect(rubyReceiverForm(inst("A"))).toEqual(inst("A"));
    expect(rubyReceiverForm(cls("A"))).toEqual(cls("A"));
    expect(rubyReceiverForm(container(inst("Post")))).toEqual(container(inst("Post")));
  });

  it("passes undefined through — an unknown receiver stays unknown", () => {
    expect(rubyReceiverForm(undefined)).toBeUndefined();
  });
});
