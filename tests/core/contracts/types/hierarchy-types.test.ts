import { describe, expect, it } from "vitest";

import type {
  HierarchyQuery,
  HierarchySnapshot,
  HierarchyView,
  InheritanceEdge,
  InheritanceEdgeDecl,
  InheritanceEdgeRow,
  InheritanceKind,
} from "../../../../src/core/contracts/types/codegraph.js";

describe("hierarchy contract types", () => {
  it("InheritanceEdge carries fq names, nullable symbol id, kind, depth", () => {
    const edge: InheritanceEdge = {
      sourceFqName: "Foo",
      ancestorFqName: "Bar",
      ancestorSymbolId: null,
      kind: "implements",
      depth: 1,
    };
    expect(edge.ancestorSymbolId).toBeNull();
  });

  it("HierarchyView exposes getAncestors + getDescendants", () => {
    const view: HierarchyView = {
      getAncestors: () => [],
      getDescendants: () => [],
    };
    expect(view.getAncestors("X")).toEqual([]);
    expect(view.getDescendants("X")).toEqual([]);
  });

  it("InheritanceEdgeDecl is the walker emission shape (no resolved symbol id)", () => {
    const decl: InheritanceEdgeDecl = { source: "Foo", ancestor: "Bar", kind: "super", ordinal: 0 };
    expect(decl.kind).toBe("super");
  });

  it("InheritanceEdgeRow carries resolved symbol ids and ordinal", () => {
    const row: InheritanceEdgeRow = {
      sourceFqName: "Foo",
      sourceSymbolId: "Foo",
      ancestorFqName: "Bar",
      ancestorSymbolId: null,
      kind: "extend",
      ordinal: 2,
    };
    expect(row.ordinal).toBe(2);
  });

  it("HierarchyQuery options and HierarchySnapshot shape compile", () => {
    const q: HierarchyQuery = { kinds: ["super", "implements"], transitive: true, ordered: true };
    const snap: HierarchySnapshot = { ancestorsBySource: {}, descendantsByAncestor: {} };
    const kind: InheritanceKind = "prepend";
    expect(q.transitive).toBe(true);
    expect(snap.ancestorsBySource).toEqual({});
    expect(kind).toBe("prepend");
  });
});
