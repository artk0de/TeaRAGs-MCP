/**
 * K7 Python walker feed — call-argument types flow into parameters and fields
 * (bd tea-rags-mcp-m99j1.1.17).
 *
 * `View(HttpRequest())` names its callee from syntax alone: the class `View`
 * the caller's import binds, and its `__init__`. The walker records the
 * argument types per position at that site (`knownTargetCallArgs`), the
 * positional parameter names of every def (`paramNames`), and the
 * `self.<field> = <param>` copies (`classFieldParamLinks`) — all under Python's
 * file-qualified class key `<relPath>::<dotted class FQ>`. The run-level fold
 * joins them by string equality, so the tests below go through the fold and
 * the resolver, not only the walker output.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import { fromCgPass1Row, toCgPass1Row } from "../../../../../../src/core/adapters/duckdb/cg-pass1-aggregates-row.js";
import { NoopGlobalSymbolTable } from "../../../../../../src/core/adapters/duckdb/daemon/noop-symbol-table.js";
import type {
  CallContext,
  CallRef,
  CodegraphPass1FileAggregates,
  FileExtraction,
  GlobalSymbolTable,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { PythonLanguage } from "../../../../../../src/core/domains/language/python/index.js";
import { PythonAncestorLinearizerCache } from "../../../../../../src/core/domains/language/python/resolver/python-ancestor-policy.js";
import { PythonImportFileMapper } from "../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { PythonSelfFieldSymbolResolutionStrategy } from "../../../../../../src/core/domains/language/python/resolver/strategies/python-self-field.js";
import {
  paramTypesOfChunk,
  seedParamLocalBindings,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/call-arg-param-types.js";
import { buildPass1Aggregates } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/pass1-aggregates.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

interface ChunkSpec {
  readonly symbolId: string;
  readonly startLine: number;
  readonly endLine: number;
}

function walk(relPath: string, lines: readonly string[], chunks: readonly ChunkSpec[] = []): FileExtraction {
  const src = lines.join("\n");
  const parser = new Parser();
  parser.setLanguage(PyLang);
  return new PythonLanguage().walker.walk({
    tree: parser.parse(src),
    code: src,
    relPath,
    language: "python",
    chunks: chunks.map((c) => ({ ...c, scope: c.symbolId.includes("#") ? [c.symbolId.split("#")[0]] : [] })),
  });
}

const VIEW_PATH = "django/views/generic/base.py";
const VIEW_KEY = `${VIEW_PATH}::View`;

const viewFile = (): FileExtraction =>
  walk(
    VIEW_PATH,
    [
      "class View:",
      "    def __init__(self, request, kwargs=None):",
      "        self.request = request",
      "        self.kwargs = kwargs",
      "",
      "    def dispatch(self):",
      "        return self.request.is_secure()",
    ],
    [
      { symbolId: "View", startLine: 1, endLine: 7 },
      { symbolId: "View#__init__", startLine: 2, endLine: 4 },
      { symbolId: "View#dispatch", startLine: 6, endLine: 7 },
    ],
  );

const requestFile = (): FileExtraction =>
  walk(
    "django/http/request.py",
    ["class HttpRequest:", "    def is_secure(self):", "        return True", "", "class Other:", "    pass"],
    [
      { symbolId: "HttpRequest", startLine: 1, endLine: 3 },
      { symbolId: "HttpRequest#is_secure", startLine: 2, endLine: 3 },
    ],
  );

const callerFile = (relPath: string, argExpr: string): FileExtraction =>
  walk(relPath, [
    "from django.http.request import HttpRequest, Other",
    "from django.views.generic.base import View",
    "",
    "def handle():",
    `    return View(${argExpr})`,
  ]);

async function seal(files: readonly FileExtraction[]): Promise<CodegraphRunState> {
  const state = new CodegraphRunState();
  for (const file of files) state.absorb(file, []);
  await state.seal(async (): Promise<GlobalSymbolTable> => new NoopGlobalSymbolTable());
  return state;
}

/** A run whose `unwalked` files enter only through their persisted pass-1 slice. */
async function sealHydrated(
  walked: readonly FileExtraction[],
  unwalked: readonly FileExtraction[],
): Promise<CodegraphRunState> {
  const persisted = (file: FileExtraction): CodegraphPass1FileAggregates[] => {
    const slice = buildPass1Aggregates(file, []);
    if (slice === undefined) return [];
    const [relPath, language, json] = toCgPass1Row(slice) as [string, string, string];
    return [fromCgPass1Row({ rel_path: relPath, language, aggregates_json: json })];
  };
  const state = new CodegraphRunState();
  for (const file of walked) state.absorb(file, []);
  await state.seal(
    async (): Promise<GlobalSymbolTable> => new NoopGlobalSymbolTable(),
    async () => unwalked.flatMap(persisted),
  );
  return state;
}

