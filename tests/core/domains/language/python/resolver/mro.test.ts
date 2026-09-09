/**
 * Python C3 linearization (bd tea-rags-mcp-y4hro, seam 4 Task 2).
 *
 * `linearizeC3` is pure: it takes a class key and a `basesOf` port that has
 * ALREADY turned base spellings into class keys, so nothing here needs a
 * `CallContext`, a symbol table or the import file mapper. Resolving a spelling
 * (and recording whether it fell off the project into an external or an unknown
 * boundary) is the caller's job, done inside its own `basesOf` closure.
 */

import { describe, expect, it } from "vitest";

import { linearizeC3 } from "../../../../../../src/core/domains/language/python/resolver/mro.js";

function hierarchy(edges: Record<string, readonly string[]>): (key: string) => readonly string[] {
  return (key) => edges[key] ?? [];
}

describe("linearizeC3 — order", () => {
  it("returns the class itself when it declares no base", () => {
    expect(linearizeC3("x.py::A", hierarchy({}))).toEqual({ order: ["x.py::A"], fallbacks: 0 });
  });

  it("walks a linear chain outward", () => {
    const bases = hierarchy({ "x.py::C": ["x.py::B"], "x.py::B": ["x.py::A"] });
    expect(linearizeC3("x.py::C", bases).order).toEqual(["x.py::C", "x.py::B", "x.py::A"]);
  });

  it("orders the classic diamond breadth-first, not depth-first", () => {
    // D(B, C), B(A), C(A) linearizes [D, B, C, A]. A DFS walk would give
    // [D, B, A, C] and find A's member before C's — the whole reason C3 exists.
    const bases = hierarchy({
      "d.py::D": ["d.py::B", "d.py::C"],
      "d.py::B": ["d.py::A"],
      "d.py::C": ["d.py::A"],
    });
    expect(linearizeC3("d.py::D", bases).order).toEqual(["d.py::D", "d.py::B", "d.py::C", "d.py::A"]);
  });

  it("puts every mixin before the base repository — polar's real shape", () => {
    const repo = "kit/repository/base.py::RepositoryBase";
    const softDel = "kit/repository/base.py::RepositorySoftDeletionMixin";
    const softDelId = "kit/repository/base.py::RepositorySoftDeletionIDMixin";
    const bases = hierarchy({
      "account/repository.py::AccountRepository": [softDelId, softDel, repo],
      [softDelId]: [softDel],
    });
    const { order, fallbacks } = linearizeC3("account/repository.py::AccountRepository", bases);
    expect(order).toEqual(["account/repository.py::AccountRepository", softDelId, softDel, repo]);
    expect(fallbacks).toBe(0);
    expect(new Set(order).size).toBe(order.length);
  });

  it("keeps two same-named classes in two files apart — keys are opaque", () => {
    const bases = hierarchy({ "a.py::C": ["a.py::Base"], "b.py::C": ["b.py::Base"] });
    expect(linearizeC3("a.py::C", bases).order).toEqual(["a.py::C", "a.py::Base"]);
    expect(linearizeC3("b.py::C", bases).order).toEqual(["b.py::C", "b.py::Base"]);
  });

  it("records a base declared twice exactly once", () => {
    const bases = hierarchy({ "x.py::C": ["x.py::A", "x.py::A"] });
    expect(linearizeC3("x.py::C", bases).order).toEqual(["x.py::C", "x.py::A"]);
  });

  it("asks the port for every class it visits, so a caller can record boundaries there", () => {
    const asked: string[] = [];
    const edges: Record<string, readonly string[]> = { "x.py::C": ["x.py::B"], "x.py::B": ["x.py::A"] };
    linearizeC3("x.py::C", (key) => {
      asked.push(key);
      return edges[key] ?? [];
    });
    expect(asked).toEqual(["x.py::C", "x.py::B", "x.py::A"]);
  });
});

describe("linearizeC3 — cycles", () => {
  it("terminates on a two-class cycle with each key present once", () => {
    const bases = hierarchy({ "x.py::A": ["x.py::B"], "x.py::B": ["x.py::A"] });
    expect(linearizeC3("x.py::A", bases).order).toEqual(["x.py::A", "x.py::B"]);
    expect(linearizeC3("x.py::B", bases).order).toEqual(["x.py::B", "x.py::A"]);
  });

  it("terminates on self-inheritance", () => {
    expect(linearizeC3("x.py::A", hierarchy({ "x.py::A": ["x.py::A"] })).order).toEqual(["x.py::A"]);
  });

  it("does not count a cycle as a C3 failure", () => {
    const bases = hierarchy({ "x.py::A": ["x.py::B"], "x.py::B": ["x.py::A"] });
    expect(linearizeC3("x.py::A", bases).fallbacks).toBe(0);
  });
});

describe("linearizeC3 — inconsistent hierarchies", () => {
  // Z(X, Y) where X(A, B) and Y(B, A) order the same two bases oppositely.
  // Python itself raises `TypeError: Cannot create a consistent method
  // resolution order` here; a lookup still has to answer, so the DFS fallback
  // does — and says so, because a silent fallback is an unmeasured order.
  const bases = hierarchy({
    "x.py::Z": ["x.py::X", "x.py::Y"],
    "x.py::X": ["x.py::A", "x.py::B"],
    "x.py::Y": ["x.py::B", "x.py::A"],
  });

  it("falls back to a deduped left-to-right DFS order", () => {
    const { order } = linearizeC3("x.py::Z", bases);
    expect(order).toEqual(["x.py::Z", "x.py::X", "x.py::A", "x.py::B", "x.py::Y"]);
    expect(new Set(order).size).toBe(order.length);
  });

  it("counts the fallback exactly once", () => {
    expect(linearizeC3("x.py::Z", bases).fallbacks).toBe(1);
  });

  it("leaves the consistent branches of the same hierarchy on C3", () => {
    expect(linearizeC3("x.py::X", bases)).toEqual({
      order: ["x.py::X", "x.py::A", "x.py::B"],
      fallbacks: 0,
    });
  });
});
