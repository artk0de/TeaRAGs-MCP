/**
 * A base class reached through a package that re-exports a SUBMODULE under an
 * alias (bd tea-rags-mcp-w205u, E4.4c).
 *
 * polar's `server/polar/backoffice/components/__init__.py` opens with
 * `from . import _datatable as datatable`, and nineteen `super().__init__()`
 * sites inherit from `datatable.DatatableAttrColumn[…]`. The walker does its
 * half correctly — the generic subscript is stripped and the base is qualified
 * `..components.datatable::DatatableAttrColumn` — but `..components.datatable`
 * names no file, so the ancestor policy read the base `unknown`, the MRO closed
 * nothing, and `super` dropped.
 *
 * The receiver channel already asks `resolveExportedModule` for exactly this
 * (E4.6a, `importedName`'s module arm). The ancestor channel now asks the same
 * question of a base SPELLING: the package half of the module text, then the
 * alias name, with an explicit alias naming exactly one module.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, CallRef, ModuleReexport } from "../../../../../../src/core/contracts/types/codegraph.js";
import { PythonAncestorLinearizerCache } from "../../../../../../src/core/domains/language/python/resolver/python-ancestor-policy.js";
import { PythonImportFileMapper } from "../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { PythonSuperSymbolResolutionStrategy } from "../../../../../../src/core/domains/language/python/resolver/strategies/python-super.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const CALLER = "server/polar/backoffice/customers/components.py";
const PKG = "server/polar/backoffice/components/__init__.py";
const DATATABLE = "server/polar/backoffice/components/_datatable.py";

function tableWith(files: Record<string, readonly string[]>): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      defs.map((symbolId) => ({
        symbolId,
        fqName: symbolId,
        shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
        relPath,
        scope: [],
      })),
    );
  }
  return table;
}

const FILES: Record<string, readonly string[]> = {
  "server/polar/__init__.py": ["__all__"],
  "server/polar/backoffice/__init__.py": ["__all__"],
  [PKG]: [],
  [DATATABLE]: ["DatatableAttrColumn", "DatatableAttrColumn#__init__"],
  [CALLER]: ["CustomerIDColumn"],
};

const ALIAS: Record<string, readonly ModuleReexport[]> = {
  [PKG]: [{ exportedName: "datatable", sourceModule: ".", sourceName: "_datatable" }],
};

function ctxWith(spec: {
  readonly base: string;
  readonly moduleReexports?: Record<string, readonly ModuleReexport[]>;
}): CallContext {
  return {
    callerFile: CALLER,
    callerScope: ["CustomerIDColumn", "__init__"],
    imports: [],
    symbolTable: tableWith(FILES),
    classAncestors: { [`${CALLER}::CustomerIDColumn`]: [spec.base] },
    moduleReexports: spec.moduleReexports ?? ALIAS,
  };
}

const superInit: CallRef = { callText: "super().__init__()", receiver: "super()", member: "__init__", startLine: 14 };

function superStrategy(): PythonSuperSymbolResolutionStrategy {
  const mapper = new PythonImportFileMapper();
  return new PythonSuperSymbolResolutionStrategy(
    { mode: "strict" },
    new PythonAncestorLinearizerCache(mapper, "strict"),
  );
}

describe("the ancestor policy — a base under a package's MODULE alias", () => {
  it("resolves `super().__init__()` through `from . import _datatable as datatable`", () => {
    expect(
      superStrategy().attempt(superInit, ctxWith({ base: "..components.datatable::DatatableAttrColumn" })),
    ).toEqual({
      kind: "resolved",
      target: { targetRelPath: DATATABLE, targetSymbolId: "DatatableAttrColumn#__init__" },
    });
  });

  it("leaves an EXTERNAL module text alone — the hop runs only on `unknown`", () => {
    // `mapAbsolute` answers `external` for an absolute text no root maps, which
    // is the library verdict a miss under it must keep. Asking the alias hop
    // there would let a project package that happens to bind the last segment
    // capture `django.db.models`, so the short-circuit stands and the measured
    // shape (all nineteen rows) is the relative one above.
    const base = "polar.backoffice.components.datatable::DatatableAttrColumn";
    expect(superStrategy().attempt(superInit, ctxWith({ base }))).toEqual({ kind: "drop" });
  });

  it("drops when the package aliases no such module — the hop invents nothing", () => {
    expect(superStrategy().attempt(superInit, ctxWith({ base: "..components.missing::DatatableAttrColumn" }))).toEqual({
      kind: "drop",
    });
  });

  it("drops when the package re-exports nothing at all", () => {
    const ctx = ctxWith({ base: "..components.datatable::DatatableAttrColumn", moduleReexports: {} });
    expect(superStrategy().attempt(superInit, ctx)).toEqual({ kind: "drop" });
  });
});
