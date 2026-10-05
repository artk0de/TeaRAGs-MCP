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

/**
 * bd tea-rags-mcp-m99j1.1.52 — a constructor argument is typed from three more
 * sources: an annotated parameter of the enclosing def, `self.<field>` of a
 * class whose field type the file states, and a module-level value. Each one is
 * silent where the name might mean something else at the call site.
 */
describe("python param-arg types — widened argument typing (m99j1.1.52)", () => {
  const HELPER = ["class Helper:", "    def __init__(self, req):", "        self.req = req"];
  const argTypesOf = (lines: readonly string[]): unknown =>
    walk("app/w.py", [...lines, "", ...HELPER]).knownTargetCallArgs?.find((r) =>
      r.targets.includes("app/w.py::Helper#__init__"),
    )?.argTypes;
  const REQ = [{ form: "instance", name: "HttpRequest" }];

  it("types an argument that is an annotated parameter of the enclosing def", () => {
    expect(argTypesOf(["def handle(request: HttpRequest):", "    return Helper(request)"])).toEqual(REQ);
  });

  it("collapses Optional[A] and A | None to A, and reads a forward reference", () => {
    expect(argTypesOf(["def handle(request: Optional[HttpRequest]):", "    return Helper(request)"])).toEqual(REQ);
    expect(argTypesOf(["def handle(request: HttpRequest | None = None):", "    return Helper(request)"])).toEqual(REQ);
    expect(argTypesOf(['def handle(request: "HttpRequest"):', "    return Helper(request)"])).toEqual(REQ);
  });

  it("carries an aliased import's source name, as the constructor arm does", () => {
    expect(
      argTypesOf([
        "from django.http import HttpRequest as Req",
        "def handle(request: Req):",
        "    return Helper(request)",
      ]),
    ).toEqual(REQ);
  });

  it("declines a builtin annotation — the constructor arm's CapWords gate, so no builtin type is fed", () => {
    expect(argTypesOf(["def handle(request: str):", "    return Helper(request)"])).toBeUndefined();
    expect(
      argTypesOf(["class Owner:", "    req: int", "    def run(self):", "        return Helper(self.req)"]),
    ).toBeUndefined();
  });

  it("declines a two-arm union, a class object, and a splat parameter", () => {
    expect(
      argTypesOf(["def handle(request: Union[HttpRequest, Other]):", "    return Helper(request)"]),
    ).toBeUndefined();
    expect(argTypesOf(["def handle(request: type[HttpRequest]):", "    return Helper(request)"])).toBeUndefined();
    expect(argTypesOf(["def handle(*request: HttpRequest):", "    return Helper(request)"])).toBeUndefined();
  });

  it("declines a parameter the body rebinds, or a lambda / comprehension shadows", () => {
    expect(
      argTypesOf(["def handle(request: HttpRequest):", "    request = wrap(request)", "    return Helper(request)"]),
    ).toBeUndefined();
    expect(
      argTypesOf(["def handle(request: HttpRequest):", "    return map(lambda request: Helper(request), xs)"]),
    ).toBeUndefined();
    expect(
      argTypesOf(["def handle(request: HttpRequest):", "    return [Helper(request) for request in xs]"]),
    ).toBeUndefined();
  });

  it("does not read an outer def's annotated parameter inside a nested def", () => {
    expect(
      argTypesOf([
        "def outer(request: HttpRequest):",
        "    def inner(request):",
        "        return Helper(request)",
        "    return inner",
      ]),
    ).toBeUndefined();
  });

  it("types self.<field> from a class-body annotation or an annotated parameter copy", () => {
    const viaClassBody = [
      "class Owner:",
      "    req: HttpRequest",
      "    def run(self):",
      "        return Helper(self.req)",
    ];
    expect(argTypesOf(viaClassBody)).toEqual(REQ);
    const viaParamCopy = [
      "class Owner:",
      "    def __init__(self, req: HttpRequest):",
      "        self.req = req",
      "    def run(self):",
      "        return Helper(self.req)",
    ];
    expect(argTypesOf(viaParamCopy)).toEqual(REQ);
  });

  it("types self.<field> every assignment binds to one constructor, and declines a mixed field", () => {
    const ctor = [
      "class Owner:",
      "    def __init__(self):",
      "        self.req = HttpRequest()",
      "    def run(self):",
      "        return Helper(self.req)",
    ];
    expect(argTypesOf(ctor)).toEqual(REQ);
    const mixed = [
      "class Owner:",
      "    def __init__(self):",
      "        self.req = HttpRequest()",
      "    def reset(self):",
      "        self.req = None",
      "    def run(self):",
      "        return Helper(self.req)",
    ];
    expect(argTypesOf(mixed)).toBeUndefined();
  });

  it("declines self.<field> whose annotations disagree, and another class's field", () => {
    const conflicting = [
      "class Owner:",
      "    req: HttpRequest",
      "    def __init__(self):",
      "        self.req: Other = make()",
      "    def run(self):",
      "        return Helper(self.req)",
    ];
    expect(argTypesOf(conflicting)).toBeUndefined();
    const otherClass = [
      "class Typed:",
      "    req: HttpRequest",
      "class Owner:",
      "    def run(self):",
      "        return Helper(self.req)",
    ];
    expect(argTypesOf(otherClass)).toBeUndefined();
  });

  it("types a module-level value, unless a def binds the name itself", () => {
    expect(argTypesOf(["DEFAULT = HttpRequest()", "def run():", "    return Helper(DEFAULT)"])).toEqual(REQ);
    expect(argTypesOf(["DEFAULT = HttpRequest()", "Helper(DEFAULT)"])).toEqual(REQ);
    expect(
      argTypesOf(["DEFAULT = HttpRequest()", "def run():", "    DEFAULT = make()", "    return Helper(DEFAULT)"]),
    ).toBeUndefined();
    expect(argTypesOf(["DEFAULT = HttpRequest()", "def run(DEFAULT):", "    return Helper(DEFAULT)"])).toBeUndefined();
    expect(
      argTypesOf([
        "DEFAULT = HttpRequest()",
        "def outer():",
        "    DEFAULT = make()",
        "    def inner():",
        "        return Helper(DEFAULT)",
      ]),
    ).toBeUndefined();
  });

  it("declines a module-level name the module rebinds", () => {
    expect(
      argTypesOf(["DEFAULT = HttpRequest()", "DEFAULT = None", "def run():", "    return Helper(DEFAULT)"]),
    ).toBeUndefined();
  });

  it("folds an annotated-parameter argument into the callee's parameter type", async () => {
    const caller = walk("django/core/handlers/base.py", [
      "from django.http.request import HttpRequest",
      "from django.views.generic.base import View",
      "",
      "def handle(request: HttpRequest):",
      "    return View(request)",
    ]);
    const state = await seal([viewFile(), requestFile(), caller]);
    expect(state.paramTypes[`${VIEW_KEY}#__init__`]).toEqual({ request: { form: "instance", name: "HttpRequest" } });
  });
});

