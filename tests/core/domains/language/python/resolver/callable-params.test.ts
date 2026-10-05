/**
 * P2 callable-value flow (bd tea-rags-mcp-m99j1.1.19, plan Task 17).
 *
 * A function reference passed into a parameter — a decorator `@d def f` is the
 * implicit call `d(f)` — is what a later `param(...)` call inside the receiving
 * def invokes. The walker records two halves:
 *
 *   - `CallRef.calleeParam` on the invoking call: which module-level def owns
 *     the parameter and at which call-site position (a closure's `view_func(…)`
 *     inside `wrapped` still names `csrf_exempt`'s parameter);
 *   - `FileExtraction.callableArgSources` at every passing site, keyed
 *     `<relPath>::<callee member>`.
 *
 * The resolver joins them: one source → an exact chain answer (`callableParam`),
 * several → a `cone` fan from the dispatch component.
 *
 * The receiver-idiom half: `cls(...)`, `type(self)(...)` and
 * `self.__class__(...)` construct the enclosing class → its `__init__`.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { CallContext, CallRef, FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { PythonCallResolver } from "../../../../../../src/core/domains/language/python/resolver/python-resolver.js";
import { extractFromPythonFile } from "../../../../../../src/core/domains/language/python/walker/walker.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

type Chunk = { symbolId: string; startLine: number; endLine: number; scope: string[] };

function extract(code: string, chunks: Chunk[], relPath: string): FileExtraction {
  const parser = new Parser();
  parser.setLanguage(PyLang);
  return extractFromPythonFile({ tree: parser.parse(code), code, relPath, language: "python", chunks });
}

/**
 * The symbol table the run would build from the same chunks, each definition
 * carrying the kind the walker recorded for it when an extraction is given.
 */
function tableOf(files: Record<string, readonly Chunk[]>, extraction?: FileExtraction): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, chunks] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      chunks.map((c) => {
        const symbolKind = extraction?.chunks.find((x) => x.symbolId === c.symbolId)?.symbolKind;
        return {
          symbolId: c.symbolId,
          fqName: c.symbolId,
          shortName: c.symbolId.split(/[#.]/).pop() ?? c.symbolId,
          relPath,
          scope: [...c.scope],
          ...(symbolKind === undefined ? {} : { symbolKind }),
        };
      }),
    );
  }
  return table;
}

function callIn(e: FileExtraction, symbolId: string, member: string): CallRef {
  const chunk = e.chunks.find((c) => c.symbolId === symbolId);
  const call = chunk?.calls.find((c) => c.member === member);
  if (!call) throw new Error(`no ${member} call in ${symbolId}`);
  return call;
}

const DECORATORS = "pkg/decorators.py";
const VIEWS = "pkg/views.py";

const DECORATOR_CODE = [
  "def csrf_exempt(view_func):", // 1
  "    def wrapped(*a):", // 2
  "        return view_func(*a)", // 3
  "    return wrapped", // 4
  "",
].join("\n");
const DECORATOR_CHUNKS: Chunk[] = [{ symbolId: "csrf_exempt", startLine: 1, endLine: 4, scope: [] }];

function viewsCode(names: readonly string[]): { code: string; chunks: Chunk[] } {
  const lines = ["from pkg.decorators import csrf_exempt", ""];
  const chunks: Chunk[] = [];
  for (const name of names) {
    lines.push("@csrf_exempt");
    lines.push(`def ${name}(request):`);
    chunks.push({ symbolId: name, startLine: lines.length, endLine: lines.length + 1, scope: [] });
    lines.push("    return 1");
    lines.push("");
  }
  return { code: lines.join("\n"), chunks };
}

function decoratorScenario(viewNames: readonly string[]) {
  const deco = extract(DECORATOR_CODE, DECORATOR_CHUNKS, DECORATORS);
  const views = viewsCode(viewNames);
  const viewsExtraction = extract(views.code, views.chunks, VIEWS);
  const table = tableOf({ "pkg/__init__.py": [], [DECORATORS]: DECORATOR_CHUNKS, [VIEWS]: views.chunks });
  const ctx: CallContext = {
    callerFile: DECORATORS,
    callerScope: ["csrf_exempt", "wrapped"],
    callerSymbolId: "csrf_exempt",
    imports: [],
    symbolTable: table,
    callableArgSources: { ...deco.callableArgSources, ...viewsExtraction.callableArgSources },
    // Another file's `from` bindings reach the resolver as its `moduleReexports`.
    moduleReexports: { [VIEWS]: viewsExtraction.moduleReexports ?? [] },
  };
  return { deco, viewsExtraction, ctx, call: callIn(deco, "csrf_exempt", "view_func") };
}

