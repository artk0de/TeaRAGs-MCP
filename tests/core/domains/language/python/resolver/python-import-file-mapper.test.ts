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

import { NoopGlobalSymbolTable } from "../../../../../../src/core/adapters/duckdb/daemon/noop-symbol-table.js";
import type { CallContext, GlobalSymbolTable } from "../../../../../../src/core/contracts/types/codegraph.js";
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

/**
 * Source roots seeded from the table's file set (bd tea-rags-mcp-60nss).
 *
 * The ancestor scan can only prove a root that is an ANCESTOR of the importing
 * file. flask's `examples/app.py` does `from flask import Flask` while the
 * package lives at `src/flask/`, and `src` is nobody's ancestor there — so the
 * scan exhausted, the import fell out `external`, and 15 bare calls the oracle
 * expects (`render_template`, `flash`, `Flask`, `jsonify`) were dropped before
 * `globalShortName` ever ran. Lazy learning made the verdict depend on walk
 * order besides: visiting `src/flask/app.py` first happened to prove `src`.
 */
describe("PythonImportFileMapper — roots seeded from the symbol table file set", () => {
  const FLASK_SRC_LAYOUT: Record<string, string[]> = {
    "src/flask/__init__.py": ["Flask"],
    "src/flask/app.py": ["Flask"],
    "examples/app.py": ["main"],
  };

  it("flask: an absolute import resolves from a directory the src root does not contain", () => {
    const table = corpusTable(FLASK_SRC_LAYOUT);
    const from = "examples/app.py";
    expect(new PythonImportFileMapper().mapImportToFile("flask", from, ctxFor(table, from))).toEqual({
      kind: "project",
      relPath: "src/flask/__init__.py",
    });
  });

  it("flask: the same answer when the table saw examples/ before src/", () => {
    // Seeding reads the whole file set, so insertion order cannot change it.
    const table = corpusTable({
      "examples/app.py": ["main"],
      "src/flask/app.py": ["Flask"],
      "src/flask/__init__.py": ["Flask"],
    });
    const from = "examples/app.py";
    expect(new PythonImportFileMapper().mapImportToFile("flask", from, ctxFor(table, from))).toEqual({
      kind: "project",
      relPath: "src/flask/__init__.py",
    });
  });

  it("flask: the answer does not depend on which file the mapper answered for first", () => {
    const table = corpusTable(FLASK_SRC_LAYOUT);
    const mapper = new PythonImportFileMapper();
    // Warm the memo from INSIDE the package first — the order that used to be
    // the only one that worked — then ask from outside it.
    mapper.mapImportToFile("flask.app", "src/flask/__init__.py", ctxFor(table, "src/flask/__init__.py"));
    expect(mapper.mapImportToFile("flask", "examples/app.py", ctxFor(table, "examples/app.py"))).toEqual({
      kind: "project",
      relPath: "src/flask/__init__.py",
    });
  });

  it("netbox: a root nested one level down is seeded from its package markers", () => {
    const table = corpusTable({
      "netbox/dcim/__init__.py": ["__version__"],
      "netbox/dcim/models/__init__.py": ["Device"],
      "scripts/tool.py": ["main"],
    });
    const from = "scripts/tool.py";
    expect(new PythonImportFileMapper().mapImportToFile("dcim.models", from, ctxFor(table, from))).toEqual({
      kind: "project",
      relPath: "netbox/dcim/models/__init__.py",
    });
  });

  it("polar: a package nested inside a seeded root does not become a root itself", () => {
    // `server/polar` holds `order/__init__.py`, but `server/polar/__init__.py`
    // exists, so `server/polar` is a PACKAGE and only `server` is a root.
    const table = corpusTable({
      "server/polar/__init__.py": ["__version__"],
      "server/polar/order/__init__.py": ["__all__"],
      "server/polar/order/service.py": ["OrderService"],
      "tests/test_order.py": ["test_place"],
    });
    const from = "tests/test_order.py";
    const mapper = new PythonImportFileMapper();
    expect(mapper.mapImportToFile("polar.order.service", from, ctxFor(table, from))).toEqual({
      kind: "project",
      relPath: "server/polar/order/service.py",
    });
    // A root inferred as `server/polar` would answer `server/polar/order/...`
    // for `order.service`; it must not, because `polar` is a package.
    expect(mapper.mapImportToFile("order.service", from, ctxFor(table, from))).toEqual({ kind: "external" });
  });

  it("a table without the optional listFiles capability still answers, unseeded", () => {
    const inner = corpusTable(FLASK_SRC_LAYOUT);
    const noListFiles: GlobalSymbolTable = {
      upsertFile: (relPath, defs) => {
        inner.upsertFile(relPath, defs);
      },
      removeFile: (relPath) => {
        inner.removeFile(relPath);
      },
      lookup: (fqName) => inner.lookup(fqName),
      lookupByShortName: (name, options) => inner.lookupByShortName(name, options),
      hasFile: (relPath) => inner.hasFile(relPath),
      hasFilesUnder: (dir) => inner.hasFilesUnder(dir),
      size: () => inner.size(),
      hydrate: (defs) => {
        inner.hydrate(defs);
      },
      shortNameDefCounts: () => inner.shortNameDefCounts(),
    };
    const from = "examples/app.py";
    const ctx: CallContext = { callerFile: from, callerScope: [], imports: [], symbolTable: noListFiles };
    // Pre-60nss behaviour, not a crash: the ancestor scan exhausts.
    expect(new PythonImportFileMapper().mapImportToFile("flask", from, ctx)).toEqual({ kind: "external" });
  });

  it("the daemon's no-op table seeds nothing and stays unknown", () => {
    const table = new NoopGlobalSymbolTable();
    const from = "examples/app.py";
    const ctx: CallContext = { callerFile: from, callerScope: [], imports: [], symbolTable: table };
    expect(new PythonImportFileMapper().mapImportToFile("flask", from, ctx)).toEqual({ kind: "unknown" });
  });
});

