/**
 * `PythonImportedNameSymbolResolutionStrategy` (E2 seam 1, bd tea-rags-mcp-9fgdi).
 *
 * `from .models import Device` then `Device.objects` used to reach `importMatch`,
 * which matches the receiver against the import's LAST SEGMENT — `models` — and
 * so never sees `Device` at all. This pass reads the binding the walker recorded
 * and resolves through the file it names, including one re-export hop, which is
 * how `from flask import Flask` reaches `src/flask/app.py` rather than stopping
 * at the package `__init__.py`.
 *
 * Fixture note: `PythonImportFileMapper` asks the symbol table for membership,
 * and `InMemoryGlobalSymbolTable.upsertFile` drops a file that contributes no
 * definition. A package whose `__init__.py` is EMPTY is therefore invisible and
 * maps to `unknown` by design (mapper docblock, plan decision 4), so every
 * package fixture below gives its `__init__.py` a symbol of its own — otherwise
 * the assertion would pass for the wrong reason.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, CallRef, ImportRef } from "../../../../../../../src/core/contracts/types/codegraph.js";
import { PythonImportFileMapper } from "../../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { PythonImportedNameSymbolResolutionStrategy } from "../../../../../../../src/core/domains/language/python/resolver/strategies/python-imported-name.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function tableWith(files: Record<string, string[]>): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, symbolIds] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      symbolIds.map((symbolId) => ({
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

function ctxWith(callerFile: string, imports: ImportRef[], table: InMemoryGlobalSymbolTable): CallContext {
  return { callerFile, callerScope: [], imports, symbolTable: table };
}

function strategy(): PythonImportedNameSymbolResolutionStrategy {
  return new PythonImportedNameSymbolResolutionStrategy({ mode: "strict" }, new PythonImportFileMapper());
}

const call = (receiver: string | null, member: string): CallRef => ({
  callText: `${receiver ?? ""}.${member}()`,
  receiver,
  member,
  startLine: 10,
});

describe("PythonImportedNameSymbolResolutionStrategy — receiver is an imported binding", () => {
  it("pins the symbol declared in the imported file", () => {
    const table = tableWith({
      "dcim/views.py": ["DeviceListView"],
      "dcim/models/__init__.py": ["Device", "Device.objects"],
    });
    const ctx = ctxWith(
      "dcim/views.py",
      [{ importText: ".models", startLine: 1, importedNames: ["Device"], importedBindings: { Device: "Device" } }],
      table,
    );
    expect(strategy().attempt(call("Device", "objects"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "dcim/models/__init__.py", targetSymbolId: "Device.objects" },
    });
  });

  it("follows an alias to the EXPORTED name, not the local one", () => {
    const table = tableWith({ "app/views.py": ["v"], "app/models.py": ["Rack", "Rack.objects"] });
    const ctx = ctxWith(
      "app/views.py",
      [{ importText: ".models", startLine: 1, importedNames: ["R"], importedBindings: { R: "Rack" } }],
      table,
    );
    expect(strategy().attempt(call("R", "objects"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/models.py", targetSymbolId: "Rack.objects" },
    });
  });

  it("hops through a package __init__.py that re-exports the name", () => {
    // flask: `from flask import Flask`; the class lives in src/flask/app.py.
    const table = tableWith({
      "src/flask/__init__.py": ["__getattr__"],
      "src/flask/app.py": ["Flask", "Flask#run"],
      "src/app/main.py": ["main"],
    });
    const ctx = ctxWith(
      "src/app/main.py",
      [{ importText: "flask", startLine: 1, importedNames: ["Flask"], importedBindings: { Flask: "Flask" } }],
      table,
    );
    expect(strategy().attempt(call("Flask", "run"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/flask/app.py", targetSymbolId: "Flask#run" },
    });
  });

  it("declines the hop when the package declares the name in two of its own files", () => {
    // Both candidates sit INSIDE the barrel's package, so the ex28m
    // within-package narrowing cannot separate them either — decline.
    const table = tableWith({
      "ui/__init__.py": ["ui_version"],
      "ui/button.py": ["Button", "Button#click"],
      "ui/legacy/button.py": ["Button", "Button#click"],
      "app/main.py": ["main"],
    });
    const ctx = ctxWith(
      "app/main.py",
      [{ importText: "ui", startLine: 1, importedNames: ["Button"], importedBindings: { Button: "Button" } }],
      table,
    );
    expect(strategy().attempt(call("Button", "click"), ctx)).toEqual({ kind: "continue" });
  });
});

describe("PythonImportedNameSymbolResolutionStrategy — bare calls", () => {
  it("resolves a bare call whose member is an imported binding", () => {
    const table = tableWith({ "app/main.py": ["main"], "app/util.py": ["make_thing"] });
    const ctx = ctxWith(
      "app/main.py",
      [
        {
          importText: ".util",
          startLine: 1,
          importedNames: ["make_thing"],
          importedBindings: { make_thing: "make_thing" },
        },
      ],
      table,
    );
    expect(strategy().attempt(call(null, "make_thing"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/util.py", targetSymbolId: "make_thing" },
    });
  });

  it("DROPS a bare call bound to an external module", () => {
    // `from json import loads` then `loads(x)`: the callee is the stdlib. Falling
    // through would let globalShortName attach it to a project `loads`.
    const table = tableWith({ "app/main.py": ["main"], "app/serial.py": ["loads"] });
    const ctx = ctxWith(
      "app/main.py",
      [{ importText: "json", startLine: 1, importedNames: ["loads"], importedBindings: { loads: "loads" } }],
      table,
    );
    expect(strategy().attempt(call(null, "loads"), ctx)).toEqual({ kind: "drop" });
  });

  it("DROPS a qualified call whose receiver is bound to an external module", () => {
    const table = tableWith({ "app/main.py": ["main"], "app/np.py": ["linalg"] });
    const ctx = ctxWith(
      "app/main.py",
      [{ importText: "numpy", startLine: 1, importedNames: ["np"], importedBindings: { np: "numpy" } }],
      table,
    );
    expect(strategy().attempt(call("np", "array"), ctx)).toEqual({ kind: "drop" });
  });

  it("keys a DOTTED receiver on its root segment", () => {
    const table = tableWith({ "app/main.py": ["main"] });
    const ctx = ctxWith(
      "app/main.py",
      [{ importText: "numpy", startLine: 1, importedNames: ["np"], importedBindings: { np: "numpy" } }],
      table,
    );
    expect(strategy().attempt(call("np.linalg", "norm"), ctx)).toEqual({ kind: "drop" });
  });
});

describe("PythonImportedNameSymbolResolutionStrategy — star imports", () => {
  it("resolves a unique declaration in the starred file", () => {
    const table = tableWith({ "app/main.py": ["main"], "app/models.py": ["Device", "helper"] });
    const ctx = ctxWith("app/main.py", [{ importText: ".models", startLine: 1, importedNames: ["*"] }], table);
    expect(strategy().attempt(call(null, "helper"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/models.py", targetSymbolId: "helper" },
    });
  });

  it("resolves through the starred PACKAGE directory", () => {
    // netbox: `from .models import *` where models is a package whose members
    // declare the name. 178 star lines, __all__ in 433 modules.
    const table = tableWith({
      "dcim/views.py": ["v"],
      "dcim/models/__init__.py": ["get_model"],
      "dcim/models/devices.py": ["Device"],
    });
    const ctx = ctxWith("dcim/views.py", [{ importText: ".models", startLine: 1, importedNames: ["*"] }], table);
    expect(strategy().attempt(call(null, "Device"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "dcim/models/devices.py", targetSymbolId: "Device" },
    });
  });

  it("CONTINUES when the starred package declares the name twice", () => {
    const table = tableWith({
      "dcim/views.py": ["v"],
      "dcim/models/__init__.py": ["get_model"],
      "dcim/models/devices.py": ["Device"],
      "dcim/models/racks.py": ["Device"],
    });
    const ctx = ctxWith("dcim/views.py", [{ importText: ".models", startLine: 1, importedNames: ["*"] }], table);
    expect(strategy().attempt(call(null, "Device"), ctx)).toEqual({ kind: "continue" });
  });

  it("CONTINUES when the starred file declares nothing by that name", () => {
    const table = tableWith({ "app/main.py": ["main"], "app/models.py": ["Device"] });
    const ctx = ctxWith("app/main.py", [{ importText: ".models", startLine: 1, importedNames: ["*"] }], table);
    expect(strategy().attempt(call(null, "unrelated"), ctx)).toEqual({ kind: "continue" });
  });

  it("CONTINUES on a QUALIFIED call — a star import binds names, not a namespace", () => {
    const table = tableWith({ "app/main.py": ["main"], "app/models.py": ["Device", "Device#save"] });
    const ctx = ctxWith("app/main.py", [{ importText: ".models", startLine: 1, importedNames: ["*"] }], table);
    expect(strategy().attempt(call("models", "save"), ctx)).toEqual({ kind: "continue" });
  });
});

describe("PythonImportedNameSymbolResolutionStrategy — declines", () => {
  it("CONTINUES when no import binds the name", () => {
    const table = tableWith({ "app/main.py": ["main"], "app/util.py": ["make_thing"] });
    const ctx = ctxWith("app/main.py", [{ importText: ".util", startLine: 1, importedNames: ["other"] }], table);
    expect(strategy().attempt(call(null, "make_thing"), ctx)).toEqual({ kind: "continue" });
  });

  it("CONTINUES on a walker-1 ImportRef with no binding channels", () => {
    // An incremental run can hold files walked by walker 1. Missing channels
    // must degrade to the pre-seam chain, never to a drop.
    const table = tableWith({ "app/main.py": ["main"], "app/util.py": ["make_thing"] });
    const ctx = ctxWith("app/main.py", [{ importText: ".util", startLine: 1 }], table);
    expect(strategy().attempt(call(null, "make_thing"), ctx)).toEqual({ kind: "continue" });
  });

  it("CONTINUES when the mapping is unknown (namespace package)", () => {
    const table = tableWith({ "app/main.py": ["main"], "domains/orders/handlers.py": ["place"] });
    const ctx = ctxWith(
      "app/main.py",
      [{ importText: "domains", startLine: 1, importedNames: ["orders"], importedBindings: { orders: "orders" } }],
      table,
    );
    expect(strategy().attempt(call("orders", "place"), ctx)).toEqual({ kind: "continue" });
  });

  it("CONTINUES when the target file declares nothing and no unique origin exists", () => {
    const table = tableWith({ "app/main.py": ["main"], "app/other.py": ["something_else"] });
    const ctx = ctxWith(
      "app/main.py",
      [{ importText: ".other", startLine: 1, importedNames: ["Thing"], importedBindings: { Thing: "Thing" } }],
      table,
    );
    expect(strategy().attempt(call("Thing", "go"), ctx)).toEqual({ kind: "continue" });
  });

  it("CONTINUES when the declaring file holds no member of that name", () => {
    const table = tableWith({ "app/main.py": ["main"], "app/models.py": ["Rack", "Rack.objects"] });
    const ctx = ctxWith(
      "app/main.py",
      [{ importText: ".models", startLine: 1, importedNames: ["Rack"], importedBindings: { Rack: "Rack" } }],
      table,
    );
    expect(strategy().attempt(call("Rack", "missing"), ctx)).toEqual({ kind: "continue" });
  });
});
