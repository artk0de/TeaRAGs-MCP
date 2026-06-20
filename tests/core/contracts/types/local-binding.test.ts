import { describe, expect, it } from "vitest";

import { resolveLocalBindingType, type LocalBinding } from "../../../../src/core/contracts/types/codegraph.js";

describe("resolveLocalBindingType — position-aware local binding lookup", () => {
  it("returns undefined when bindings is undefined", () => {
    expect(resolveLocalBindingType(undefined, "x", 5)).toBeUndefined();
  });

  it("returns undefined when the variable is unbound", () => {
    const bindings: Record<string, LocalBinding[]> = { y: [{ line: 1, type: "Foo" }] };
    expect(resolveLocalBindingType(bindings, "x", 5)).toBeUndefined();
  });

  it("returns undefined when the variable's array is empty", () => {
    expect(resolveLocalBindingType({ x: [] }, "x", 5)).toBeUndefined();
  });

  it("returns the single binding's type when its line is at or before the call", () => {
    expect(resolveLocalBindingType({ x: [{ line: 2, type: "Foo" }] }, "x", 3)).toBe("Foo");
  });

  it("resolves the binding established on the SAME line (<= boundary)", () => {
    expect(resolveLocalBindingType({ x: [{ line: 4, type: "Foo" }] }, "x", 4)).toBe("Foo");
  });

  it("returns undefined when the only binding is established AFTER the call line", () => {
    expect(resolveLocalBindingType({ x: [{ line: 6, type: "Foo" }] }, "x", 3)).toBeUndefined();
  });

  it("picks the most-recent binding at or before the call (flow-sensitive reassignment)", () => {
    const bindings: Record<string, LocalBinding[]> = {
      x: [
        { line: 2, type: "Foo" },
        { line: 4, type: "Bar" },
      ],
    };
    // A call at line 3 sees only the line-2 binding.
    expect(resolveLocalBindingType(bindings, "x", 3)).toBe("Foo");
    // A call at line 5 sees the line-4 reassignment.
    expect(resolveLocalBindingType(bindings, "x", 5)).toBe("Bar");
  });

  it("ignores later bindings and selects the greatest line <= call even when array order is mixed", () => {
    const bindings: Record<string, LocalBinding[]> = {
      x: [
        { line: 4, type: "Bar" },
        { line: 2, type: "Foo" },
        { line: 9, type: "Baz" },
      ],
    };
    expect(resolveLocalBindingType(bindings, "x", 5)).toBe("Bar");
    expect(resolveLocalBindingType(bindings, "x", 2)).toBe("Foo");
    expect(resolveLocalBindingType(bindings, "x", 100)).toBe("Baz");
  });
});
