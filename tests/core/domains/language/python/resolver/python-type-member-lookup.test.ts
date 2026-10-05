/**
 * Python's `TypeMemberLookup` (bd tea-rags-mcp-m99j1.1.4): a member on a named
 * type resolved through the C3 MRO, with the `class` form preferring the class
 * spelling (`Cls.m`) and the `instance` form the instance spelling (`Cls#m`).
 */
import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../src/core/contracts/types/codegraph.js";
import { PythonAncestorLinearizerCache } from "../../../../../../src/core/domains/language/python/resolver/python-ancestor-policy.js";
import { PythonImportFileMapper } from "../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { createPythonTypeMemberLookup } from "../../../../../../src/core/domains/language/python/resolver/python-type-member-lookup.js";
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
 * `class A: def foo(self)` and `class B(A): @classmethod def make(cls)`; `C`
 * declares both spellings of `both` — the case where the form decides.
 */
const ctx = (): CallContext => ({
  callerFile: "pkg/caller.py",
  callerScope: [],
  imports: [],
  symbolTable: tableWith({
    "pkg/models.py": [
      { symbolId: "A" },
      { symbolId: "A#foo", scope: ["A"] },
      { symbolId: "B" },
      { symbolId: "B.make", scope: ["B"] },
      { symbolId: "C" },
      { symbolId: "C#both", scope: ["C"] },
      { symbolId: "C.both", scope: ["C"] },
    ],
  }),
  classAncestors: { "pkg/models.py::B": ["A"] },
  classExtends: { B: "A" },
});

function lookupWithMro() {
  const mapper = new PythonImportFileMapper();
  return createPythonTypeMemberLookup(mapper, "strict", new PythonAncestorLinearizerCache(mapper, "strict"));
}

describe("createPythonTypeMemberLookup", () => {
  it("resolves an instance member inherited from the base class", () => {
    expect(lookupWithMro().findMember({ form: "instance", name: "B" }, "foo", ctx())).toEqual({
      targetRelPath: "pkg/models.py",
      targetSymbolId: "A#foo",
    });
  });

  it("resolves a classmethod on the class form", () => {
    expect(lookupWithMro().findMember({ form: "class", name: "B" }, "make", ctx())).toEqual({
      targetRelPath: "pkg/models.py",
      targetSymbolId: "B.make",
    });
  });

  it("prefers the class spelling for the class form and the instance spelling for the instance form", () => {
    const lookup = lookupWithMro();
    expect(lookup.findMember({ form: "class", name: "C" }, "both", ctx())?.targetSymbolId).toBe("C.both");
    expect(lookup.findMember({ form: "instance", name: "C" }, "both", ctx())?.targetSymbolId).toBe("C#both");
  });

  it("falls back to the classExtends walk when the run has no ancestor linearizer", () => {
    const lookup = createPythonTypeMemberLookup(new PythonImportFileMapper(), "strict");
    expect(lookup.findMember({ form: "instance", name: "B" }, "foo", ctx())).toEqual({
      targetRelPath: "pkg/models.py",
      targetSymbolId: "A#foo",
    });
  });

  it("answers null for a nil receiver", () => {
    expect(lookupWithMro().findMember({ form: "nil" }, "foo", ctx())).toBeNull();
  });
});
