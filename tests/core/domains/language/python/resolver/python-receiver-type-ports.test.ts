/**
 * `singleHopType` and the import shadow it has to see through (R4c bd
 * tea-rags-mcp-jeqyg, widened by bd tea-rags-mcp-w205u / E4.6a).
 *
 * netbox writes `layout = layout.Layout(\n    layout.Row(\n …))` as a class-body
 * attribute in eleven view files. Python evaluates the right-hand side before it
 * rebinds the name, so throughout that statement `layout` denotes the MODULE
 * `from netbox.ui import layout` bound. jeqyg saw the first line of it — the
 * rule was `bound.line === atLine` — and the inner receivers on lines 205, 206,
 * 212 were typed as the class being constructed, which sent `chainType` looking
 * for `Row` on `Layout`, finding nothing and cutting off the module arm of
 * `importedName` that answers the site. 50 rows.
 *
 * The extent is `LocalBinding.endLine`. Absent, the rule degenerates to the
 * same-line test it replaces, so an index written by an earlier walker behaves
 * exactly as before.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, ImportRef, LocalBinding } from "../../../../../../src/core/contracts/types/codegraph.js";
import { PythonImportFileMapper } from "../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { createPythonReceiverTypePorts } from "../../../../../../src/core/domains/language/python/resolver/python-receiver-type-ports.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const LAYOUT_IMPORT: ImportRef = {
  importText: "netbox.ui",
  startLine: 42,
  importedNames: ["layout"],
  importedBindings: { layout: "layout" },
};

function table(): InMemoryGlobalSymbolTable {
  const built = new InMemoryGlobalSymbolTable();
  for (const [relPath, symbolIds] of Object.entries({
    "netbox/core/views.py": ["DataFileView"],
    "netbox/netbox/__init__.py": ["VERSION"],
    "netbox/netbox/ui/__init__.py": [],
    "netbox/netbox/ui/layout.py": ["Layout", "Row", "Column"],
  })) {
    built.upsertFile(
      relPath,
      symbolIds.map((symbolId) => ({ symbolId, fqName: symbolId, shortName: symbolId, relPath, scope: [] })),
    );
  }
  return built;
}

function ctxWith(bindings: Record<string, LocalBinding[]>, imports: ImportRef[] = [LAYOUT_IMPORT]): CallContext {
  return {
    callerFile: "netbox/core/views.py",
    callerScope: ["DataFileView"],
    imports,
    symbolTable: table(),
    localBindings: bindings,
  };
}

const ports = () => createPythonReceiverTypePorts(new PythonImportFileMapper());

describe("pythonSingleHopType — a local that shadows an import it is built from", () => {
  const netboxSpan = { layout: [{ line: 204, endLine: 220, type: "Layout" }] };

  it("leaves the import in force on the statement's OWN line", () => {
    expect(ports().singleHopType("layout", 204, ctxWith(netboxSpan))).toBeUndefined();
  });

  it("leaves the import in force on every LATER line of the same statement", () => {
    for (const line of [205, 206, 212, 220]) {
      expect(ports().singleHopType("layout", line, ctxWith(netboxSpan))).toBeUndefined();
    }
  });

  it("hands over to the local on the first line AFTER the statement", () => {
    expect(ports().singleHopType("layout", 221, ctxWith(netboxSpan))).toEqual({ form: "instance", name: "Layout" });
  });

  it("answers nothing above the binding, where no local exists yet", () => {
    expect(ports().singleHopType("layout", 203, ctxWith(netboxSpan))).toBeUndefined();
  });

  it("keeps an EARLIER binding of the same name rather than the one being established", () => {
    // The retry asks for the line before the binding STARTS, not the line
    // before the call — at 210 against a binding at 204, `atLine - 1` would
    // find the very binding it is demoting.
    const ctx = ctxWith({
      layout: [
        { line: 90, endLine: 90, type: "SimpleLayout" },
        { line: 204, endLine: 220, type: "Layout" },
      ],
    });
    expect(ports().singleHopType("layout", 210, ctx)).toEqual({ form: "instance", name: "SimpleLayout" });
  });

  it("degenerates to the same-line rule when the binding carries no span", () => {
    // A walker-1 index. 204 demotes (jeqyg's rule); 205 does not.
    const legacy = { layout: [{ line: 204, type: "Layout" }] };
    expect(ports().singleHopType("layout", 204, ctxWith(legacy))).toBeUndefined();
    expect(ports().singleHopType("layout", 205, ctxWith(legacy))).toEqual({ form: "instance", name: "Layout" });
  });

  it("does NOT demote a binding no import shadows", () => {
    // `x = Foo(\n)` then `x.run()` inside the span: nothing bound `x` above, so
    // there is no prior meaning to fall back to and the local stands.
    const ctx = ctxWith({ x: [{ line: 1, endLine: 3, type: "Foo" }] }, []);
    expect(ports().singleHopType("x", 2, ctx)).toEqual({ form: "instance", name: "Foo" });
    expect(ports().singleHopType("x", 4, ctx)).toEqual({ form: "instance", name: "Foo" });
  });
});

/**
 * Chain HEADS that are calls, constructors and casts (bd tea-rags-mcp-w205u,
 * E4.6b-1). The receiver text arrives whole, and before the bracket-aware split
 * its dots shredded it into segments that typed to nothing — 79 rows.
 */