/**
 * The caller's OWN source root leads (bd tea-rags-mcp-hg427).
 *
 * polar owns three directories named `polar`: `server/polar`, `sdk/python/polar`
 * and `sdk/generator/python/template/polar` — a template copy of the SDK.
 * Seeding orders roots deepest-first, so the template root (four segments) beat
 * `sdk/python` (two) and every caller under `sdk/python/**` resolved `polar.*`
 * into the template: 1,468 of polar's 1,618 `wrongFile` rows in the E0.11
 * oracle run.
 *
 * The oracle already decides this per file — `order_roots` in
 * `scripts/py-oracle/jedi_oracle.py`: the declared root CONTAINING the file
 * leads, the declared order is the tie-break for a file under none of them, and
 * containment is tested on a separator boundary.
 */
describe("PythonImportFileMapper — the caller's own root leads (bd tea-rags-mcp-hg427)", () => {
  const POLAR_THREE_ROOTS: Record<string, string[]> = {
    // The SDK the repo ships.
    "sdk/python/polar/__init__.py": ["Polar"],
    "sdk/python/polar/base.py": ["SdkBase"],
    "sdk/python/polar/v1/x.py": ["call_sdk"],
    // A generator template copying the SDK — a DEEPER root, same package name.
    "sdk/generator/python/template/polar/__init__.py": ["Polar"],
    "sdk/generator/python/template/polar/base.py": ["TemplateBase"],
    "sdk/generator/python/template/polar/y.py": ["call_template"],
    // The server package.
    "server/polar/__init__.py": ["__version__"],
    "server/polar/base.py": ["ServerBase"],
    "server/polar/a.py": ["call_server"],
    // Callers under no seeded root at all.
    "tools/z.py": ["main"],
    "server-tools/x.py": ["main"],
  };

  const TEMPLATE_BASE = "sdk/generator/python/template/polar/base.py";

  function mapPolar(from: string, files: Record<string, string[]> = POLAR_THREE_ROOTS): unknown {
    const table = corpusTable(files);
    return new PythonImportFileMapper().mapImportToFile("polar.base", from, ctxFor(table, from));
  }

  it("a caller under sdk/python reaches its own polar, not the deeper template copy", () => {
    expect(mapPolar("sdk/python/polar/v1/x.py")).toEqual({
      kind: "project",
      relPath: "sdk/python/polar/base.py",
    });
  });

  it("a caller under server reaches server's polar", () => {
    expect(mapPolar("server/polar/a.py")).toEqual({ kind: "project", relPath: "server/polar/base.py" });
  });

  it("a caller inside the template reaches the template's own copy", () => {
    expect(mapPolar("sdk/generator/python/template/polar/y.py")).toEqual({
      kind: "project",
      relPath: TEMPLATE_BASE,
    });
  });

  it("a caller sitting directly IN a root counts as contained by it", () => {
    expect(mapPolar("server/manage.py", { ...POLAR_THREE_ROOTS, "server/manage.py": ["main"] })).toEqual({
      kind: "project",
      relPath: "server/polar/base.py",
    });
  });

  it("a caller under no seeded root keeps the deepest-first answer", () => {
    // Nothing to prefer, so the seeded order stands and the deepest root answers
    // — exactly as before hg427.
    expect(mapPolar("tools/z.py")).toEqual({ kind: "project", relPath: TEMPLATE_BASE });
  });

  it("containment stops at a separator: `server` does not contain `server-tools/x.py`", () => {
    // A bare prefix test would hoist `server` here and answer server's polar.
    expect(mapPolar("server-tools/x.py")).toEqual({ kind: "project", relPath: TEMPLATE_BASE });
  });
});
