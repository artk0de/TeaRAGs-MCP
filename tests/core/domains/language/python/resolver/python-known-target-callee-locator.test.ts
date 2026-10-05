/**
 * Where a Python constructor call really runs, asked at the barrier (bd
 * tea-rags-mcp-m99j1.1.42).
 *
 * The walker spells a constructor call's candidates from ONE file, so it names
 * `django/http/__init__.py::HttpResponse#__init__` for
 * `from django.http import HttpResponse` — a package that declares nothing and
 * re-exports the class — and `views.py::Child#__init__` for a class whose
 * constructor is inherited. The locator re-addresses both: the re-export is
 * followed exactly as the import mapper follows it for a type (aliases by their
 * source spelling, stars only when unanimous), and the constructor is the FIRST
 * class in the instance class's closed MRO that declares one — an external or
 * unreadable branch could own the real `__init__`, so it refuses there.
 */
import { describe, expect, it } from "vitest";

import type { ModuleReexport } from "../../../../../../src/core/contracts/types/codegraph.js";
import type { KnownTargetCalleeLocatorInput } from "../../../../../../src/core/contracts/types/language.js";
import { PythonLanguage } from "../../../../../../src/core/domains/language/python/index.js";
import { createPythonKnownTargetCalleeLocator } from "../../../../../../src/core/domains/language/python/resolver/python-known-target-callee-locator.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function tableWith(files: Record<string, readonly string[]>): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, symbolIds] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      symbolIds.map((symbolId) => ({
        symbolId,
        fqName: symbolId,
        shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
        relPath,
        scope: symbolId.includes("#") ? [symbolId.split("#")[0]] : [],
      })),
    );
  }
  return table;
}

const TABLE = (): InMemoryGlobalSymbolTable =>
  tableWith({
    "pkg/__init__.py": [],
    "pkg/response.py": ["Response", "Response#__init__"],
    "pkg/other.py": ["Response", "Response#__init__"],
    "pkg/base.py": ["View", "View#__init__", "Mid", "Mid#__init__"],
    "pkg/c.py": ["Child", "Grandchild", "Plain", "Mixed", "Own", "Own#__init__"],
    "pkg/cyc.py": ["A", "B"],
  });

const ANCESTORS: Record<string, readonly string[]> = {
  "pkg/c.py::Child": ["pkg.base::View"],
  "pkg/c.py::Grandchild": ["pkg.base::Mid"],
  "pkg/base.py::Mid": ["View"],
  "pkg/c.py::Mixed": ["thirdparty.mixins::Mixin", "pkg.base::View"],
  "pkg/cyc.py::A": ["B"],
  "pkg/cyc.py::B": ["A"],
};

function locatorWith(moduleReexports: Record<string, readonly ModuleReexport[]> = {}) {
  const input: KnownTargetCalleeLocatorInput = {
    symbolTable: TABLE(),
    moduleReexports,
    classAncestors: ANCESTORS,
  };
  return createPythonKnownTargetCalleeLocator(input);
}

describe("a re-exported class", () => {
  it("follows an explicit re-export to the declaring file's class", () => {
    const locate = locatorWith({
      "pkg/__init__.py": [{ exportedName: "Response", sourceModule: ".response", sourceName: "Response" }],
    });

    expect(locate("pkg/__init__.py::Response#__init__")).toEqual({
      definingClassKey: "pkg/response.py::Response",
      instanceClassKey: "pkg/response.py::Response",
    });
  });

  it("lands an `as` alias on the name the declaring file bound", () => {
    const locate = locatorWith({
      "pkg/__init__.py": [{ exportedName: "Resp", sourceModule: ".response", sourceName: "Response" }],
    });

    expect(locate("pkg/__init__.py::Resp#__init__")?.instanceClassKey).toBe("pkg/response.py::Response");
  });

  it("refuses when two star sources both declare the name", () => {
    const locate = locatorWith({
      "pkg/__init__.py": [
        { exportedName: "*", sourceModule: ".response" },
        { exportedName: "*", sourceModule: ".other" },
      ],
    });

    expect(locate("pkg/__init__.py::Response#__init__")).toBeNull();
  });

  it("refuses a name nothing re-exports", () => {
    expect(locatorWith()("pkg/__init__.py::Response#__init__")).toBeNull();
  });

  it("re-addresses a re-exported class whose constructor is inherited", () => {
    const locate = locatorWith({
      "pkg/__init__.py": [{ exportedName: "Child", sourceModule: ".c", sourceName: "Child" }],
    });

    expect(locate("pkg/__init__.py::Child#__init__")).toEqual({
      definingClassKey: "pkg/base.py::View",
      instanceClassKey: "pkg/c.py::Child",
    });
  });
});

describe("an inherited constructor", () => {
  it("names the ancestor that declares it", () => {
    expect(locatorWith()("pkg/c.py::Child#__init__")).toEqual({
      definingClassKey: "pkg/base.py::View",
      instanceClassKey: "pkg/c.py::Child",
    });
  });

  it("stops at the NEAREST ancestor declaring one", () => {
    expect(locatorWith()("pkg/c.py::Grandchild#__init__")?.definingClassKey).toBe("pkg/base.py::Mid");
  });

  it("names the class itself when it declares its own", () => {
    expect(locatorWith()("pkg/c.py::Own#__init__")).toEqual({
      definingClassKey: "pkg/c.py::Own",
      instanceClassKey: "pkg/c.py::Own",
    });
  });

  it("refuses when a base outside the project could own the constructor", () => {
    expect(locatorWith()("pkg/c.py::Mixed#__init__")).toBeNull();
  });

  it("refuses when no class in the hierarchy declares one", () => {
    expect(locatorWith()("pkg/c.py::Plain#__init__")).toBeNull();
  });

  it("terminates on an ancestor cycle and refuses", () => {
    expect(locatorWith()("pkg/cyc.py::A#__init__")).toBeNull();
  });

  it("refuses a coordinate that is not a Python class key", () => {
    expect(locatorWith()("Service#initialize")).toBeNull();
  });
});

describe("the Python language provider", () => {
  it("offers the locator to the barrier", () => {
    const locate = new PythonLanguage().knownTargetCalleeLocator?.({
      symbolTable: TABLE(),
      moduleReexports: {},
      classAncestors: ANCESTORS,
    });

    expect(locate?.("pkg/c.py::Child#__init__")?.definingClassKey).toBe("pkg/base.py::View");
  });
});