const POLAR_FILES: Record<string, readonly string[]> = {
  "server/polar/backoffice/components/__init__.py": [],
  "server/polar/backoffice/components/_datatable.py": ["Datatable", "DatatableAttrColumn"],
  "server/polar/backoffice/benefits/endpoints.py": ["list_benefits"],
  "server/polar/models/notification.py": ["Notification"],
  "server/polar/integrations/client.py": ["get_client", "PolarSelfClient"],
  "server/polar/kit/repository/base.py": ["RepositoryBase"],
  "server/polar/account/repository.py": ["AccountRepository"],
};

function polarTable(extra: Record<string, readonly string[]> = {}): InMemoryGlobalSymbolTable {
  const built = new InMemoryGlobalSymbolTable();
  for (const [relPath, ids] of Object.entries({ ...POLAR_FILES, ...extra })) {
    built.upsertFile(
      relPath,
      ids.map((symbolId) => ({ symbolId, fqName: symbolId, shortName: symbolId, relPath, scope: [] })),
    );
  }
  return built;
}

const CALLER = "server/polar/backoffice/benefits/endpoints.py";

function polarCtx(over: Partial<CallContext> = {}): CallContext {
  return { callerFile: CALLER, callerScope: ["list_benefits"], imports: [], symbolTable: polarTable(), ...over };
}

/** `from ..components import datatable`, where the package aliases a SUBMODULE. */
const COMPONENTS_IMPORT: ImportRef = {
  importText: "..components",
  startLine: 3,
  importedNames: ["datatable"],
  importedBindings: { datatable: "datatable" },
};

/** `components/__init__.py:1` — `from . import _datatable as datatable`. */
const COMPONENTS_REEXPORTS = [{ exportedName: "datatable", sourceModule: ".", sourceName: "_datatable" }];

describe("pythonSingleHopType — a constructor call whose ARGUMENTS carry dots", () => {
  it("types the receiver as an instance of the class being constructed", () => {
    const ctx = polarCtx({ imports: [{ importText: "polar.models.notification", startLine: 1 }] });
    expect(ports().singleHopType("Notification(user=self.u, event=self.t())", 40, ctx)).toEqual({
      form: "instance",
      name: "Notification",
    });
  });

  it("declines a constructor the project does not declare", () => {
    expect(ports().singleHopType("BackgroundTasks(scope=self.s)", 40, polarCtx())).toBeUndefined();
  });
});