/**
 * bd tea-rags-mcp-lvlwc — the silent corners of the call-site typing: every
 * binding form that poisons a constructor-typed local or rebinds an annotated
 * parameter, the module-value read through class and lambda scopes, field
 * writes through tuple / foreign receivers, and the callee spellings that name
 * no single class. Each one must stay silent rather than feed a wrong type.
 */
describe("python param-arg types — binding forms that void an argument type (lvlwc)", () => {
  const HELPER = ["class Helper:", "    def __init__(self, req):", "        self.req = req"];
  const argTypesOf = (lines: readonly string[]): unknown =>
    walk("app/w.py", [...lines, "", ...HELPER]).knownTargetCallArgs?.find((r) =>
      r.targets.includes("app/w.py::Helper#__init__"),
    )?.argTypes;
  const REQ = [{ form: "instance", name: "HttpRequest" }];

  it("declines a constructor-typed local that any other binding form also writes", () => {
    const rebinds = [
      "req, other = pair",
      "req += 1",
      "for req in xs:\n        pass",
      "with opener() as req:\n        pass",
      "(req := make())",
      "from m import req",
      "global req",
      "ys = [1 for req in xs]",
    ];
    for (const rebind of rebinds) {
      const lines = ["def run():", "    req = HttpRequest()", `    ${rebind}`, "    return Helper(req)"];
      expect(argTypesOf(lines), rebind).toBeUndefined();
    }
    expect(argTypesOf(["def run():", "    req = HttpRequest()", "    return Helper(req)"])).toEqual(REQ);
  });

  it("declines a constructor-typed local assigned two different constructors", () => {
    const lines = ["def run(flag):", "    req = HttpRequest()", "    req = Other()", "    return Helper(req)"];
    expect(argTypesOf(lines)).toBeUndefined();
    const twice = ["def run(flag):", "    req = HttpRequest()", "    req = HttpRequest()", "    return Helper(req)"];
    expect(argTypesOf(twice)).toEqual(REQ);
  });

  it("declines an annotated parameter that any statement form rebinds in the body", () => {
    const rebinds = [
      "request, other = pair",
      "request += wrap(1)",
      "for request in xs:\n        pass",
      "with opener() as request:\n        pass",
      "(request := make())",
      "def request(): pass",
      "class request: pass",
      "import request",
      "from m import request",
      "global request",
      "match xs:\n        case [request]:\n            pass",
    ];
    for (const rebind of rebinds) {
      const lines = ["def run(request: HttpRequest):", `    ${rebind}`, "    return Helper(request)"];
      expect(argTypesOf(lines), rebind).toBeUndefined();
    }
  });

  it("reads an annotated parameter at two call sites of one def", () => {
    const out = walk("app/w.py", [
      "def run(request: HttpRequest):",
      "    Helper(request)",
      "    return Helper(request)",
      "",
      ...HELPER,
    ]);
    expect(out.knownTargetCallArgs).toHaveLength(2);
  });

  it("types an argument spelled as a dotted constructor, and past a comment; declines foreign attributes", () => {
    expect(argTypesOf(["def run():", "    return Helper(models.HttpRequest())"])).toEqual([
      { form: "instance", name: "models.HttpRequest" },
    ]);
    expect(argTypesOf(["def run():", "    return Helper(  # the request", "        HttpRequest())"])).toEqual(REQ);
    expect(argTypesOf(["def run(thing):", "    return Helper(thing.req)"])).toBeUndefined();
    expect(argTypesOf(["Helper(thing.req)"])).toBeUndefined();
  });

  it("reads a module value through a class body only where the class does not bind the name", () => {
    const base = ["DEFAULT = HttpRequest()", "class K:"];
    expect(argTypesOf([...base, "    DEFAULT = make()", "    x = Helper(DEFAULT)"])).toBeUndefined();
    expect(argTypesOf([...base, "    DEFAULT += 1", "    x = Helper(DEFAULT)"])).toBeUndefined();
    expect(argTypesOf([...base, "    other = 1", "    x = Helper(DEFAULT)"])).toEqual(REQ);
    expect(argTypesOf([...base, "    def m(self):", "        return Helper(DEFAULT)"])).toEqual(REQ);
    expect(argTypesOf(["DEFAULT = HttpRequest()", "f = lambda DEFAULT: Helper(DEFAULT)"])).toBeUndefined();
    expect(argTypesOf(["DEFAULT = HttpRequest()", "f = lambda other: Helper(DEFAULT)"])).toEqual(REQ);
  });

  it("declines self.<field> when the method rebinds self, or a write goes through a tuple; ignores foreign writes", () => {
    const rebound = [
      "class Owner:",
      "    def __init__(self):",
      "        self.req = HttpRequest()",
      "    def run(self):",
      "        self = other",
      "        return Helper(self.req)",
    ];
    expect(argTypesOf(rebound)).toBeUndefined();
    const tuple = [
      "class Owner:",
      "    def __init__(self):",
      "        self.req = HttpRequest()",
      "    def reset(self):",
      "        self.req, self.n = a, b",
      "    def run(self):",
      "        return Helper(self.req)",
    ];
    expect(argTypesOf(tuple)).toBeUndefined();
    const foreign = [
      "class Owner:",
      "    def __init__(self, x):",
      "        self.req = HttpRequest()",
      "        x.req = Other()",
      "        for self.n in xs:",
      "            pass",
      "    @staticmethod",
      "    def make(self):",
      "        self.req = Other()",
      "    def run(self):",
      "        return Helper(self.req)",
    ];
    expect(argTypesOf(foreign)).toEqual(REQ);
  });

  it("keeps a field fed by one parameter, ignoring another object's field copy", () => {
    const out = walk("app/f.py", [
      "class A:",
      "    def __init__(self, x, y):",
      "        self.f = x",
      "        y.f = x",
      "        self.g = x",
      "        self.g = x",
    ]);
    expect(out.classFieldParamLinks).toEqual({
      "app/f.py::A": {
        f: { method: "__init__", param: "x" },
        g: { method: "__init__", param: "x" },
      },
    });
  });

  it("emits no call-site record for a callee no single class names", () => {
    const sites = (lines: readonly string[]): unknown => walk("pkg/mod.py", lines).knownTargetCallArgs;
    expect(sites(["from ... import View", "def go():", "    return View(HttpRequest())"])).toBeUndefined();
    expect(
      sites(["from a import View", "from b import View", "def go():", "    return View(HttpRequest())"]),
    ).toBeUndefined();
    expect(
      sites(["from a import View", "from a import View", "def go():", "    return View(HttpRequest())"]),
    ).toBeDefined();
    expect(
      sites(["class View: pass", "class View: pass", "def go():", "    return View(HttpRequest())"]),
    ).toBeUndefined();
    expect(sites(["def go(View):", "    return View(HttpRequest())"])).toBeUndefined();
    expect(sites(["from a import View as V, other", "def go():", "    return V(HttpRequest())"])).toBeDefined();
  });

  it("skips the calls inside a class nested in a def, whose self cannot be spelled", () => {
    const lines = [
      "def factory():",
      "    class Inner:",
      "        def m(self):",
      "            return Helper(HttpRequest())",
      "    return Inner",
    ];
    expect(argTypesOf(lines)).toBeUndefined();
  });
});
