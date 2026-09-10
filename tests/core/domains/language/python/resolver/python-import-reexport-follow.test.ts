/**
 * Following a package's re-exports to the file that DECLARES a name (bd
 * tea-rags-mcp-xpl83.3, E3 increment 2).
 *
 * netbox writes `from core.models import ObjectType` in 117 call sites.
 * `core/models/__init__.py` declares nothing — it star-imports six sibling
 * modules — and netbox declares a SECOND `ObjectType` in
 * `netbox/graphql/types.py`. So `resolveTypeFile`'s short-name pass is
 * ambiguous, its import-narrowing pass filters the two candidates against a set
 * holding only `__init__.py`, and the whole chain refuses. Correctly: it must
 * not pick between namesakes on no evidence.
 *
 * The evidence it was missing is the second hop. The mapper follows the
 * re-export ONLY when the file it mapped to declares nothing under the name, so
 * every row that resolves today resolves to the same file; a star that two
 * sources answer is still a refusal, and the walk is bounded.
 */
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  ImportRef,
  ModuleReexport,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { PythonAncestorLinearizerCache } from "../../../../../../src/core/domains/language/python/resolver/python-ancestor-policy.js";
import { PythonImportFileMapper } from "../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { PythonChainTypeSymbolResolutionStrategy } from "../../../../../../src/core/domains/language/python/resolver/strategies/python-chain-type.js";
import { resolveTypeFile } from "../../../../../../src/core/domains/language/python/resolver/strategies/shared.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

interface Def {
  readonly symbolId: string;
  readonly scope?: readonly string[];
}

function tableWith(files: Record<string, readonly Def[]>): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      defs.map((def) => ({
        symbolId: def.symbolId,
        fqName: def.symbolId,
        shortName: def.symbolId.split(/[#.]/).pop() ?? def.symbolId,
        relPath,
        scope: [...(def.scope ?? [])],
      })),
    );
  }
  return table;
}

/**
 * netbox's shape: the import root is the repo root, `core/models` is a package
 * whose `__init__.py` declares nothing, and `netbox/graphql` owns the namesake.
 */
const netboxTable = (): InMemoryGlobalSymbolTable =>
  tableWith({
    "core/__init__.py": [],
    "core/models/__init__.py": [],
    "core/models/object_types.py": [
      { symbolId: "ObjectType" },
      { symbolId: "ObjectTypeManager" },
      { symbolId: "ObjectTypeManager#get_for_model", scope: ["ObjectTypeManager"] },
    ],
    "core/models/jobs.py": [{ symbolId: "Job" }],
    "netbox/graphql/__init__.py": [],
    "netbox/graphql/types.py": [{ symbolId: "ObjectType" }],
    "dcim/views.py": [{ symbolId: "site_view" }],
  });

const STAR_REEXPORTS: Record<string, ModuleReexport[]> = {
  "core/models/__init__.py": [
    { exportedName: "*", sourceModule: ".object_types" },
    { exportedName: "*", sourceModule: ".jobs" },
  ],
};

const importOf = (importText: string, name: string): ImportRef => ({
  importText,
  startLine: 1,
  importedNames: [name],
  importedBindings: { [name]: name },
});

interface CtxParts {
  readonly table?: InMemoryGlobalSymbolTable;
  readonly imports?: readonly ImportRef[];
  readonly moduleReexports?: Record<string, ModuleReexport[]>;
  readonly classFieldTypesByClassKey?: Record<string, Record<string, string>>;
  readonly classFieldTypes?: Record<string, Record<string, string>>;
}

function ctxWith(parts: CtxParts = {}): CallContext {
  return {
    callerFile: "dcim/views.py",
    callerScope: [],
    imports: [...(parts.imports ?? [importOf("core.models", "ObjectType")])],
    symbolTable: parts.table ?? netboxTable(),
    moduleReexports: parts.moduleReexports ?? STAR_REEXPORTS,
    classFieldTypes: parts.classFieldTypes,
    classFieldTypesByClassKey: parts.classFieldTypesByClassKey,
  };
}