describe("pythonModuleAliasSeed — a generic subscript on the head's class", () => {
  it("strips the subscript and types the alias member through the package's module alias", () => {
    const ctx = polarCtx({
      imports: [COMPONENTS_IMPORT],
      moduleReexports: { "server/polar/backoffice/components/__init__.py": COMPONENTS_REEXPORTS },
    });
    expect(ports().seedHead("datatable", "Datatable[Benefit, S](items, sort)", ctx)).toEqual({
      type: { form: "instance", name: "Datatable" },
      consumedMembers: 1,
    });
  });

  it("keeps the CLASS form when the subscripted head is not called", () => {
    const ctx = polarCtx({
      imports: [COMPONENTS_IMPORT],
      moduleReexports: { "server/polar/backoffice/components/__init__.py": COMPONENTS_REEXPORTS },
    });
    expect(ports().seedHead("datatable", "Datatable[Benefit]", ctx)).toEqual({
      type: { form: "class", name: "Datatable" },
      consumedMembers: 1,
    });
  });

  it("declines when the aliased module does not declare the class", () => {
    const ctx = polarCtx({
      imports: [COMPONENTS_IMPORT],
      moduleReexports: { "server/polar/backoffice/components/__init__.py": COMPONENTS_REEXPORTS },
    });
    expect(ports().seedHead("datatable", "Paginator[Benefit](x)", ctx)).toBeUndefined();
  });

  it("declines when nothing imports the head at all", () => {
    expect(ports().seedHead("datatable", "Datatable[Benefit](x)", polarCtx())).toBeUndefined();
  });
});

describe("pythonCallHeadReturnType — a lowercase CALL as the chain head", () => {
  const clientImport: ImportRef = {
    importText: "polar.integrations.client",
    startLine: 2,
    importedNames: ["get_client"],
    importedBindings: { get_client: "get_client" },
  };

  // E5.1c keys a module-level return fact `<relPath>::<name>` (bd
  // tea-rags-mcp-1v12o.1.7); these fixtures pinned the bare name before it.
  const CLIENT_FILE = "server/polar/integrations/client.py";

  it("seeds the head from the callee's own recorded return type", () => {
    const ctx = polarCtx({
      imports: [clientImport],
      structuredReturnTypes: { [`${CLIENT_FILE}::get_client`]: { form: "instance", name: "PolarSelfClient" } },
    });
    expect(ports().singleHopType("get_client()", 30, ctx)).toEqual({ form: "instance", name: "PolarSelfClient" });
  });

  it("declines a callee with no recorded return", () => {
    expect(ports().singleHopType("get_client()", 30, polarCtx({ imports: [clientImport] }))).toBeUndefined();
  });

  it("answers a namesake callee once the caller's binding names the file", () => {
    // SUPERSEDED by E5.1c (bd tea-rags-mcp-1v12o.1.7). The run-global key WAS
    // the bare name, so a second definition let one file's `get_client` speak
    // for every other and the arm had to decline outright. The key names the
    // file now, and the caller's import names the same one, so the second
    // definition is no longer in the question at all.
    const ctx = polarCtx({
      imports: [clientImport],
      symbolTable: polarTable({ "server/polar/oauth/client.py": ["get_client"] }),
      structuredReturnTypes: { [`${CLIENT_FILE}::get_client`]: { form: "instance", name: "PolarSelfClient" } },
    });
    expect(ports().singleHopType("get_client()", 30, ctx)).toEqual({ form: "instance", name: "PolarSelfClient" });
  });

  it("declines the OTHER namesake's caller, whose file records no such fact", () => {
    const ctx = polarCtx({
      imports: [
        {
          importText: "polar.oauth.client",
          startLine: 2,
          importedNames: ["get_client"],
          importedBindings: { get_client: "get_client" },
        },
      ],
      symbolTable: polarTable({ "server/polar/oauth/client.py": ["get_client"] }),
      structuredReturnTypes: { [`${CLIENT_FILE}::get_client`]: { form: "instance", name: "PolarSelfClient" } },
    });
    expect(ports().singleHopType("get_client()", 30, ctx)).toBeUndefined();
  });

  it("declines a callee no import binds and the caller's own file does not declare", () => {
    const ctx = polarCtx({
      structuredReturnTypes: { [`${CLIENT_FILE}::get_client`]: { form: "instance", name: "PolarSelfClient" } },
    });
    expect(ports().singleHopType("get_client()", 30, ctx)).toBeUndefined();
  });

  it("answers for the caller's OWN module-level def without an import", () => {
    const ctx = polarCtx({
      symbolTable: polarTable({ [CALLER]: ["list_benefits", "build_client"] }),
      structuredReturnTypes: { [`${CALLER}::build_client`]: { form: "instance", name: "PolarSelfClient" } },
    });
    expect(ports().singleHopType("build_client()", 30, ctx)).toEqual({
      form: "instance",
      name: "PolarSelfClient",
    });
  });
});

