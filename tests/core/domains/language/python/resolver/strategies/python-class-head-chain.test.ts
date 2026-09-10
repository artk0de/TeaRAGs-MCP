/**
 * A bare CLASS name as a multi-link chain HEAD (bd tea-rags-mcp-xpl83, E3
 * increment 1).
 *
 * The class-body field facts type `<Model>.objects`, but the fold could not
 * reach them: `seedHead` only knew module aliases (`mod.Cls()`) and
 * `singleHopType`'s class arm is off for `chainType` by design — turning it on
 * globally would answer single-hop `Cls.member()` one pass before
 * `importedName` and through the weaker `classExtends` walk.
 *
 * The arm here is the narrow half of that: a chain head only. `seedHead` is
 * reached exclusively from `propagateChain`, so a single-segment receiver never
 * sees it, and stop-at-unknown-hop makes the seed inert unless the very next
 * link has a real fact — a class with no field named `objects` folds to nothing
 * and the call reaches the same strategy it reaches today.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, CallRef, ImportRef } from "../../../../../../../src/core/contracts/types/codegraph.js";
import { PythonAncestorLinearizerCache } from "../../../../../../../src/core/domains/language/python/resolver/python-ancestor-policy.js";
import { PythonImportFileMapper } from "../../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { PythonChainTypeSymbolResolutionStrategy } from "../../../../../../../src/core/domains/language/python/resolver/strategies/python-chain-type.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

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

function strategy(): PythonChainTypeSymbolResolutionStrategy {
  const mapper = new PythonImportFileMapper();
  return new PythonChainTypeSymbolResolutionStrategy(
    { mode: "strict" },
    mapper,
    new PythonAncestorLinearizerCache(mapper, "strict"),
  );
}

const netboxTable = (): InMemoryGlobalSymbolTable =>
  tableWith({
    "core/models/object_types.py": [
      { symbolId: "ObjectTypeManager" },
      { symbolId: "ObjectTypeManager#get_for_model", scope: ["ObjectTypeManager"] },
      { symbolId: "ObjectType" },
    ],
    "netbox/models/__init__.py": [{ symbolId: "PrimaryModel" }],
    "dcim/models/sites.py": [{ symbolId: "Site" }],
    "dcim/views.py": [{ symbolId: "site_view" }],
  });

const importOf = (importText: string, name: string): ImportRef => ({
  importText,
  importedNames: [name],
  importedBindings: { [name]: name },
});

const getForModel: CallRef = {
  callText: "ObjectType.objects.get_for_model(model)",
  receiver: "ObjectType.objects",
  member: "get_for_model",
  startLine: 12,
};

interface CtxParts {
  readonly classFieldTypes?: Record<string, Record<string, string>>;
  readonly classFieldTypesByClassKey?: Record<string, Record<string, string>>;
  readonly classAncestors?: Record<string, readonly string[]>;
  readonly imports?: readonly ImportRef[];
  readonly localBindings?: CallContext["localBindings"];
}

function ctxWith(parts: CtxParts): CallContext {
  return {
    callerFile: "dcim/views.py",
    callerScope: [],
    imports: [...(parts.imports ?? [importOf("core.models.object_types", "ObjectType")])],
    symbolTable: netboxTable(),
    classFieldTypes: parts.classFieldTypes,
    classFieldTypesByClassKey: parts.classFieldTypesByClassKey,
    classAncestors: parts.classAncestors,
    localBindings: parts.localBindings,
  };
}

const resolvedTo = (relPath: string, symbolId: string) => ({
  kind: "resolved",
  target: { targetRelPath: relPath, targetSymbolId: symbolId },
});

describe("PythonChainTypeSymbolResolutionStrategy — a class-body manager attribute", () => {
  it("folds `ObjectType.objects.get_for_model(…)` onto the manager's own method", () => {
    const ctx = ctxWith({
      classFieldTypes: { ObjectType: { objects: "ObjectTypeManager" } },
      classFieldTypesByClassKey: { "core/models/object_types.py::ObjectType": { objects: "ObjectTypeManager" } },
    });
    expect(strategy().attempt(getForModel, ctx)).toEqual(
      resolvedTo("core/models/object_types.py", "ObjectTypeManager#get_for_model"),
    );
  });

  it("inherits the manager attribute from a base class in another file", () => {
    const call: CallRef = {
      callText: "Site.objects.get_for_model(model)",
      receiver: "Site.objects",
      member: "get_for_model",
      startLine: 30,
    };
    const ctx = ctxWith({
      imports: [importOf("dcim.models.sites", "Site")],
      classAncestors: {
        "dcim/models/sites.py::Site": ["netbox.models::PrimaryModel"],
        "netbox/models/__init__.py::PrimaryModel": [],
      },
      classFieldTypesByClassKey: {
        "netbox/models/__init__.py::PrimaryModel": { objects: "ObjectTypeManager" },
      },
    });
    expect(strategy().attempt(call, ctx)).toEqual(
      resolvedTo("core/models/object_types.py", "ObjectTypeManager#get_for_model"),
    );
  });

  it("stays inert when the head has no fact for the first link", () => {
    // Stop-at-unknown-hop: nothing types `ObjectType.objects`, so the whole
    // receiver is untyped and the call reaches the later strategies unchanged.
    expect(strategy().attempt(getForModel, ctxWith({}))).toEqual({ kind: "continue" });
  });

  it("stays inert when the head is not a project class", () => {
    const call: CallRef = {
      callText: "Path.objects.get_for_model(model)",
      receiver: "Path.objects",
      member: "get_for_model",
      startLine: 7,
    };
    const ctx = ctxWith({
      imports: [],
      classFieldTypes: { Path: { objects: "ObjectTypeManager" } },
    });
    expect(strategy().attempt(call, ctx)).toEqual({ kind: "continue" });
  });

  it("yields to a local variable that shadows the class name", () => {
    const ctx = ctxWith({
      classFieldTypes: { ObjectType: { objects: "ObjectTypeManager" } },
      localBindings: { ObjectType: [{ line: 3, type: "Site" }] },
    });
    expect(strategy().attempt(getForModel, ctx)).toEqual({ kind: "continue" });
  });
});
