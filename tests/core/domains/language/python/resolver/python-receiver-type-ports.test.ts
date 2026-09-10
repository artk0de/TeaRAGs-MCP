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