describe("pythonCastHeadType — `typing.cast(T, x)` states the type outright", () => {
  const typingImport: ImportRef = { importText: "typing", startLine: 1 };
  const castImport: ImportRef = {
    importText: "typing",
    startLine: 1,
    importedNames: ["cast"],
    importedBindings: { cast: "cast" },
  };

  it("types a dotted `typing.cast` head as its first argument", () => {
    const ctx = polarCtx({ imports: [typingImport, { importText: "polar.models.notification", startLine: 2 }] });
    expect(ports().seedHead("typing", "cast(Notification, row.value)", ctx)).toEqual({
      type: { form: "instance", name: "Notification" },
      consumedMembers: 1,
    });
  });

  it("types a bare `cast` head imported from typing", () => {
    const ctx = polarCtx({ imports: [castImport, { importText: "polar.models.notification", startLine: 2 }] });
    expect(ports().singleHopType("cast(Notification, row.value)", 30, ctx)).toEqual({
      form: "instance",
      name: "Notification",
    });
  });

  it("declines when the cast target is not a project type", () => {
    const ctx = polarCtx({ imports: [castImport] });
    expect(ports().singleHopType("cast(HTTPResponse, row)", 30, ctx)).toBeUndefined();
  });

  it("declines a `cast` nothing bound to typing", () => {
    const ctx = polarCtx({ imports: [{ importText: "polar.models.notification", startLine: 2 }] });
    expect(ports().singleHopType("cast(Notification, row)", 30, ctx)).toBeUndefined();
  });
});

describe("pythonMemberTypeOf — `-> Self` is the RECEIVER's class", () => {
  // The MRO half — a `Self` recorded on an ANCESTOR — is pinned next to the
  // walk that finds it, in `strategies/python-shared-helper-edges.test.ts`.
  const selfReturn = (name: string) =>
    polarCtx({ structuredReturnTypes: { "AccountRepository.from_session": { form: "instance", name } } });

  it("substitutes the class the receiver names for the `Self` marker", () => {
    expect(
      ports().memberTypeOf({ form: "class", name: "AccountRepository" }, "from_session", selfReturn("Self")),
    ).toEqual({
      form: "instance",
      name: "AccountRepository",
    });
  });

  it("substitutes on an INSTANCE receiver too — `obj.with_x()` is still an obj", () => {
    const ctx = polarCtx({
      structuredReturnTypes: { "AccountRepository#with_org": { form: "instance", name: "Self" } },
    });
    expect(ports().memberTypeOf({ form: "instance", name: "AccountRepository" }, "with_org", ctx)).toEqual({
      form: "instance",
      name: "AccountRepository",
    });
  });

  it("leaves an explicitly named return type alone", () => {
    expect(
      ports().memberTypeOf({ form: "class", name: "AccountRepository" }, "from_session", selfReturn("RepositoryBase")),
    ).toEqual({ form: "instance", name: "RepositoryBase" });
  });
});
