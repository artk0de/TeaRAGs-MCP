/**
 * `PythonImportFileMapper` (E2 seam 1, bd tea-rags-mcp-9fgdi). The fixture
 * reproduces the root shapes of the five oracle corpora, because the bug this
 * class fixes is a root bug: `mapPythonImportToFile("dcim.models", …)` answers
 * `dcim/models.py` and netbox's file is `netbox/dcim/models/__init__.py`. The
 * import root is not the repo root in three of the five.
 *
 * Every assertion goes through the symbol table. There is no disk in this test
 * and there must be none in the implementation.
 */
import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../src/core/contracts/types/codegraph.js";
import { PythonImportFileMapper } from "../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * relPath -> shortNames declared there.
 *
 * The corpus gives every `__init__.py` a symbol because the real ones mostly
 * have one; a symbol-free marker is a first-class file too since bd
 * tea-rags-mcp-o7ifx, covered by its own describe block at the bottom.
 */
const CORPUS_FILES: Record<string, string[]> = {
  // netbox: import root is `netbox/`, packages are directories with __init__.py
  "netbox/dcim/models/__init__.py": ["Device", "Rack"],
  "netbox/dcim/views.py": ["DeviceListView"],
  "netbox/dcim/__init__.py": ["__version__"],
  "netbox/extras/ui/widgets.py": ["Widget"], // namespace pkg: no extras/ui/__init__.py
  "netbox/extras/__init__.py": ["__version__"],
  "netbox/netbox/settings.py": ["Settings"], // root dir name repeats the package name
  // flask: import root is `src/`, alias re-exports in the package __init__
  "src/flask/__init__.py": ["Flask"],
  "src/flask/app.py": ["Flask"],
  "src/flask/sansio/app.py": ["App"], // namespace pkg: no sansio/__init__.py
  // polar: import root is `server/`
  "server/polar/health/endpoints.py": ["healthz"], // namespace pkg: no health/__init__.py
  "server/polar/order/service.py": ["OrderService"],
  "server/polar/order/__init__.py": ["__all__"],
  // ugnest: import root is the repo root, `domains/` is a namespace package
  "domains/orders/handlers.py": ["place_order"],
  "domains/orders/__init__.py": ["__all__"],
  "domains/billing/invoice.py": ["Invoice"], // no domains/__init__.py anywhere
  // httpx: import root is the repo root
  "httpx/_client.py": ["Client"],
  "httpx/__init__.py": ["Client"],
};

function corpusTable(files: Record<string, string[]> = CORPUS_FILES): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, shortNames] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      shortNames.map((shortName) => ({
        symbolId: shortName,
        fqName: shortName,
        shortName,
        relPath,
        scope: [],
      })),
    );
  }
  return table;
}

function ctxFor(table: InMemoryGlobalSymbolTable, callerFile: string): CallContext {
  return { callerFile, callerScope: [], imports: [], symbolTable: table };
}

describe("PythonImportFileMapper — absolute imports under an inferred root", () => {
  const mapper = new PythonImportFileMapper();
  const table = corpusTable();

  it("netbox: a package import resolves to its __init__.py, not to a phantom .py", () => {
    // The whole point of the seam. mapPythonImportToFile answers "dcim/models.py".
    expect(
      mapper.mapImportToFile("dcim.models", "netbox/dcim/views.py", ctxFor(table, "netbox/dcim/views.py")),
    ).toEqual({ kind: "project", relPath: "netbox/dcim/models/__init__.py" });
  });

  it("netbox: a module import prefers the .py over a same-named package", () => {
    const from = "netbox/dcim/models/__init__.py";
    expect(mapper.mapImportToFile("dcim.views", from, ctxFor(table, from))).toEqual({
      kind: "project",
      relPath: "netbox/dcim/views.py",
    });
  });

  it("netbox: the root directory may repeat the package name", () => {
    const from = "netbox/dcim/views.py";
    expect(mapper.mapImportToFile("netbox.settings", from, ctxFor(table, from))).toEqual({
      kind: "project",
      relPath: "netbox/netbox/settings.py",
    });
  });

  it("flask: the src/ layout root is inferred from the importing file's ancestors", () => {
    const from = "src/flask/__init__.py";
    expect(mapper.mapImportToFile("flask.app", from, ctxFor(table, from))).toEqual({
      kind: "project",
      relPath: "src/flask/app.py",
    });
  });

  it("polar: the server/ root is inferred the same way", () => {
    const from = "server/polar/order/__init__.py";
    expect(mapper.mapImportToFile("polar.order.service", from, ctxFor(table, from))).toEqual({
      kind: "project",
      relPath: "server/polar/order/service.py",
    });
  });
});

