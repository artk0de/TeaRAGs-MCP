import { describe, expect, it } from "vitest";

import type { TypeRef } from "../../../../../../src/core/contracts/types/language.js";
import {
  rustStdAccessorReturnType,
  rustStdClosureParamType,
  rustStdElementType,
  rustThroughSmartPointers,
} from "../../../../../../src/core/domains/language/rust/resolver/std-type-hops.js";

const inst = (name: string, ...args: TypeRef[]): TypeRef => ({
  form: "instance",
  name,
  ...(args.length ? { args } : {}),
});
const user = inst("User");
const id = inst("u32");
const vec = inst("Vec", user);
const map = inst("HashMap", id, user);

describe("Rust std collection type hops", () => {
  it("looks through smart pointers up to three hops and stops at a non-pointer or a malformed one", () => {
    expect(rustThroughSmartPointers(inst("Box", inst("Rc", vec)))).toEqual(vec);
    expect(rustThroughSmartPointers(inst("Arc", inst("Box", inst("Rc", inst("Box", vec)))))).toEqual(inst("Box", vec));
    expect(rustThroughSmartPointers(inst("Box"))).toEqual(inst("Box"));
    expect(rustThroughSmartPointers(user)).toBe(user);
    expect(rustThroughSmartPointers({ form: "container", element: user })).toEqual({
      form: "container",
      element: user,
    });
  });

  it("types element accessors: clone is Self, sequences and slices give Option<element>, maps give Option<value>", () => {
    expect(rustStdAccessorReturnType(vec, "clone")).toBe(vec);
    expect(rustStdAccessorReturnType(vec, "pop")).toEqual(inst("Option", user));
    expect(rustStdAccessorReturnType(vec, "no_such_member")).toBeUndefined();
    expect(rustStdAccessorReturnType(inst("Vec"), "pop")).toBeUndefined();
    const slice = { form: "container", element: user } as TypeRef;
    expect(rustStdAccessorReturnType(slice, "first")).toEqual(inst("Option", user));
    expect(rustStdAccessorReturnType(slice, "clone")).toBe(slice);
    expect(rustStdAccessorReturnType(slice, "frobnicate")).toBeUndefined();
    expect(rustStdAccessorReturnType(map, "get")).toEqual(inst("Option", user));
    expect(rustStdAccessorReturnType(map, "remove_entry")).toEqual(
      inst("Option", { form: "tuple", elements: [id, user] }),
    );
    expect(rustStdAccessorReturnType(map, "len")).toBeUndefined();
    expect(rustStdAccessorReturnType(inst("HashMap", id), "get")).toBeUndefined();
    expect(rustStdAccessorReturnType(user, "get")).toBeUndefined();
    expect(rustStdAccessorReturnType(inst("my::Vec", user), "pop")).toBeUndefined();
  });

  it("threads an iterator chain through sources, pass-through adapters and enumerate", () => {
    expect(rustStdElementType(vec, [])).toEqual(user);
    expect(rustStdElementType(map, [])).toEqual({ form: "tuple", elements: [id, user] });
    expect(rustStdElementType(inst("Box", vec), ["iter"])).toEqual(user);
    expect(rustStdElementType(vec, ["iter", "enumerate"])).toEqual({
      form: "tuple",
      elements: [inst("usize"), user],
    });
    expect(rustStdElementType(map, ["values"])).toEqual(user);
    expect(rustStdElementType(map, ["keys"])).toEqual(id);
    expect(rustStdElementType(map, ["values", "rev"])).toEqual(user);
    expect(rustStdElementType(vec, ["iter", "to_owned_by_magic"])).toBeUndefined();
    expect(rustStdElementType(vec, ["values"])).toBeUndefined();
    expect(rustStdElementType(inst("HashMap", id), ["values"])).toBeUndefined();
    expect(rustStdElementType(user, ["iter"])).toBeUndefined();
    expect(rustStdElementType(user, [])).toBeUndefined();
    expect(rustStdElementType(inst("Vec"), [])).toBeUndefined();
    expect(rustStdElementType({ form: "container", element: user }, [])).toEqual(user);
  });

  it("types closure parameters over an iterator item or the std value itself", () => {
    // Over an opened iterator: the item reaches the closure of the member that takes it.
    expect(rustStdClosureParamType(vec, user, "map", 0, 0)).toEqual(user);
    expect(rustStdClosureParamType(vec, user, "map", 0, 1)).toBeUndefined();
    expect(rustStdClosureParamType(vec, user, "map", 3, 0)).toBeUndefined();
    expect(rustStdClosureParamType(vec, user, "max_by", 0, 1)).toEqual(user);
    expect(rustStdClosureParamType(vec, user, "fold", 1, 1)).toEqual(user);
    expect(rustStdClosureParamType(vec, user, "fold", 1, 0)).toBeUndefined();
    // Over a std value directly.
    const opt = inst("Option", user);
    expect(rustStdClosureParamType(opt, undefined, "map", 0, 0)).toEqual(user);
    expect(rustStdClosureParamType(opt, undefined, "map", 0, 1)).toBeUndefined();
    expect(rustStdClosureParamType(opt, undefined, "map", 1, 0)).toBeUndefined();
    const res = inst("Result", user, inst("Error"));
    expect(rustStdClosureParamType(res, undefined, "map_err", 0, 0)).toEqual(inst("Error"));
    expect(rustStdClosureParamType(res, undefined, "map", 0, 0)).toEqual(user);
    expect(rustStdClosureParamType(inst("Result", user), undefined, "map", 0, 0)).toBeUndefined();
    expect(rustStdClosureParamType(opt, undefined, "map_err", 0, 0)).toBeUndefined();
    expect(rustStdClosureParamType(vec, undefined, "retain", 0, 0)).toEqual(user);
    expect(rustStdClosureParamType(vec, undefined, "sort_by", 0, 1)).toEqual(user);
    expect(rustStdClosureParamType(vec, undefined, "retain", 0, 1)).toBeUndefined();
    expect(rustStdClosureParamType(vec, undefined, "retain", 1, 0)).toBeUndefined();
    expect(rustStdClosureParamType(vec, undefined, "len", 0, 0)).toBeUndefined();
    expect(rustStdClosureParamType(map, undefined, "retain", 0, 0)).toEqual(id);
    expect(rustStdClosureParamType(map, undefined, "retain", 0, 1)).toEqual(user);
    expect(rustStdClosureParamType(user, undefined, "map", 0, 0)).toBeUndefined();
    expect(rustStdClosureParamType({ form: "container", element: user }, undefined, "map", 0, 0)).toBeUndefined();
  });
});