describe("resolveTypeFile — a package that re-exports the name it was asked for", () => {
  it("follows a STAR re-export to the only sibling module declaring the name", () => {
    expect(resolveTypeFile("ObjectType", ctxWith(), new PythonImportFileMapper())).toBe("core/models/object_types.py");
  });

  it("follows an EXPLICIT re-export, alias included", () => {
    const ctx = ctxWith({
      imports: [importOf("core.models", "ContentType")],
      moduleReexports: {
        "core/models/__init__.py": [
          { exportedName: "ContentType", sourceModule: ".object_types", sourceName: "ObjectType" },
        ],
      },
    });
    // The name under resolution is the EXPORTED one; the alias entry is what
    // carries it to `object_types.ObjectType`.
    expect(resolveTypeFile("ContentType", ctx, new PythonImportFileMapper())).toBeNull();
    expect(
      resolveTypeFile(
        "ObjectType",
        ctxWith({
          moduleReexports: {
            "core/models/__init__.py": [
              { exportedName: "ObjectType", sourceModule: ".object_types", sourceName: "ObjectType" },
            ],
          },
        }),
        new PythonImportFileMapper(),
      ),
    ).toBe("core/models/object_types.py");
  });

  it("REFUSES when two star sources both declare the name", () => {
    const table = tableWith({
      "core/__init__.py": [],
      "core/models/__init__.py": [],
      "core/models/object_types.py": [{ symbolId: "ObjectType" }],
      "core/models/jobs.py": [{ symbolId: "ObjectType" }],
      "netbox/graphql/__init__.py": [],
      "netbox/graphql/types.py": [{ symbolId: "ObjectType" }],
      "dcim/views.py": [{ symbolId: "site_view" }],
    });
    expect(resolveTypeFile("ObjectType", ctxWith({ table }), new PythonImportFileMapper())).toBeNull();
  });

  it("stops at the hop budget rather than walking a long re-export tower", () => {
    const table = tableWith({
      "a/__init__.py": [],
      "a/b/__init__.py": [],
      "a/b/c/__init__.py": [],
      "a/b/c/d/__init__.py": [],
      "a/b/c/d/leaf.py": [{ symbolId: "Deep" }],
      "other/__init__.py": [],
      "other/dup.py": [{ symbolId: "Deep" }],
      "app/views.py": [{ symbolId: "view" }],
    });
    const tower: Record<string, ModuleReexport[]> = {
      "a/__init__.py": [{ exportedName: "*", sourceModule: ".b" }],
      "a/b/__init__.py": [{ exportedName: "*", sourceModule: ".c" }],
      "a/b/c/__init__.py": [{ exportedName: "*", sourceModule: ".d" }],
      "a/b/c/d/__init__.py": [{ exportedName: "*", sourceModule: ".leaf" }],
    };
    const ctxAt = (importText: string): CallContext => ({
      callerFile: "app/views.py",
      callerScope: [],
      imports: [importOf(importText, "Deep")],
      symbolTable: table,
      moduleReexports: tower,
    });
    // Three hops is inside the budget: b -> c -> d -> leaf is reached from `a.b`.
    expect(resolveTypeFile("Deep", ctxAt("a.b"), new PythonImportFileMapper())).toBe("a/b/c/d/leaf.py");
    // Four is not.
    expect(resolveTypeFile("Deep", ctxAt("a"), new PythonImportFileMapper())).toBeNull();
  });

  it("survives a re-export cycle instead of recursing forever", () => {
    const table = tableWith({
      "pkg/__init__.py": [],
      "pkg/one.py": [],
      "pkg/two.py": [],
      // Two declarers, so the short-name pass is ambiguous and the follow runs.
      "other/__init__.py": [],
      "other/dup.py": [{ symbolId: "Ghost" }],
      "another/__init__.py": [],
      "another/dup.py": [{ symbolId: "Ghost" }],
      "app/views.py": [{ symbolId: "view" }],
    });
    const cycle: Record<string, ModuleReexport[]> = {
      "pkg/__init__.py": [{ exportedName: "*", sourceModule: ".one" }],
      "pkg/one.py": [{ exportedName: "*", sourceModule: ".two" }],
      "pkg/two.py": [{ exportedName: "*", sourceModule: "." }],
    };
    const ctx: CallContext = {
      callerFile: "app/views.py",
      callerScope: [],
      imports: [importOf("pkg", "Ghost")],
      symbolTable: table,
      moduleReexports: cycle,
    };
    expect(resolveTypeFile("Ghost", ctx, new PythonImportFileMapper())).toBeNull();
  });

  it("leaves an unambiguous name alone — the follow never runs", () => {
    const table = tableWith({
      "core/__init__.py": [],
      "core/models/__init__.py": [],
      "core/models/jobs.py": [{ symbolId: "Job" }],
      "dcim/views.py": [{ symbolId: "site_view" }],
    });
    expect(
      resolveTypeFile(
        "Job",
        ctxWith({ table, imports: [importOf("core.models", "Job")] }),
        new PythonImportFileMapper(),
      ),
    ).toBe("core/models/jobs.py");
  });

  it("keeps refusing when nothing re-exports the name", () => {
    expect(resolveTypeFile("ObjectType", ctxWith({ moduleReexports: {} }), new PythonImportFileMapper())).toBeNull();
  });
});

describe("the netbox row the follow unlocks", () => {
  const getForModel: CallRef = {
    callText: "ObjectType.objects.get_for_model(model)",
    receiver: "ObjectType.objects",
    member: "get_for_model",
    startLine: 12,
  };

  function strategy(): PythonChainTypeSymbolResolutionStrategy {
    const mapper = new PythonImportFileMapper();
    return new PythonChainTypeSymbolResolutionStrategy(
      { mode: "strict" },
      mapper,
      new PythonAncestorLinearizerCache(mapper, "strict"),
    );
  }

  it("folds `ObjectType.objects.get_for_model(…)` onto the manager past the namesake", () => {
    const ctx = ctxWith({
      classFieldTypes: { ObjectType: { objects: "ObjectTypeManager" } },
      classFieldTypesByClassKey: { "core/models/object_types.py::ObjectType": { objects: "ObjectTypeManager" } },
    });
    expect(strategy().attempt(getForModel, ctx)).toEqual({
      kind: "resolved",
      target: {
        targetRelPath: "core/models/object_types.py",
        targetSymbolId: "ObjectTypeManager#get_for_model",
      },
    });
  });

  it("still refuses with the re-export channel absent — the pre-seam answer", () => {
    const ctx = ctxWith({
      moduleReexports: {},
      classFieldTypes: { ObjectType: { objects: "ObjectTypeManager" } },
      classFieldTypesByClassKey: { "core/models/object_types.py::ObjectType": { objects: "ObjectTypeManager" } },
    });
    expect(strategy().attempt(getForModel, ctx)).toEqual({ kind: "continue" });
  });
});