describe("PythonImportFileMapper — the repo root as an import root", () => {
  const mapper = new PythonImportFileMapper();
  const table = corpusTable();

  it("ugnest: the repo root is a valid root", () => {
    const from = "domains/billing/invoice.py";
    expect(mapper.mapImportToFile("domains.orders.handlers", from, ctxFor(table, from))).toEqual({
      kind: "project",
      relPath: "domains/orders/handlers.py",
    });
  });

  it("a package with an __init__.py answers the __init__.py, not the directory", () => {
    const from = "domains/billing/invoice.py";
    expect(mapper.mapImportToFile("domains.orders", from, ctxFor(table, from))).toEqual({
      kind: "project",
      relPath: "domains/orders/__init__.py",
    });
  });

  it("httpx: a single-segment package import lands on its __init__.py", () => {
    const from = "httpx/_client.py";
    expect(mapper.mapImportToFile("httpx", from, ctxFor(table, from))).toEqual({
      kind: "project",
      relPath: "httpx/__init__.py",
    });
  });
});

describe("PythonImportFileMapper — namespace packages", () => {
  const mapper = new PythonImportFileMapper();
  const table = corpusTable();

  it("a PEP 420 namespace directory answers unknown, never a directory path", () => {
    // `cg_symbols_edges_file.target_rel_path` would store "netbox/extras/ui",
    // but it joins no row in cg_symbols_files, so it is a phantom by another name.
    const from = "netbox/dcim/views.py";
    expect(mapper.mapImportToFile("extras.ui", from, ctxFor(table, from))).toEqual({ kind: "unknown" });
  });

  it("a MEMBER of a namespace package still resolves", () => {
    const from = "netbox/dcim/views.py";
    expect(mapper.mapImportToFile("extras.ui.widgets", from, ctxFor(table, from))).toEqual({
      kind: "project",
      relPath: "netbox/extras/ui/widgets.py",
    });
  });

  it("ugnest: `domains` itself is a namespace package", () => {
    const from = "domains/billing/invoice.py";
    expect(mapper.mapImportToFile("domains", from, ctxFor(table, from))).toEqual({ kind: "unknown" });
  });

  it("flask: sansio has no __init__.py but sansio.app does resolve", () => {
    const from = "src/flask/app.py";
    expect(mapper.mapImportToFile("flask.sansio", from, ctxFor(table, from))).toEqual({ kind: "unknown" });
    expect(mapper.mapImportToFile("flask.sansio.app", from, ctxFor(table, from))).toEqual({
      kind: "project",
      relPath: "src/flask/sansio/app.py",
    });
  });

  it("polar: a namespace package is unknown, its member is not", () => {
    const from = "server/polar/order/service.py";
    expect(mapper.mapImportToFile("polar.health", from, ctxFor(table, from))).toEqual({ kind: "unknown" });
    expect(mapper.mapImportToFile("polar.health.endpoints", from, ctxFor(table, from))).toEqual({
      kind: "project",
      relPath: "server/polar/health/endpoints.py",
    });
  });
});