describe("python param-arg types — walker output", () => {
  it("spells the __init__ chunk's fold coordinate with the file-qualified class key", () => {
    const init = viewFile().chunks.find((c) => c.symbolId === "View#__init__");
    expect(init?.paramCoordinate).toBe(`${VIEW_KEY}#__init__`);
  });

  it("spells a nested class's coordinate and link key with its dotted class FQ", () => {
    const out = walk(
      "app/n.py",
      ["class Outer:", "    class Inner:", "        def __init__(self, x):", "            self.x = x"],
      [
        { symbolId: "Outer", startLine: 1, endLine: 4 },
        { symbolId: "Outer.Inner#__init__", startLine: 3, endLine: 4 },
      ],
    );
    const init = out.chunks.find((c) => c.symbolId === "Outer.Inner#__init__");
    expect(init?.paramCoordinate).toBe("app/n.py::Outer.Inner#__init__");
    expect(Object.keys(out.classFieldParamLinks ?? {})).toEqual(["app/n.py::Outer.Inner"]);
  });

  it("records the positional parameter names of a method, receiver dropped, stopping at a default", () => {
    const init = viewFile().chunks.find((c) => c.symbolId === "View#__init__");
    expect(init?.paramNames).toEqual(["request"]);
  });

  it("links a `self.<field> = <param>` copy under the file-qualified class key", () => {
    expect(viewFile().classFieldParamLinks).toEqual({
      [VIEW_KEY]: {
        request: { method: "__init__", param: "request" },
        kwargs: { method: "__init__", param: "kwargs" },
      },
    });
  });

  it("drops a field fed by two different parameter coordinates", () => {
    const out = walk("app/a.py", [
      "class A:",
      "    def __init__(self, x):",
      "        self.f = x",
      "    def reset(self, y):",
      "        self.f = y",
    ]);
    expect(out.classFieldParamLinks).toBeUndefined();
  });

  it("types a constructor argument at an import-bound constructor call, keyed by the callee's class key", () => {
    const records = callerFile("django/core/handlers/base.py", "HttpRequest()").knownTargetCallArgs ?? [];
    const site = records.find((r) => r.targets.includes(`${VIEW_KEY}#__init__`));
    expect(site?.argTypes).toEqual([{ form: "instance", name: "HttpRequest" }]);
  });

  it("types a local bound once to a constructor, and `self` as the enclosing class", () => {
    const out = walk("app/b.py", [
      "class Local:",
      "    def run(self):",
      "        req = HttpRequest()",
      "        return Helper(req, self)",
      "",
      "class Helper:",
      "    def __init__(self, req, owner):",
      "        self.req = req",
    ]);
    expect(out.knownTargetCallArgs).toContainEqual({
      targets: ["app/b.py::Helper#__init__"],
      argTypes: [
        { form: "instance", name: "HttpRequest" },
        { form: "instance", name: "Local" },
      ],
    });
  });

  it("emits nothing for a local rebound to something untyped, and stops at a keyword argument", () => {
    const out = walk("app/c.py", [
      "def run(flag):",
      "    req = HttpRequest()",
      "    req = make()",
      "    return Helper(req, owner=Other())",
      "",
      "class Helper:",
      "    def __init__(self, req, owner):",
      "        pass",
    ]);
    expect(out.knownTargetCallArgs).toBeUndefined();
  });

  it("resolves a relative import against the caller's package", () => {
    const out = walk("django/views/generic/edit.py", [
      "from .base import View",
      "",
      "def build(request):",
      "    return View(HttpRequest())",
    ]);
    const targets = out.knownTargetCallArgs?.[0]?.targets ?? [];
    expect(targets).toContain(`${VIEW_KEY}#__init__`);
    expect(targets).toContain("django/views/generic/base/__init__.py::View#__init__");
  });
});