describe("walker — callable-value facts", () => {
  it("marks a closure's call of an outer def's parameter with the owner and position", () => {
    const { call } = decoratorScenario(["v"]);
    expect(call.calleeParam).toEqual({ ownerSymbolId: "csrf_exempt", position: 0 });
  });

  it("records a bare decorator as the implicit call `d(f)`", () => {
    const { viewsExtraction } = decoratorScenario(["v"]);
    expect(viewsExtraction.callableArgSources).toEqual({
      [`${VIEWS}::csrf_exempt`]: [{ calleeReceiver: null, argIndex: 0, argument: "v" }],
    });
  });

  it("records a module-level function passed positionally, and not a parameter or a local", () => {
    const code = [
      "def handler(x):",
      "    return x",
      "",
      "def setup(cb):",
      "    local = 1",
      "    register(handler, cb, local)",
      "",
    ].join("\n");
    const e = extract(
      code,
      [
        { symbolId: "handler", startLine: 1, endLine: 2, scope: [] },
        { symbolId: "setup", startLine: 4, endLine: 6, scope: [] },
      ],
      "pkg/setup.py",
    );
    expect(e.callableArgSources).toEqual({
      "pkg/setup.py::register": [{ calleeReceiver: null, argIndex: 0, argument: "handler" }],
    });
  });

  it("feeds only the innermost of stacked decorators the def itself", () => {
    const code = ["@outer", "@inner", "def f():", "    pass", ""].join("\n");
    const e = extract(code, [{ symbolId: "f", startLine: 3, endLine: 4, scope: [] }], "pkg/f.py");
    expect(e.callableArgSources).toEqual({
      "pkg/f.py::inner": [{ calleeReceiver: null, argIndex: 0, argument: "f" }],
    });
  });

  it("does not mark a parameter the owner rebinds", () => {
    const code = ["def deco(fn):", "    fn = wraps(fn)", "    return fn()", ""].join("\n");
    const e = extract(code, [{ symbolId: "deco", startLine: 1, endLine: 3, scope: [] }], "pkg/d.py");
    expect(callIn(e, "deco", "fn").calleeParam).toBeUndefined();
  });
});

describe("resolver — callable-param flow", () => {
  it("resolves the invoked parameter to the ONE function the decorator wraps", () => {
    const { call, ctx } = decoratorScenario(["v"]);
    const resolver = new PythonCallResolver();
    expect(resolver.resolve(call, ctx)).toEqual({ targetRelPath: VIEWS, targetSymbolId: "v" });
  });

  it("fans to every decorated function as `cone` edges when the decorator wraps several", () => {
    const { call, ctx } = decoratorScenario(["v1", "v2", "v3"]);
    const resolver = new PythonCallResolver();
    expect(resolver.resolve(call, ctx)).toBeNull();
    const outcome = resolver.resolveDispatch(call, ctx);
    expect(outcome.kind).toBe("edges");
    if (outcome.kind !== "edges") return;
    expect(outcome.edges.map((e) => e.targetSymbolId).sort()).toEqual(["v1", "v2", "v3"]);
    expect(outcome.edges.every((e) => e.edgeKind === "cone" && e.targetRelPath === VIEWS)).toBe(true);
    expect(outcome.edges[0].confidence).toBeCloseTo(1 / 3);
  });

  it("ignores a source whose callee the passing file binds to a namesake elsewhere", () => {
    const { call, ctx } = decoratorScenario(["v"]);
    const resolver = new PythonCallResolver();
    // The views file no longer imports `csrf_exempt` — its `@csrf_exempt` is
    // some other name, so it feeds nothing into this def.
    expect(resolver.resolve(call, { ...ctx, moduleReexports: {} })).toBeNull();
  });
});

/**
 * The flask `setupmethod` shape (bd tea-rags-mcp-m99j1.1.66): a module-level
 * decorator whose closure calls the parameter, applied BARE to methods of a
 * class in ANOTHER file that reaches it by a relative `from` import. The
 * decoratees are class-body methods (`App#route`), recorded as `App.route`.
 * flask itself has 43 such methods — over the corpus fan cap, so its site is
 * an `ambiguous` verdict there; this pins the channel below the cap.
 */