describe("PythonImportFileMapper — relative imports", () => {
  const mapper = new PythonImportFileMapper();
  const table = corpusTable();

  it("one dot with a tail is a sibling module", () => {
    const from = "src/flask/__init__.py";
    expect(mapper.mapImportToFile(".app", from, ctxFor(table, from))).toEqual({
      kind: "project",
      relPath: "src/flask/app.py",
    });
  });

  it("one dot alone is the package __init__.py", () => {
    const from = "src/flask/app.py";
    expect(mapper.mapImportToFile(".", from, ctxFor(table, from))).toEqual({
      kind: "project",
      relPath: "src/flask/__init__.py",
    });
  });

  it("two dots walk up one package", () => {
    const from = "src/flask/sansio/app.py";
    expect(mapper.mapImportToFile("..app", from, ctxFor(table, from))).toEqual({
      kind: "project",
      relPath: "src/flask/app.py",
    });
  });

  it("a relative import resolving to a package answers its __init__.py", () => {
    const from = "netbox/dcim/views.py";
    // `..models` from netbox/dcim is netbox/models, which does not exist.
    expect(mapper.mapImportToFile("..models", from, ctxFor(table, from))).toEqual({ kind: "unknown" });
    expect(mapper.mapImportToFile(".models", from, ctxFor(table, from))).toEqual({
      kind: "project",
      relPath: "netbox/dcim/models/__init__.py",
    });
  });

  it("a relative import never triggers root inference", () => {
    // `.orders` from domains/billing/invoice.py is domains/billing/orders, NOT
    // domains/orders — a root-inferring implementation would answer the latter.
    const from = "domains/billing/invoice.py";
    expect(mapper.mapImportToFile(".orders", from, ctxFor(table, from))).toEqual({ kind: "unknown" });
  });

  it("a relative import is never external, however absent its target", () => {
    // No dotted first segment can name a library, so the stdlib/external
    // residual must not run: `.json` is a sibling module, not the stdlib.
    const from = "domains/billing/invoice.py";
    expect(mapper.mapImportToFile(".json", from, ctxFor(table, from))).toEqual({ kind: "unknown" });
  });

  it("walking above the repo root is unknown, not a crash", () => {
    expect(mapper.mapImportToFile("....x", "a/b.py", ctxFor(table, "a/b.py"))).toEqual({ kind: "unknown" });
  });
});

describe("PythonImportFileMapper — external and degraded verdicts", () => {
  const mapper = new PythonImportFileMapper();
  const table = corpusTable();

  it("a stdlib module is external", () => {
    const from = "netbox/dcim/views.py";
    expect(mapper.mapImportToFile("os.path", from, ctxFor(table, from))).toEqual({ kind: "external" });
    expect(mapper.mapImportToFile("contextlib", from, ctxFor(table, from))).toEqual({ kind: "external" });
  });

  it("a third-party module absent from a populated table is external", () => {
    const from = "netbox/dcim/views.py";
    expect(mapper.mapImportToFile("django.db.models", from, ctxFor(table, from))).toEqual({ kind: "external" });
  });

  it("an EMPTY symbol table answers unknown, never external", () => {
    const empty = new InMemoryGlobalSymbolTable();
    expect(
      mapper.mapImportToFile("dcim.models", "netbox/dcim/views.py", ctxFor(empty, "netbox/dcim/views.py")),
    ).toEqual({ kind: "unknown" });
  });

  it("empty and whitespace import text answers unknown", () => {
    expect(mapper.mapImportToFile("", "a.py", ctxFor(table, "a.py"))).toEqual({ kind: "unknown" });
    expect(mapper.mapImportToFile("   ", "a.py", ctxFor(table, "a.py"))).toEqual({ kind: "unknown" });
  });

  it("tolerates a stray ` as alias` suffix, like the path helper does", () => {
    const from = "netbox/dcim/views.py";
    expect(mapper.mapImportToFile("dcim.models as m", from, ctxFor(table, from))).toEqual({
      kind: "project",
      relPath: "netbox/dcim/models/__init__.py",
    });
  });
});

