/**
 * The `cg_pass1_aggregates` row codec round trip (bd tea-rags-mcp-znxg8, extended
 * by bd tea-rags-mcp-4yvms).
 *
 * The slice travels as ONE json column, so a field added to
 * `CodegraphPass1FileAggregates` reaches the database through a spread rather
 * than through a named column — which is why it needs no migration and why it
 * needs a test: nothing in the type system notices a field the codec silently
 * drops, and hydration would then read the map as absent on every incremental
 * run while the suite stayed green.
 */
import { describe, expect, it } from "vitest";

import {
  CG_PASS1_DEF_COLUMNS,
  fromCgPass1Row,
  toCgPass1Row,
  type CgPass1AggregatesRow,
} from "../../../../src/core/adapters/duckdb/cg-pass1-aggregates-row.js";
import type { CodegraphPass1FileAggregates } from "../../../../src/core/contracts/types/codegraph.js";

/** Project to a tuple and read it straight back, as the write path and the hydration SELECT do. */
function roundTrip(slice: CodegraphPass1FileAggregates): CodegraphPass1FileAggregates {
  const [rel_path, language, aggregates_json] = toCgPass1Row(slice) as [string, string, string];
  const row: CgPass1AggregatesRow = { rel_path, language, aggregates_json };
  return fromCgPass1Row(row);
}

describe("cg_pass1_aggregates row codec", () => {
  it("emits the tuple in column order", () => {
    expect(CG_PASS1_DEF_COLUMNS).toEqual(["rel_path", "language", "aggregates_json"]);
    expect(toCgPass1Row({ relPath: "app/models.py", language: "python" })).toEqual(["app/models.py", "python", "{}"]);
  });

  it("round-trips every channel the slice carries, the two Python maps included", () => {
    const slice: CodegraphPass1FileAggregates = {
      relPath: "core/models/__init__.py",
      language: "python",
      classAncestors: { "core/models/__init__.py::Site": ["NetBoxModel"] },
      classPrependedAncestors: { "core/models/__init__.py::Site": ["Auditable"] },
      classExtends: { Site: "NetBoxModel" },
      compactDeclaredClasses: ["core.models.Site"],
      inheritanceEdges: [{ source: "Site", ancestor: "NetBoxModel", kind: "super", ordinal: 0 }],
      selfDispatchMethods: [{ symbolId: "Site#save", enclosingType: "Site", selfHookCandidates: ["clean"] }],
      structuredReturnTypes: { "Site#queryset": { form: "instance", name: "SiteQuerySet" } },
      functionReturnTypes: { build_site: "Site" },
      classFieldTypesByClassKey: { "core/models/__init__.py::Site": { objects: "SiteQuerySet" } },
      moduleReexports: [{ exportedName: "ObjectType", sourceModule: ".object_types", sourceName: "ObjectType" }],
    };

    expect(roundTrip(slice)).toEqual(slice);
  });

  it("keeps an absent channel absent rather than materializing an empty one", () => {
    const slice: CodegraphPass1FileAggregates = { relPath: "app/views.py", language: "python" };
    const restored = roundTrip(slice);

    expect(restored).toEqual(slice);
    expect("classFieldTypesByClassKey" in restored).toBe(false);
    expect("moduleReexports" in restored).toBe(false);
  });

  it("degrades a malformed blob to a file that contributed nothing", () => {
    expect(fromCgPass1Row({ rel_path: "app/models.py", language: "python", aggregates_json: "{not json" })).toEqual({
      relPath: "app/models.py",
      language: "python",
    });
  });
});
