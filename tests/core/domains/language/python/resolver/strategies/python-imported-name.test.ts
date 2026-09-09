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

  it("CONTINUEs on a DOTTED receiver instead of keying on its root segment", () => {
    // Was `{ kind: "drop" }`: the pass keyed `np.linalg.norm` on `np` and threw
    // `.linalg` away. Decision 4 of bd tea-rags-mcp-9fgdi retires that split —
    // a receiver with a further hop is a FOLD, and folding belongs to
    // `chainType`, not to a pass that reads one import statement. Keeping the
    // fixture proves the single-hop guard runs FIRST, ahead of even the
    // external DROP.
    const table = tableWith({ "app/main.py": ["main"] });
    const ctx = ctxWith(
      "app/main.py",
      [{ importText: "numpy", startLine: 1, importedNames: ["np"], importedBindings: { np: "numpy" } }],
      table,
    );
    expect(strategy().attempt(call("np.linalg", "norm"), ctx)).toEqual({ kind: "continue" });
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

/**
 * The src-layout bare call the E0.4 oracle diff lost (bd tea-rags-mcp-60nss).
 *
 * `examples/app.py` is outside `src/`, so the mapper's ancestor scan could not
 * prove the root and answered `external` — which this pass turns into a DROP,
 * so `globalShortName` never got the call. With roots seeded from the file set
 * the import maps, and the re-export hop lands on the declaring module.
 */
describe("PythonImportedNameSymbolResolutionStrategy — src layout outside the source root", () => {
  it("resolves a bare call whose package lives under a root the caller does not share", () => {
    const table = tableWith({
      "src/flask/__init__.py": ["__getattr__"],
      "src/flask/app.py": ["Flask"],
      "examples/app.py": ["main"],
    });
    const ctx = ctxWith(
      "examples/app.py",
      [{ importText: "flask", startLine: 1, importedNames: ["Flask"], importedBindings: { Flask: "Flask" } }],
      table,
    );
    expect(strategy().attempt(call(null, "Flask"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/flask/app.py", targetSymbolId: "Flask" },
    });
  });
});

describe("PythonImportedNameSymbolResolutionStrategy — receiver is a module", () => {
  it("pins a top-level class in the submodule a `from pkg import mod` binding names", () => {
    const table = tableWith({
      "netbox/circuits/tables/circuits.py": ["CircuitTable"],
      "netbox/circuits/tables/columns.py": ["LocalColumn"],
      "netbox/netbox/__init__.py": ["VERSION"],
      "netbox/netbox/tables/__init__.py": ["BaseTable"],
      "netbox/netbox/tables/columns.py": ["ColorColumn", "TagColumn"],
    });
    const ctx = ctxWith(
      "netbox/circuits/tables/circuits.py",
      [
        {
          importText: "netbox.tables",
          startLine: 3,
          importedNames: ["columns"],
          importedBindings: { columns: "columns" },
        },
      ],
      table,
    );
    // The caller's own sibling `circuits/tables/columns.py` is what
    // `importMatch`'s trailing-segment heuristic picks. The binding says
    // otherwise, 435 times on netbox (bd tea-rags-mcp-9fgdi).
    expect(strategy().attempt(call("columns", "ColorColumn"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "netbox/netbox/tables/columns.py", targetSymbolId: "ColorColumn" },
    });
  });

  it("binds the TOP package for an unaliased dotted `import a.b`", () => {
    const table = tableWith({
      "app/main.py": ["main"],
      "pkg/__init__.py": ["setup"],
      "pkg/sub.py": ["helper"],
    });
    const ctx = ctxWith(
      "app/main.py",
      [{ importText: "pkg.sub", startLine: 1, importedNames: ["pkg"], importedBindings: { pkg: "pkg.sub" } }],
      table,
    );
    expect(strategy().attempt(call("pkg", "setup"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "pkg/__init__.py", targetSymbolId: "setup" },
    });
  });

  it("binds the FULL module path for an aliased `import a.b as c`", () => {
    const table = tableWith({
      "app/main.py": ["main"],
      "pkg/__init__.py": ["setup"],
      "pkg/sub.py": ["helper"],
    });
    const ctx = ctxWith(
      "app/main.py",
      [{ importText: "pkg.sub", startLine: 1, importedNames: ["ps"], importedBindings: { ps: "pkg.sub" } }],
      table,
    );
    expect(strategy().attempt(call("ps", "helper"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "pkg/sub.py", targetSymbolId: "helper" },
    });
  });

  it("composes a relative `from . import mod` without doubling the dot", () => {
    const table = tableWith({ "pkg/__init__.py": ["setup"], "pkg/main.py": ["run"], "pkg/sub.py": ["helper"] });
    const ctx = ctxWith(
      "pkg/main.py",
      [{ importText: ".", startLine: 1, importedNames: ["sub"], importedBindings: { sub: "sub" } }],
      table,
    );
    expect(strategy().attempt(call("sub", "helper"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "pkg/sub.py", targetSymbolId: "helper" },
    });
  });

  it("reaches the submodule when the PARENT package is a namespace directory", () => {
    const table = tableWith({
      "netbox/circuits/apps.py": ["CircuitsConfig"],
      "netbox/netbox/__init__.py": ["VERSION"],
      "netbox/netbox/denormalized.py": ["register"],
    });
    const ctx = ctxWith(
      "netbox/circuits/apps.py",
      [
        {
          importText: "netbox",
          startLine: 2,
          importedNames: ["denormalized"],
          importedBindings: { denormalized: "denormalized" },
        },
      ],
      table,
    );
    // `netbox` itself has no `__init__.py`, so the mapper calls the PARENT
    // `unknown`; only the composed `netbox.denormalized` names a file.
    expect(strategy().attempt(call("denormalized", "register"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "netbox/netbox/denormalized.py", targetSymbolId: "register" },
    });
  });

  it("CONTINUEs on a multi-hop receiver instead of dropping the middle segment", () => {
    const table = tableWith({
      "server/polar/event/repository.py": ["EventRepository"],
      "server/polar/models/__init__.py": ["Base"],
      "server/polar/models/event.py": ["Event", "Event#label"],
    });
    const ctx = ctxWith(
      "server/polar/event/repository.py",
      [{ importText: "polar.models", startLine: 1, importedNames: ["Event"], importedBindings: { Event: "Event" } }],
      table,
    );
    // `Event.id.label(...)` is SQLAlchemy's; the old head-only split threw `.id`
    // away and fabricated `Event#label` (bd tea-rags-mcp-9fgdi).
    expect(strategy().attempt(call("Event.id", "label"), ctx)).toEqual({ kind: "continue" });
  });

  it("DROPs a stdlib module receiver even when a project file shares its name", () => {
    const table = tableWith({
      "netbox/netbox/__init__.py": ["VERSION"],
      "netbox/utilities/forms/fields/fields.py": ["JSONField"],
      "netbox/utilities/json.py": ["CustomFieldJSONEncoder"],
    });
    const ctx = ctxWith(
      "netbox/utilities/forms/fields/fields.py",
      [{ importText: "json", startLine: 1, importedNames: ["json"], importedBindings: { json: "json" } }],
      table,
    );
    // The mapper probes the caller's ancestors first and answers
    // `netbox/utilities/json.py` — 45 phantoms on netbox. Absolute `import json`
    // is the stdlib, whatever the project happens to be named.
    expect(strategy().attempt(call("json", "loads"), ctx)).toEqual({ kind: "drop" });
  });

  it("CONTINUEs when the module declares the member twice", () => {
    const table = tableWith({
      "app/main.py": ["main"],
      "pkg/__init__.py": ["setup"],
      "pkg/sub.py": ["helper", "helper"],
    });
    const ctx = ctxWith(
      "app/main.py",
      [{ importText: "pkg", startLine: 1, importedNames: ["sub"], importedBindings: { sub: "sub" } }],
      table,
    );
    expect(strategy().attempt(call("sub", "helper"), ctx)).toEqual({ kind: "continue" });
  });

  it("CONTINUEs when the composed module text names no file", () => {
    const table = tableWith({
      "domains/identity/models.py": ["User"],
      "domains/identity/services.py": ["login"],
    });
    const ctx = ctxWith(
      "domains/identity/services.py",
      [
        {
          importText: "domains",
          startLine: 1,
          importedNames: ["identity"],
          importedBindings: { identity: "identity" },
        },
      ],
      table,
    );
    expect(strategy().attempt(call("identity", "User"), ctx)).toEqual({ kind: "continue" });
  });

  it("DROPs a receiver bound from a third-party module", () => {
    const table = tableWith({ "app/models.py": ["Thing"], "app/__init__.py": ["VERSION"] });
    const ctx = ctxWith(
      "app/models.py",
      [{ importText: "django.db", startLine: 1, importedNames: ["models"], importedBindings: { models: "models" } }],
      table,
    );
    expect(strategy().attempt(call("models", "CharField"), ctx)).toEqual({ kind: "drop" });
  });

  it("follows one re-export hop out of a package __init__ to the declaring module", () => {
    const table = tableWith({
      "netbox/circuits/tables/circuits.py": ["CircuitTable"],
      "netbox/netbox/__init__.py": ["VERSION"],
      "netbox/netbox/tables/__init__.py": ["BaseTable"],
      "netbox/netbox/tables/columns.py": ["ColorColumn"],
    });
    const ctx = ctxWith(
      "netbox/circuits/tables/circuits.py",
      [{ importText: "netbox", startLine: 1, importedNames: ["tables"], importedBindings: { tables: "tables" } }],
      table,
    );
    expect(strategy().attempt(call("tables", "ColorColumn"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "netbox/netbox/tables/columns.py", targetSymbolId: "ColorColumn" },
    });
  });

  it("declines the hop when the module's own package declares the name twice", () => {
    const table = tableWith({
      "netbox/circuits/tables/circuits.py": ["CircuitTable"],
      "netbox/netbox/__init__.py": ["VERSION"],
      "netbox/netbox/tables/__init__.py": ["BaseTable"],
      "netbox/netbox/tables/columns.py": ["ColorColumn"],
      "netbox/netbox/tables/template_code.py": ["ColorColumn"],
    });
    const ctx = ctxWith(
      "netbox/circuits/tables/circuits.py",
      [{ importText: "netbox", startLine: 1, importedNames: ["tables"], importedBindings: { tables: "tables" } }],
      table,
    );
    // Both declarations sit INSIDE the mapped package, so the ex28m
    // within-package retry cannot separate them either. The existing edge beats
    // a coin flip (bd tea-rags-mcp-ex28m). A homonym in a SIBLING package would
    // not reach here — the retry filters it out and the hop resolves.
    expect(strategy().attempt(call("tables", "ColorColumn"), ctx)).toEqual({ kind: "continue" });
  });
});

describe("PythonImportedNameSymbolResolutionStrategy — class receiver spellings", () => {
  const jobsTable = () =>
    tableWith({
      "netbox/core/signals.py": ["handle_sync"],
      "netbox/core/jobs.py": ["SyncDataSourceJob"],
      "netbox/netbox/__init__.py": ["VERSION"],
      "netbox/netbox/jobs.py": ["JobRunner", "JobRunner.enqueue", "JobRunner#run", "JobRunner#get_jobs"],
    });
  const jobsCtx = (table: ReturnType<typeof jobsTable>, module: string, bound: string) =>
    ctxWith(
      "netbox/core/signals.py",
      [{ importText: module, startLine: 1, importedNames: [bound], importedBindings: { [bound]: bound } }],
      table,
    );

  it("prefers the classmethod / staticmethod spelling `Cls.member`", () => {
    const table = jobsTable();
    expect(strategy().attempt(call("JobRunner", "enqueue"), jobsCtx(table, "netbox.jobs", "JobRunner"))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "netbox/netbox/jobs.py", targetSymbolId: "JobRunner.enqueue" },
    });
  });

  it("falls to the instance spelling `Cls#member`", () => {
    const table = jobsTable();
    expect(strategy().attempt(call("JobRunner", "run"), jobsCtx(table, "netbox.jobs", "JobRunner"))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "netbox/netbox/jobs.py", targetSymbolId: "JobRunner#run" },
    });
  });

  it("CONTINUEs when the member is INHERITED, leaving MRO to its own seam", () => {
    const table = jobsTable();
    // netbox's only two `missed` rows with a `constant` receiver:
    // `SyncDataSourceJob.get_jobs()` where jedi answers `JobRunner.get_jobs`.
    expect(
      strategy().attempt(call("SyncDataSourceJob", "get_jobs"), jobsCtx(table, ".jobs", "SyncDataSourceJob")),
    ).toEqual({ kind: "continue" });
  });
});