describe("PythonImportFileMapper — memo", () => {
  it("re-answers after the table grows (size change invalidates)", () => {
    const mapper = new PythonImportFileMapper();
    const table = corpusTable({ "netbox/dcim/views.py": ["DeviceListView"] });
    const ctx = ctxFor(table, "netbox/dcim/views.py");
    expect(mapper.mapImportToFile("dcim.models", "netbox/dcim/views.py", ctx)).toEqual({ kind: "external" });
    table.upsertFile("netbox/dcim/models/__init__.py", [
      {
        symbolId: "Device",
        fqName: "Device",
        shortName: "Device",
        relPath: "netbox/dcim/models/__init__.py",
        scope: [],
      },
    ]);
    expect(mapper.mapImportToFile("dcim.models", "netbox/dcim/views.py", ctx)).toEqual({
      kind: "project",
      relPath: "netbox/dcim/models/__init__.py",
    });
  });

  it("two tables do not share answers", () => {
    const mapper = new PythonImportFileMapper();
    const full = corpusTable();
    const bare = corpusTable({ "netbox/dcim/views.py": ["DeviceListView"] });
    const from = "netbox/dcim/views.py";
    expect(mapper.mapImportToFile("dcim.models", from, ctxFor(full, from)).kind).toBe("project");
    expect(mapper.mapImportToFile("dcim.models", from, ctxFor(bare, from)).kind).toBe("external");
  });

  it("the same import text from two directories can differ", () => {
    const mapper = new PythonImportFileMapper();
    const table = corpusTable();
    expect(mapper.mapImportToFile(".app", "src/flask/__init__.py", ctxFor(table, "src/flask/__init__.py"))).toEqual({
      kind: "project",
      relPath: "src/flask/app.py",
    });
    expect(
      mapper.mapImportToFile(".app", "server/polar/order/__init__.py", ctxFor(table, "server/polar/order/__init__.py")),
    ).toEqual({ kind: "unknown" });
  });

  it("answers a repeated import from the memo without re-scanning roots", () => {
    const mapper = new PythonImportFileMapper();
    const table = corpusTable();
    const ctx = ctxFor(table, "netbox/dcim/views.py");
    const first = mapper.mapImportToFile("dcim.models", "netbox/dcim/views.py", ctx);
    const second = mapper.mapImportToFile("dcim.models", "netbox/dcim/views.py", ctx);
    expect(second).toBe(first); // same object identity = served from the memo
  });
});

describe("PythonImportFileMapper — a symbol-free __init__.py (bd tea-rags-mcp-o7ifx)", () => {
  it("resolves a package whose __init__.py declares nothing", () => {
    // netbox holds 70 empty `__init__.py` files and 39 more that only re-export.
    // While the table dropped them, every import of those packages answered
    // `unknown` at best and `external` at worst.
    const mapper = new PythonImportFileMapper();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("pkg/__init__.py", []);
    const from = "pkg/consumer.py";
    expect(mapper.mapImportToFile("pkg", from, ctxFor(table, from))).toEqual({
      kind: "project",
      relPath: "pkg/__init__.py",
    });
  });

  it("prefers the empty package marker over the namespace-directory verdict", () => {
    // `pkg/` holds a real module, so `hasFilesUnder` already answered
    // `namespace` -> unknown here. The marker makes it a nameable file edge.
    const mapper = new PythonImportFileMapper();
    const table = corpusTable({ "pkg/models.py": ["User"] });
    table.upsertFile("pkg/__init__.py", []);
    const from = "pkg/models.py";
    expect(mapper.mapImportToFile("pkg", from, ctxFor(table, from))).toEqual({
      kind: "project",
      relPath: "pkg/__init__.py",
    });
  });

  it("sees a package marker that arrived through hydrateFiles on a cold start", () => {
    const mapper = new PythonImportFileMapper();
    const table = corpusTable({ "pkg/models.py": ["User"] });
    table.hydrateFiles(["pkg/__init__.py"]);
    const from = "pkg/models.py";
    expect(mapper.mapImportToFile("pkg", from, ctxFor(table, from))).toEqual({
      kind: "project",
      relPath: "pkg/__init__.py",
    });
  });
});
