/**
 * `PythonImportFileMapper.resolveExportedName` (bd tea-rags-mcp-xpl83.3) at the
 * three points where it must answer NOTHING.
 *
 * The follow exists so netbox's `from core.models import ObjectType` can reach
 * the sibling module that declares the class rather than the `__init__.py` that
 * only re-exports it. Every widening of that walk is also a chance to attribute
 * a type to the wrong file, so the refusals are the contract:
 *
 *  - `*` is not a name, and a package that re-exports something ELSE has said
 *    nothing about the name asked for;
 *  - a re-export whose source module leaves the project contributes no evidence
 *    — attributing a class to `django/db/models` is the phantom this seam
 *    removes;
 *  - the answer is memoized per (file, name) for the run, so a repeat ask costs
 *    nothing and cannot drift.
 *
 * The relative-import arm is here for the same reason: `from . import x` in a
 * file sitting at the repo root has no package to be relative TO, and `unknown`
 * (never `external`) is what keeps the file out of the recall denominator.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, ModuleReexport } from "../../../../../../src/core/contracts/types/codegraph.js";
import { PythonImportFileMapper } from "../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function tableWith(files: Record<string, readonly string[]>): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, shortNames] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      shortNames.map((shortName) => ({ symbolId: shortName, fqName: shortName, shortName, relPath, scope: [] })),
    );
  }
  return table;
}

/** netbox's shape: a package `__init__.py` that declares nothing itself. */
const netbox = (): InMemoryGlobalSymbolTable =>
  tableWith({
    "core/__init__.py": [],
    "core/models/__init__.py": [],
    "core/models/object_types.py": ["ObjectType"],
    "core/models/jobs.py": ["Job"],
    "dcim/views.py": ["site_view"],
  });

function ctxWith(table: InMemoryGlobalSymbolTable, moduleReexports?: Record<string, ModuleReexport[]>): CallContext {
  return {
    callerFile: "dcim/views.py",
    callerScope: [],
    imports: [],
    symbolTable: table,
    moduleReexports,
  };
}

describe("PythonImportFileMapper.resolveExportedName refuses rather than guesses", () => {
  it("answers nothing for a name that names nothing in particular", () => {
    const mapper = new PythonImportFileMapper();
    const ctx = ctxWith(netbox(), {
      "core/models/__init__.py": [{ exportedName: "*", sourceModule: ".object_types" }],
    });

    // A star is what a package re-exports THROUGH, never a name to ask about.
    expect(mapper.resolveExportedName("core/models/__init__.py", "*", ctx)).toBeNull();
    expect(mapper.resolveExportedName("core/models/__init__.py", "", ctx)).toBeNull();
    // The same package does answer for a real name.
    expect(mapper.resolveExportedName("core/models/__init__.py", "ObjectType", ctx)).toBe(
      "core/models/object_types.py",
    );
  });

  it("contributes nothing from a re-export whose source module leaves the project", () => {
    const mapper = new PythonImportFileMapper();
    const ctx = ctxWith(netbox(), {
      "core/models/__init__.py": [
        // An explicit re-export out of a library: real statement, no project file.
        { exportedName: "ObjectType", sourceModule: "django.db.models", sourceName: "ObjectType" },
      ],
    });

    expect(mapper.resolveExportedName("core/models/__init__.py", "ObjectType", ctx)).toBeNull();
  });

  it("stays silent when the package re-exports a different name than the one asked for", () => {
    const mapper = new PythonImportFileMapper();
    const ctx = ctxWith(netbox(), {
      "core/models/__init__.py": [{ exportedName: "Job", sourceModule: ".jobs", sourceName: "Job" }],
    });

    expect(mapper.resolveExportedName("core/models/__init__.py", "ObjectType", ctx)).toBeNull();
    expect(mapper.resolveExportedName("core/models/__init__.py", "Job", ctx)).toBe("core/models/jobs.py");
  });

  it("answers a repeat ask from the memo instead of re-walking the re-export tree", () => {
    const mapper = new PythonImportFileMapper();
    const table = netbox();
    const reexports: Record<string, ModuleReexport[]> = {
      "core/models/__init__.py": [{ exportedName: "*", sourceModule: ".object_types" }],
    };
    const ctx = ctxWith(table, reexports);

    expect(mapper.resolveExportedName("core/models/__init__.py", "ObjectType", ctx)).toBe(
      "core/models/object_types.py",
    );

    // Take the statements away: a memoized answer is what makes the second ask
    // free, and it is keyed by (file, name) for the life of this table.
    reexports["core/models/__init__.py"] = [];
    expect(mapper.resolveExportedName("core/models/__init__.py", "ObjectType", ctx)).toBe(
      "core/models/object_types.py",
    );
  });
});

describe("PythonImportFileMapper maps a relative import with no package to be relative to", () => {
  it("answers unknown — never external — for `from . import x` at the repo root", () => {
    const mapper = new PythonImportFileMapper();
    const table = tableWith({ "views.py": ["index"], "helpers.py": ["helper"] });
    const ctx = ctxWith(table);

    expect(mapper.mapImportToFile(".", "views.py", { ...ctx, callerFile: "views.py" })).toEqual({ kind: "unknown" });
  });
});
