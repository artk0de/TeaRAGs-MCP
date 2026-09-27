import { describe, expect, it } from "vitest";

import type { HierarchySnapshot, InheritanceEdgeRow } from "../../../../../src/core/contracts/types/codegraph.js";
import {
  MapHierarchyView,
  MRO_ORDINAL_DIRECTION,
  MRO_RANK,
} from "../../../../../src/core/domains/trajectory/codegraph/hierarchy-view.js";

function r(
  source: string,
  ancestor: string,
  kind: InheritanceEdgeRow["kind"],
  ordinal = 0,
  ancestorSymbolId: string | null = ancestor,
): InheritanceEdgeRow {
  return { sourceFqName: source, sourceSymbolId: source, ancestorFqName: ancestor, ancestorSymbolId, kind, ordinal };
}

// Service -prepend-> Logging, -include-> Comparable(ord0) + Auditable(ord1),
//         -super-> Base -super-> Object(external)
const snap: HierarchySnapshot = {
  ancestorsBySource: {
    Service: [
      r("Service", "Logging", "prepend"),
      r("Service", "Base", "super"),
      r("Service", "Comparable", "include", 0),
      r("Service", "Auditable", "include", 1),
    ],
    Base: [r("Base", "Object", "super", 0, null)],
  },
  descendantsByAncestor: {
    Logging: [r("Service", "Logging", "prepend")],
    Comparable: [r("Service", "Comparable", "include", 0)],
    Auditable: [r("Service", "Auditable", "include", 1)],
    Base: [r("Service", "Base", "super")],
    Object: [r("Base", "Object", "super", 0, null)],
  },
};

describe("MapHierarchyView", () => {
  const view = new MapHierarchyView(snap);

  it("getAncestors returns direct ancestors", () => {
    expect(
      view
        .getAncestors("Service")
        .map((e) => e.ancestorFqName)
        .sort(),
    ).toEqual(["Auditable", "Base", "Comparable", "Logging"]);
  });

  it("ordered=true yields MRO: prepend, include, include, super", () => {
    expect(view.getAncestors("Service", { ordered: true }).map((e) => e.kind)).toEqual([
      "prepend",
      "include",
      "include",
      "super",
    ]);
  });

  it("ordered puts the LATER include nearer (Ruby: include Comparable; include Auditable → [Auditable, Comparable])", () => {
    // bd tea-rags-mcp-u0t4p: each `include` inserts at the front of the mixin
    // region, so `Service.ancestors == [Service, Auditable, Comparable, …]`.
    const includes = view
      .getAncestors("Service", { ordered: true })
      .filter((e) => e.kind === "include")
      .map((e) => e.ancestorFqName);
    expect(includes).toEqual(["Auditable", "Comparable"]);
  });

  it("ordered puts the LATER prepend nearer (prepend A; prepend B → [B, A, C])", () => {
    const prepends: HierarchySnapshot = {
      ancestorsBySource: { C: [r("C", "A", "prepend", 0), r("C", "B", "prepend", 1)] },
      descendantsByAncestor: {},
    };
    const names = new MapHierarchyView(prepends).getAncestors("C", { ordered: true }).map((e) => e.ancestorFqName);
    expect(names).toEqual(["B", "A"]);
  });

  it("ordered puts the LATER extend nearer", () => {
    const extendsSnap: HierarchySnapshot = {
      ancestorsBySource: { C: [r("C", "A", "extend", 0), r("C", "B", "extend", 1)] },
      descendantsByAncestor: {},
    };
    const names = new MapHierarchyView(extendsSnap).getAncestors("C", { ordered: true }).map((e) => e.ancestorFqName);
    expect(names).toEqual(["B", "A"]);
  });

  it("ordered keeps nominal base-list order for super and implements (Python class C(A, B) → A before B)", () => {
    const bases: HierarchySnapshot = {
      ancestorsBySource: {
        C: [
          r("C", "B", "super", 1),
          r("C", "A", "super", 0),
          r("C", "J", "implements", 1),
          r("C", "I", "implements", 0),
        ],
      },
      descendantsByAncestor: {},
    };
    const names = new MapHierarchyView(bases).getAncestors("C", { ordered: true }).map((e) => e.ancestorFqName);
    expect(names).toEqual(["I", "J", "A", "B"]);
  });

  it("kinds sharing an MRO rank share an ordinal direction (the comparator stays a total order)", () => {
    const kinds = Object.keys(MRO_RANK) as InheritanceEdgeRow["kind"][];
    for (const a of kinds) {
      for (const b of kinds) {
        if (MRO_RANK[a] === MRO_RANK[b]) expect([a, MRO_ORDINAL_DIRECTION[a]]).toEqual([a, MRO_ORDINAL_DIRECTION[b]]);
      }
    }
  });

  it("returns empty for a type absent from the snapshot", () => {
    expect(view.getAncestors("Unknown")).toEqual([]);
    expect(view.getDescendants("Unknown")).toEqual([]);
  });

  it("transitive getDescendants walks the reverse chain Object -> Base -> Service", () => {
    const names = view.getDescendants("Object", { transitive: true }).map((e) => e.sourceFqName);
    expect(names).toEqual(["Base", "Service"]);
  });

  it("transitive getAncestors walks Service -> Base -> Object", () => {
    expect(view.getAncestors("Service", { transitive: true }).map((e) => e.ancestorFqName)).toContain("Object");
  });

  it("kinds filter restricts edge kinds", () => {
    expect(view.getAncestors("Service", { kinds: ["super"] }).map((e) => e.ancestorFqName)).toEqual(["Base"]);
  });

  it("getDescendants reads the reverse index; kinds filter applies", () => {
    expect(view.getDescendants("Base").map((e) => e.sourceFqName)).toEqual(["Service"]);
    expect(view.getDescendants("Base", { kinds: ["implements"] })).toEqual([]);
  });

  it("ordered is ignored for getDescendants (ancestors-only MRO)", () => {
    expect(view.getDescendants("Base", { ordered: true }).map((e) => e.sourceFqName)).toEqual(["Service"]);
  });

  it("external ancestor (null symbol id) is preserved in the edge", () => {
    const objectEdge = view.getAncestors("Base")[0];
    expect(objectEdge.ancestorFqName).toBe("Object");
    expect(objectEdge.ancestorSymbolId).toBeNull();
  });
});