describe("python param-arg types — through the fold and the resolver", () => {
  it("types View.request from the call site and resolves self.request.is_secure()", async () => {
    const state = await seal([viewFile(), requestFile(), callerFile("django/core/handlers/base.py", "HttpRequest()")]);

    expect(state.paramTypes[`${VIEW_KEY}#__init__`]).toEqual({ request: { form: "instance", name: "HttpRequest" } });
    expect(state.classFieldTypesByClassKey[VIEW_KEY]).toEqual({ request: "HttpRequest" });

    const table = new InMemoryGlobalSymbolTable();
    const def = (relPath: string, symbolId: string, scope: string[]) => ({
      symbolId,
      fqName: symbolId,
      shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
      relPath,
      scope,
    });
    table.upsertFile(VIEW_PATH, [def(VIEW_PATH, "View", []), def(VIEW_PATH, "View#dispatch", ["View"])]);
    table.upsertFile("django/http/request.py", [
      def("django/http/request.py", "HttpRequest", []),
      def("django/http/request.py", "HttpRequest#is_secure", ["HttpRequest"]),
    ]);
    const mapper = new PythonImportFileMapper();
    const strategy = new PythonSelfFieldSymbolResolutionStrategy(
      { mode: "strict" },
      mapper,
      new PythonAncestorLinearizerCache(mapper, "strict"),
    );
    const call: CallRef = {
      callText: "self.request.is_secure()",
      receiver: "self.request",
      member: "is_secure",
      startLine: 7,
    };
    const ctx: CallContext = {
      callerFile: VIEW_PATH,
      callerScope: ["View", "dispatch"],
      imports: [],
      symbolTable: table,
      classFieldTypesByClassKey: state.classFieldTypesByClassKey,
    };
    expect(strategy.attempt(call, ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "django/http/request.py", targetSymbolId: "HttpRequest#is_secure" },
    });
  });

  it("seeds the folded type at the walked __init__ chunk's def line through its coordinate", async () => {
    const view = viewFile();
    const state = await seal([view, requestFile(), callerFile("django/core/handlers/base.py", "HttpRequest()")]);
    const init = view.chunks.find((c) => c.symbolId === "View#__init__");
    if (init === undefined) throw new Error("walker lost the __init__ chunk");

    expect(
      seedParamLocalBindings(init.localBindings, paramTypesOfChunk(state.paramTypes, init), init.startLine),
    ).toEqual(expect.objectContaining({ request: [{ line: 2, type: "HttpRequest" }] }));
  });

  it("derives what a full run derives when the call site's or the def's file was not walked", async () => {
    const caller = callerFile("django/core/handlers/base.py", "HttpRequest()");
    const full = await seal([viewFile(), requestFile(), caller]);
    const callerUnwalked = await sealHydrated([viewFile(), requestFile()], [caller]);
    const defUnwalked = await sealHydrated([requestFile(), caller], [viewFile()]);

    expect(full.classFieldTypesByClassKey[VIEW_KEY]).toEqual({ request: "HttpRequest" });
    for (const inc of [callerUnwalked, defUnwalked]) {
      expect(inc.paramTypes).toEqual(full.paramTypes);
      expect(inc.classFieldTypesByClassKey[VIEW_KEY]).toEqual(full.classFieldTypesByClassKey[VIEW_KEY]);
    }
  });

  it("derives no fact when two call sites disagree on the argument type", async () => {
    const state = await seal([
      viewFile(),
      requestFile(),
      callerFile("django/core/handlers/base.py", "HttpRequest()"),
      callerFile("django/test/client.py", "Other()"),
    ]);

    expect(state.paramTypes[`${VIEW_KEY}#__init__`]).toBeUndefined();
    expect(state.classFieldTypesByClassKey[VIEW_KEY]).toBeUndefined();
  });
});
