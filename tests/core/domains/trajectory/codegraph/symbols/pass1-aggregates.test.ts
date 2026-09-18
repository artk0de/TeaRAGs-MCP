/**
 * What earns a `cg_pass1_aggregates` row, and what earns a key inside one
 * (bd tea-rags-mcp-znxg8, extended by bd tea-rags-mcp-4yvms).
 *
 * `buildPass1Aggregates` returning `undefined` is what keeps the table
 * proportional to the project's CLASSES rather than to its files, and dropping
 * empty sub-maps is that same rule one level down. Both are load-bearing rather
 * than tidiness: hydration reads `undefined` and an empty object identically, so
 * a channel that materializes `{}` for every module costs bytes on every row and
 * buys nothing. The two Python channels are the newest members and the easiest
 * to get wrong, because a Python file that merely imports something has a
 * `moduleReexports` list while declaring no class at all.
 */
import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  buildPass1Aggregates,
  selectHydratablePass1Aggregates,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/pass1-aggregates.js";

function extraction(relPath: string, extra: Partial<FileExtraction> = {}): FileExtraction {
  return { relPath, language: "python", imports: [], fileScope: [], chunks: [], ...extra };
}

describe("buildPass1Aggregates", () => {
  it("gives no row to a file that declares nothing pass-2 reads run-globally", () => {
    expect(buildPass1Aggregates(extraction("app/views.py"), [])).toBeUndefined();
  });

  it("gives no row for empty sub-maps either", () => {
    const slice = buildPass1Aggregates(
      extraction("app/views.py", {
        classAncestors: {},
        classFieldTypesByClassKey: {},
        moduleReexports: [],
      }),
      [],
    );

    expect(slice).toBeUndefined();
  });

  it("carries the class-key-addressed field channel when the walker wrote one", () => {
    const slice = buildPass1Aggregates(
      extraction("app/models.py", {
        classFieldTypesByClassKey: { "app/models.py::Site": { objects: "SiteQuerySet" } },
      }),
      [],
    );

    expect(slice).toEqual({
      relPath: "app/models.py",
      language: "python",
      classFieldTypesByClassKey: { "app/models.py::Site": { objects: "SiteQuerySet" } },
    });
  });

  it("carries the re-export list on its own, for a package that declares nothing else", () => {
    const reexports = [{ exportedName: "ObjectType", sourceModule: ".object_types", sourceName: "ObjectType" }];
    const slice = buildPass1Aggregates(extraction("core/models/__init__.py", { moduleReexports: reexports }), []);

    expect(slice).toEqual({
      relPath: "core/models/__init__.py",
      language: "python",
      moduleReexports: reexports,
    });
  });
});

describe("selectHydratablePass1Aggregates", () => {
  it("keeps every row whose file this run did not walk and drops the rest", () => {
    const rows = [
      { relPath: "app/models.py", language: "python" },
      { relPath: "core/models/__init__.py", language: "python" },
    ];

    expect(selectHydratablePass1Aggregates(rows, new Set(["app/models.py"]))).toEqual([
      { relPath: "core/models/__init__.py", language: "python" },
    ]);
  });
});