describe("resolver — callable-param flow, decorator on class-body methods in another file", () => {
  const SCAFFOLD = "pkg/scaffold.py";
  const APP = "pkg/app.py";
  const SCAFFOLD_CODE = [
    "def setupmethod(f):", // 1
    "    def wrapper_func(self, *args):", // 2
    "        return f(self, *args)", // 3
    "    return wrapper_func", // 4
    "",
  ].join("\n");
  const SCAFFOLD_CHUNKS: Chunk[] = [{ symbolId: "setupmethod", startLine: 1, endLine: 4, scope: [] }];
  const APP_CODE = [
    "from .scaffold import setupmethod", // 1
    "", // 2
    "class App:", // 3
    "    @setupmethod", // 4
    "    def route(self, rule):", // 5
    "        return rule", // 6
    "", // 7
    "    @setupmethod", // 8
    "    def add_url_rule(self, rule):", // 9
    "        return rule", // 10
    "",
  ].join("\n");
  const APP_CHUNKS: Chunk[] = [
    { symbolId: "App#route", startLine: 5, endLine: 6, scope: ["App"] },
    { symbolId: "App#add_url_rule", startLine: 9, endLine: 10, scope: ["App"] },
  ];

  it("fans the invoked parameter to every decorated method as `cone` edges", () => {
    const deco = extract(SCAFFOLD_CODE, SCAFFOLD_CHUNKS, SCAFFOLD);
    const app = extract(APP_CODE, APP_CHUNKS, APP);
    // The class itself is a module-level definition of the app file.
    const table = tableOf({
      "pkg/__init__.py": [],
      [SCAFFOLD]: SCAFFOLD_CHUNKS,
      [APP]: [{ symbolId: "App", startLine: 3, endLine: 10, scope: [] }, ...APP_CHUNKS],
    });
    const ctx: CallContext = {
      callerFile: SCAFFOLD,
      callerScope: ["setupmethod", "wrapper_func"],
      callerSymbolId: "setupmethod",
      imports: [],
      symbolTable: table,
      callableArgSources: { ...deco.callableArgSources, ...app.callableArgSources },
      moduleReexports: { [APP]: app.moduleReexports ?? [] },
    };
    const call = callIn(deco, "setupmethod", "f");
    expect(call.calleeParam).toEqual({ ownerSymbolId: "setupmethod", position: 0 });

    const resolver = new PythonCallResolver();
    expect(resolver.resolve(call, ctx)).toBeNull();
    const outcome = resolver.resolveDispatch(call, ctx);
    expect(outcome.kind).toBe("edges");
    if (outcome.kind !== "edges") return;
    expect(outcome.edges.map((e) => e.targetSymbolId).sort()).toEqual(["App#add_url_rule", "App#route"]);
    expect(outcome.edges.every((e) => e.edgeKind === "cone" && e.targetRelPath === APP)).toBe(true);
  });
});

describe("resolver — constructing the enclosing class", () => {
  const APPS = "django/apps/config.py";
  const CODE = [
    "class AppConfig:", // 1
    "    def __init__(self, entry):", // 2
    "        self.entry = entry", // 3
    "    @classmethod", // 4
    "    def create(cls, entry):", // 5
    "        return cls(entry)", // 6
    "    def clone(self):", // 7
    "        a = type(self)(self.entry)", // 8
    "        return self.__class__(self.entry)", // 9
    "",
  ].join("\n");
  const CHUNKS: Chunk[] = [
    { symbolId: "AppConfig", startLine: 1, endLine: 9, scope: [] },
    { symbolId: "AppConfig#__init__", startLine: 2, endLine: 3, scope: ["AppConfig"] },
    { symbolId: "AppConfig.create", startLine: 5, endLine: 6, scope: ["AppConfig"] },
    { symbolId: "AppConfig#clone", startLine: 7, endLine: 9, scope: ["AppConfig"] },
  ];
  const e = extract(CODE, CHUNKS, APPS);
  const ctx = (callerSymbolId: string, method: string): CallContext => ({
    callerFile: APPS,
    callerScope: ["AppConfig", method],
    callerSymbolId,
    imports: [],
    // With the walker's kinds: `AppConfig.create` is a classmethod, not a nested class.
    symbolTable: tableOf({ [APPS]: CHUNKS }, e),
    classAncestors: e.classAncestors,
  });
  const init = { targetRelPath: APPS, targetSymbolId: "AppConfig#__init__" };

  it("`cls(...)` in a classmethod → the enclosing class's __init__", () => {
    const resolver = new PythonCallResolver();
    expect(resolver.resolve(callIn(e, "AppConfig.create", "cls"), ctx("AppConfig.create", "create"))).toEqual(init);
  });

  it("`cls(...)` in an INSTANCE method is a local, not the enclosing class (flask `test_client`)", () => {
    const resolver = new PythonCallResolver();
    const local: CallRef = { callText: "cls(self)", receiver: null, member: "cls", startLine: 8 };
    expect(resolver.resolve(local, ctx("AppConfig#clone", "clone"))).toBeNull();
  });

  it("`type(self)(...)` → the enclosing class's __init__", () => {
    const resolver = new PythonCallResolver();
    expect(resolver.resolve(callIn(e, "AppConfig#clone", "type(self)"), ctx("AppConfig#clone", "clone"))).toEqual(init);
  });

  it("`self.__class__(...)` → the enclosing class's __init__", () => {
    const resolver = new PythonCallResolver();
    expect(resolver.resolve(callIn(e, "AppConfig#clone", "__class__"), ctx("AppConfig#clone", "clone"))).toEqual(init);
  });
});
