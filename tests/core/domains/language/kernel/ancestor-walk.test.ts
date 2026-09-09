import { describe, expect, it } from "vitest";

import {
  createAncestorLinearizer,
  findMemberInAncestorChain,
  type AncestorClosure,
  type AncestorLinearizationPolicy,
} from "../../../../../src/core/domains/language/kernel/ancestor-walk.js";

/**
 * The engine is exercised through HAND-BUILT policies only — never Ruby's, never
 * Python's. A test that reached for a real language would be scoring that
 * language's ordering rule, which is exactly the half the kernel refuses to own.
 */
interface Hierarchy {
  readonly parents: Readonly<Record<string, readonly string[]>>;
  readonly boundary?: Readonly<Record<string, AncestorClosure>>;
}

/** Depth-first, class first, parents left to right, first occurrence wins. */
const dfsPolicy = (onOrder?: (classKey: string) => void): AncestorLinearizationPolicy<Hierarchy> => ({
  order(classKey, hierarchy, _recurse, insertable) {
    onOrder?.(classKey);
    const out: string[] = [classKey];
    for (const parent of hierarchy.parents[classKey] ?? []) out.push(...insertable(parent, [out]));
    return out;
  },
});

describe("createAncestorLinearizer", () => {
  it("returns a linear chain nearest first", () => {
    const linearizer = createAncestorLinearizer({ parents: { C: ["B"], B: ["A"] } }, dfsPolicy());

    expect(linearizer.linearize("C").order).toEqual(["C", "B", "A"]);
  });

  it("terminates on a cycle and yields each key once", () => {
    const linearizer = createAncestorLinearizer({ parents: { A: ["B"], B: ["A"] } }, dfsPolicy());

    expect(linearizer.linearize("A").order).toEqual(["A", "B"]);
  });

  it("dedupes a diamond to first-occurrence order", () => {
    const hierarchy: Hierarchy = { parents: { D: ["B", "C"], B: ["A"], C: ["A"] } };

    expect(createAncestorLinearizer(hierarchy, dfsPolicy()).linearize("D").order).toEqual(["D", "B", "A", "C"]);
  });

  it("memoizes the top-level entry by identity and runs the policy once per key", () => {
    const ordered: string[] = [];
    const linearizer = createAncestorLinearizer(
      { parents: { C: ["B"], B: [] } },
      dfsPolicy((k) => ordered.push(k)),
    );

    const first = linearizer.linearize("C");
    const second = linearizer.linearize("C");

    expect(second).toBe(first);
    expect(ordered).toEqual(["C", "B"]);
  });

  it("joins an unknown branch and an external branch into external", () => {
    const hierarchy: Hierarchy = {
      parents: { D: ["B", "C"], B: ["U"], C: ["E"] },
      boundary: { U: "unknown", E: "external" },
    };
    const policy: AncestorLinearizationPolicy<Hierarchy> = {
      ...dfsPolicy(),
      boundaryOf: (classKey, ctx) => ctx.boundary?.[classKey] ?? "closed",
    };

    expect(createAncestorLinearizer(hierarchy, policy).linearize("D").closure).toBe("external");
  });

  it("reports a closed hierarchy when the policy declares no boundary", () => {
    const linearizer = createAncestorLinearizer({ parents: { B: ["A"] } }, dfsPolicy());

    expect(linearizer.linearize("B").closure).toBe("closed");
  });
});

describe("findMemberInAncestorChain", () => {
  const hierarchy: Hierarchy = { parents: { C: ["B"], B: ["A"] } };
  const owners =
    (...keys: readonly string[]) =>
    (candidate: string) =>
      keys.includes(candidate) ? candidate : null;

  it("returns the first owner in the order and the class that defines it", () => {
    const linearizer = createAncestorLinearizer(hierarchy, dfsPolicy());

    const scan = findMemberInAncestorChain("C", linearizer, owners("B", "A"));

    expect(scan).toEqual({ target: "B", definingClassKey: "B", closure: "closed" });
  });

  it("reports no target when nothing in the order owns the member", () => {
    const linearizer = createAncestorLinearizer(hierarchy, dfsPolicy());

    const scan = findMemberInAncestorChain("C", linearizer, owners("Z"));

    expect(scan).toEqual({ target: null, definingClassKey: null, closure: "closed" });
  });

  it("skips the start class under startAfter even when it owns the member", () => {
    const linearizer = createAncestorLinearizer(hierarchy, dfsPolicy());

    const scan = findMemberInAncestorChain("C", linearizer, owners("C", "A"), { startAfter: true });

    expect(scan.target).toBe("A");
    expect(scan.definingClassKey).toBe("A");
  });

  it("scans nothing under startAfter when the policy drops the start class from its own order", () => {
    // A policy free to omit the class itself — `super` has no next entry to
    // dispatch to when it cannot find where the walk would have started.
    const dropSelf: AncestorLinearizationPolicy<Hierarchy> = {
      order: (classKey) => (classKey === "C" ? ["B", "A"] : []),
    };
    const linearizer = createAncestorLinearizer(hierarchy, dropSelf);

    expect(findMemberInAncestorChain("C", linearizer, owners("B", "A")).target).toBe("B");
    const scan = findMemberInAncestorChain("C", linearizer, owners("B", "A"), { startAfter: true });

    expect(scan.target).toBeNull();
    expect(scan.definingClassKey).toBeNull();
  });
});
