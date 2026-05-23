/**
 * python-walker tests — exercise the full matrix of Python import
 * shapes plus call/symbol extraction. Each scenario parses real
 * Python source via tree-sitter-python so the assertions catch
 * grammar drift in the parser, not just regex behaviour.
 */

import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import { extractFromPythonFile } from "../../../../../../../src/core/domains/ingest/pipeline/chunker/extraction/python-walker.js";

function parse(src: string) {
  const parser = new Parser();
  parser.setLanguage(PyLang as unknown as Parser.Language);
  return parser.parse(src);
}

describe("extractFromPythonFile — imports", () => {
  it("captures bare `import X`", () => {
    const tree = parse("import foo\n");
    const r = extractFromPythonFile({ tree, code: "import foo\n", relPath: "a.py", language: "python", chunks: [] });
    expect(r.imports.map((i) => i.importText)).toEqual(["foo"]);
  });

  it("captures dotted `import a.b.c`", () => {
    const tree = parse("import a.b.c\n");
    const r = extractFromPythonFile({ tree, code: "import a.b.c\n", relPath: "x.py", language: "python", chunks: [] });
    expect(r.imports.map((i) => i.importText)).toEqual(["a.b.c"]);
  });

  it("captures aliased imports — module path, alias dropped", () => {
    const src = "import numpy as np\n";
    const tree = parse(src);
    const r = extractFromPythonFile({ tree, code: src, relPath: "x.py", language: "python", chunks: [] });
    expect(r.imports.map((i) => i.importText)).toEqual(["numpy"]);
  });

  it("captures multi-target import `import a, b`", () => {
    const src = "import a, b\n";
    const tree = parse(src);
    const r = extractFromPythonFile({ tree, code: src, relPath: "x.py", language: "python", chunks: [] });
    expect(r.imports.map((i) => i.importText).sort()).toEqual(["a", "b"]);
  });

  it("captures `from X import Y` as the module path X", () => {
    const src = "from foo import bar\n";
    const tree = parse(src);
    const r = extractFromPythonFile({ tree, code: src, relPath: "x.py", language: "python", chunks: [] });
    expect(r.imports.map((i) => i.importText)).toEqual(["foo"]);
  });

  it("captures dotted `from a.b import c`", () => {
    const src = "from a.b import c\n";
    const tree = parse(src);
    const r = extractFromPythonFile({ tree, code: src, relPath: "x.py", language: "python", chunks: [] });
    expect(r.imports.map((i) => i.importText)).toEqual(["a.b"]);
  });

  it("captures relative `from .foo import bar` (one dot)", () => {
    const src = "from .foo import bar\n";
    const tree = parse(src);
    const r = extractFromPythonFile({ tree, code: src, relPath: "pkg/x.py", language: "python", chunks: [] });
    expect(r.imports.map((i) => i.importText)).toEqual([".foo"]);
  });

  it("captures double-relative `from ..foo.bar import baz`", () => {
    const src = "from ..foo.bar import baz\n";
    const tree = parse(src);
    const r = extractFromPythonFile({ tree, code: src, relPath: "pkg/sub/x.py", language: "python", chunks: [] });
    expect(r.imports.map((i) => i.importText)).toEqual(["..foo.bar"]);
  });

  it("captures `from . import foo` (current package, no name)", () => {
    const src = "from . import foo\n";
    const tree = parse(src);
    const r = extractFromPythonFile({ tree, code: src, relPath: "pkg/x.py", language: "python", chunks: [] });
    // The prefix-only `.` is recorded so the resolver can decide
    // how to handle package self-import — it currently returns null.
    expect(r.imports.map((i) => i.importText)).toEqual(["."]);
  });

  it("records startLine per import", () => {
    const src = "\nimport foo\nimport bar\n";
    const tree = parse(src);
    const r = extractFromPythonFile({ tree, code: src, relPath: "x.py", language: "python", chunks: [] });
    expect(r.imports.map((i) => ({ t: i.importText, l: i.startLine }))).toEqual([
      { t: "foo", l: 2 },
      { t: "bar", l: 3 },
    ]);
  });
});

describe("extractFromPythonFile — calls", () => {
  it("captures bare calls without receiver", () => {
    const src = "foo()\n";
    const tree = parse(src);
    const r = extractFromPythonFile({
      tree,
      code: src,
      relPath: "x.py",
      language: "python",
      chunks: [{ symbolId: "m", scope: [], startLine: 1, endLine: 1 }],
    });
    const { calls } = r.chunks[0];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ receiver: null, member: "foo" });
  });

  it("captures attribute calls `obj.method(...)`", () => {
    const src = "obj.method(1, 2)\n";
    const tree = parse(src);
    const r = extractFromPythonFile({
      tree,
      code: src,
      relPath: "x.py",
      language: "python",
      chunks: [{ symbolId: "m", scope: [], startLine: 1, endLine: 1 }],
    });
    const c = r.chunks[0].calls[0];
    expect(c.receiver).toBe("obj");
    expect(c.member).toBe("method");
  });

  it("captures chained attribute calls — receiver = outer object expr", () => {
    const src = "a.b.c()\n";
    const tree = parse(src);
    const r = extractFromPythonFile({
      tree,
      code: src,
      relPath: "x.py",
      language: "python",
      chunks: [{ symbolId: "m", scope: [], startLine: 1, endLine: 1 }],
    });
    const c = r.chunks[0].calls[0];
    expect(c.member).toBe("c");
    expect(c.receiver).toBe("a.b");
  });

  it("groups call sites into chunks by line range", () => {
    const src = "def alpha():\n    foo()\n\ndef beta():\n    bar()\n";
    const tree = parse(src);
    const r = extractFromPythonFile({
      tree,
      code: src,
      relPath: "x.py",
      language: "python",
      chunks: [
        { symbolId: "alpha", scope: [], startLine: 1, endLine: 2 },
        { symbolId: "beta", scope: [], startLine: 4, endLine: 5 },
      ],
    });
    expect(r.chunks[0].calls.map((c) => c.member)).toEqual(["foo"]);
    expect(r.chunks[1].calls.map((c) => c.member)).toEqual(["bar"]);
  });
});

describe("extractFromPythonFile — localBindings (type inference)", () => {
  it("infers var = ClassName(...) → { var: ClassName }", () => {
    const src =
      "def view(request):\n    serializer = ToggleReactionSerializer(data=request.data)\n    return serializer\n";
    const tree = parse(src);
    const r = extractFromPythonFile({
      tree,
      code: src,
      relPath: "engagement/views.py",
      language: "python",
      chunks: [{ symbolId: "view", scope: [], startLine: 1, endLine: 3 }],
    });
    expect(r.chunks[0].localBindings).toEqual({ serializer: "ToggleReactionSerializer" });
  });

  it("infers var = module.ClassName(...) → { var: 'module.ClassName' } (qualifier preserved)", () => {
    const src = "def view():\n    s = rest_framework.Serializer(data=x)\n";
    const tree = parse(src);
    const r = extractFromPythonFile({
      tree,
      code: src,
      relPath: "x.py",
      language: "python",
      chunks: [{ symbolId: "view", scope: [], startLine: 1, endLine: 2 }],
    });
    expect(r.chunks[0].localBindings).toEqual({ s: "rest_framework.Serializer" });
  });

  it("infers PEP 526 annotation var: ClassName = expr → { var: ClassName }", () => {
    const src = "def view():\n    s: ConfirmCode = factory()\n";
    const tree = parse(src);
    const r = extractFromPythonFile({
      tree,
      code: src,
      relPath: "x.py",
      language: "python",
      chunks: [{ symbolId: "view", scope: [], startLine: 1, endLine: 2 }],
    });
    expect(r.chunks[0].localBindings).toEqual({ s: "ConfirmCode" });
  });

  // PEP 526 with qualified type annotation `var: module.ClassName` —
  // exercises extractTypeName's `attribute` branch (python-walker line 277).
  it("infers PEP 526 annotation with qualified `var: module.ClassName`", () => {
    const src = "def view():\n    s: rest_framework.Serializer = factory()\n";
    const tree = parse(src);
    const r = extractFromPythonFile({
      tree,
      code: src,
      relPath: "x.py",
      language: "python",
      chunks: [{ symbolId: "view", scope: [], startLine: 1, endLine: 2 }],
    });
    expect(r.chunks[0].localBindings).toEqual({ s: "rest_framework.Serializer" });
  });

  it("infers PEP 526 annotation without RHS — var: SomeClass", () => {
    const src = "def view():\n    s: SomeClass\n";
    const tree = parse(src);
    const r = extractFromPythonFile({
      tree,
      code: src,
      relPath: "x.py",
      language: "python",
      chunks: [{ symbolId: "view", scope: [], startLine: 1, endLine: 2 }],
    });
    expect(r.chunks[0].localBindings).toEqual({ s: "SomeClass" });
  });

  it("infers function-arg type hint — def f(self, req: HttpRequest)", () => {
    const src = "class View:\n    def post(self, request: HttpRequest):\n        return None\n";
    const tree = parse(src);
    const r = extractFromPythonFile({
      tree,
      code: src,
      relPath: "x.py",
      language: "python",
      chunks: [{ symbolId: "View#post", scope: ["View"], startLine: 2, endLine: 3 }],
    });
    expect(r.chunks[0].localBindings).toEqual({ request: "HttpRequest" });
  });

  it("accumulates multiple bindings in one chunk; later assignment overwrites", () => {
    const src = "def view():\n    s = Foo()\n    s = Bar()\n    t = Baz()\n";
    const tree = parse(src);
    const r = extractFromPythonFile({
      tree,
      code: src,
      relPath: "x.py",
      language: "python",
      chunks: [{ symbolId: "view", scope: [], startLine: 1, endLine: 4 }],
    });
    // s rebound; last assignment wins. t separate binding.
    expect(r.chunks[0].localBindings).toEqual({ s: "Bar", t: "Baz" });
  });

  it("emits binding for bare-identifier RHS calls (resolver decides whether the name is a class)", () => {
    const src = "def view():\n    s = factory()\n    s2 = make_thing()\n";
    const tree = parse(src);
    const r = extractFromPythonFile({
      tree,
      code: src,
      relPath: "x.py",
      language: "python",
      chunks: [{ symbolId: "view", scope: [], startLine: 1, endLine: 3 }],
    });
    // Walker is generous — emit the binding even when the callee
    // looks like a factory. The resolver checks the symbol table
    // (`factory` / `make_thing` as a class?) and drops the binding
    // when the type cannot be located. Keeps walker rules simple.
    expect(r.chunks[0].localBindings?.s).toBe("factory");
    expect(r.chunks[0].localBindings?.s2).toBe("make_thing");
  });

  it("scopes bindings to chunk line range — function A bindings don't leak into function B", () => {
    const src = "def a():\n    s = Foo()\n\ndef b():\n    t = Bar()\n";
    const tree = parse(src);
    const r = extractFromPythonFile({
      tree,
      code: src,
      relPath: "x.py",
      language: "python",
      chunks: [
        { symbolId: "a", scope: [], startLine: 1, endLine: 2 },
        { symbolId: "b", scope: [], startLine: 4, endLine: 5 },
      ],
    });
    expect(r.chunks[0].localBindings).toEqual({ s: "Foo" });
    expect(r.chunks[1].localBindings).toEqual({ t: "Bar" });
  });

  it("does NOT emit localBindings when CODEGRAPH_PY_LOCAL_TYPE_TRACKING=false", () => {
    const prev = process.env.CODEGRAPH_PY_LOCAL_TYPE_TRACKING;
    process.env.CODEGRAPH_PY_LOCAL_TYPE_TRACKING = "false";
    try {
      const src = "def view():\n    s = Foo()\n";
      const tree = parse(src);
      const r = extractFromPythonFile({
        tree,
        code: src,
        relPath: "x.py",
        language: "python",
        chunks: [{ symbolId: "view", scope: [], startLine: 1, endLine: 2 }],
      });
      expect(r.chunks[0].localBindings).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.CODEGRAPH_PY_LOCAL_TYPE_TRACKING;
      else process.env.CODEGRAPH_PY_LOCAL_TYPE_TRACKING = prev;
    }
  });

  it("emits Record (plain object), NOT a Map — survives NDJSON spill round-trip", () => {
    const src = "def view():\n    s = Foo()\n";
    const tree = parse(src);
    const r = extractFromPythonFile({
      tree,
      code: src,
      relPath: "x.py",
      language: "python",
      chunks: [{ symbolId: "view", scope: [], startLine: 1, endLine: 2 }],
    });
    const bindings = r.chunks[0].localBindings;
    // Map serializes to {} via JSON.stringify; plain object preserves entries.
    const roundTripped = JSON.parse(JSON.stringify(bindings ?? {})) as Record<string, string>;
    expect(roundTripped).toEqual({ s: "Foo" });
  });
});

describe("extractFromPythonFile — edge cases", () => {
  it("returns empty imports/chunks for an empty file", () => {
    const tree = parse("");
    const r = extractFromPythonFile({ tree, code: "", relPath: "x.py", language: "python", chunks: [] });
    expect(r.imports).toEqual([]);
    expect(r.chunks).toEqual([]);
  });

  it("survives syntactically-broken source without crashing", () => {
    // Tree-sitter is error-tolerant; the walker must not throw on
    // partial parses. The exact extraction is not asserted — only
    // that it returns a well-formed FileExtraction.
    const src = "from def import )\n";
    const tree = parse(src);
    const r = extractFromPythonFile({ tree, code: src, relPath: "broken.py", language: "python", chunks: [] });
    expect(r.relPath).toBe("broken.py");
    expect(r.language).toBe("python");
  });

  it("ignores comments and docstrings", () => {
    const src = '"""docstring"""\n# import this is not real\nimport foo\n';
    const tree = parse(src);
    const r = extractFromPythonFile({ tree, code: src, relPath: "x.py", language: "python", chunks: [] });
    expect(r.imports.map((i) => i.importText)).toEqual(["foo"]);
  });
});

// bd tea-rags-mcp-zvsw — Decorator application is a call. `@setupmethod`
// on a method means `setupmethod(method)` is invoked at module load. The
// walker must emit a `CallRef` for each decorator so `get_callers("setupmethod")`
// returns every decorated method. Without this, decorator usage is
// invisible to the call graph.
describe("extractFromPythonFile — decorator call edges (bd zvsw)", () => {
  it("emits a call edge per decorator on a top-level function", () => {
    const src = "def setupmethod(f):\n    return f\n\n@setupmethod\ndef route():\n    pass\n";
    const tree = parse(src);
    const r = extractFromPythonFile({
      tree,
      code: src,
      relPath: "x.py",
      language: "python",
      // chunk covers the decorated function (lines 4-5)
      chunks: [{ symbolId: "route", scope: [], startLine: 4, endLine: 5 }],
    });
    const decoratorCall = r.chunks[0].calls.find((c) => c.member === "setupmethod");
    expect(decoratorCall).toBeDefined();
    expect(decoratorCall?.receiver).toBeNull();
  });

  it("emits one call edge per stacked decorator (multi-decorator)", () => {
    const src = "@app.route('/')\n@setupmethod\ndef handler():\n    pass\n";
    const tree = parse(src);
    const r = extractFromPythonFile({
      tree,
      code: src,
      relPath: "x.py",
      language: "python",
      chunks: [{ symbolId: "handler", scope: [], startLine: 1, endLine: 4 }],
    });
    const members = r.chunks[0].calls.map((c) => c.member);
    expect(members).toContain("setupmethod");
    // app.route('/') is a method call on `app` — captured as receiver=app, member=route
    expect(members).toContain("route");
  });

  // Decorator with bare-identifier call form `@cache()` — exercises the
  // `expr.type === "call"` branch where fn.type === "identifier"
  // (python-walker.ts lines 154-155).
  it("emits call edge for `@cache()` (bare identifier called as decorator)", () => {
    const src = "@cache()\ndef compute():\n    pass\n";
    const tree = parse(src);
    const r = extractFromPythonFile({
      tree,
      code: src,
      relPath: "x.py",
      language: "python",
      chunks: [{ symbolId: "compute", scope: [], startLine: 1, endLine: 3 }],
    });
    const decorator = r.chunks[0].calls.find((c) => c.member === "cache");
    expect(decorator).toBeDefined();
    expect(decorator?.receiver).toBeNull();
  });
});

// bd tea-rags-mcp-pic4 — Python walker must populate `classExtends` so
// the resolver can route `super().method()` calls to the parent class.
// Without it, `super().__init__()` in `App(Scaffold)` cannot resolve
// because the resolver has no parent-class lookup.
describe("extractFromPythonFile — classExtends (bd pic4)", () => {
  it("populates classExtends for single-base classes", () => {
    const src = "class Scaffold:\n    pass\n\nclass App(Scaffold):\n    pass\n";
    const tree = parse(src);
    const r = extractFromPythonFile({
      tree,
      code: src,
      relPath: "app.py",
      language: "python",
      chunks: [],
    });
    expect(r.classExtends).toBeDefined();
    expect(r.classExtends?.App).toBe("Scaffold");
  });

  it("captures only the first base class for multi-base classes", () => {
    // Python supports multi-inheritance; we route super() to the first
    // listed base (MRO approximation — sufficient for the common case).
    const src = "class A: pass\nclass B: pass\nclass C(A, B): pass\n";
    const tree = parse(src);
    const r = extractFromPythonFile({
      tree,
      code: src,
      relPath: "x.py",
      language: "python",
      chunks: [],
    });
    expect(r.classExtends?.C).toBe("A");
  });

  it("leaves classExtends undefined or empty when no class extends another", () => {
    const src = "class Foo:\n    pass\n";
    const tree = parse(src);
    const r = extractFromPythonFile({
      tree,
      code: src,
      relPath: "x.py",
      language: "python",
      chunks: [],
    });
    // Either the map is missing entirely or it has no entry for Foo.
    expect(r.classExtends?.Foo).toBeUndefined();
  });
});

// bd tea-rags-mcp-w3pr — Lazy / conditional imports inside function
// bodies. Python's `def f(): from asgiref.sync import async_to_sync as _x;
// _x(...)` is a runtime import. The walker must record the import as a
// SCOPED import — keyed to the enclosing function — so the resolver can
// resolve the inner call without polluting the module-level imports.
describe("extractFromPythonFile — function-scoped imports (bd w3pr)", () => {
  it("captures imports declared inside a function body", () => {
    const src =
      "def async_to_sync(awaitable):\n" +
      "    from asgiref.sync import async_to_sync as _async_to_sync\n" +
      "    return _async_to_sync(awaitable)\n";
    const tree = parse(src);
    const r = extractFromPythonFile({
      tree,
      code: src,
      relPath: "x.py",
      language: "python",
      chunks: [{ symbolId: "async_to_sync", scope: [], startLine: 1, endLine: 3 }],
    });
    // The function-scoped `from asgiref.sync import async_to_sync` must
    // surface as an import — the walker uses tree-walking import
    // collection, so imports inside function bodies are captured into
    // the module-level imports[] list. The resolver then has the
    // context it needs to route the inner call.
    const allImports = r.imports.map((i) => i.importText);
    expect(allImports).toContain("asgiref.sync");
  });
});

// Additional decorator + class-extends edge cases — fill gaps in the
// defensive branches of collectPythonClassExtends / collectPythonDecoratorCalls
// not reached by the primary positive tests.
describe("extractFromPythonFile — decorator edge cases", () => {
  it("@functools.cache bare-attribute decorator → receiver='functools', member='cache'", () => {
    const src = "@functools.cache\ndef expensive():\n    return 1\n";
    const tree = parse(src);
    const r = extractFromPythonFile({
      tree,
      code: src,
      relPath: "dec.py",
      language: "python",
      // Chunk spans BOTH the decorator line and the def line (lines 1-3).
      chunks: [{ symbolId: "expensive", scope: [], startLine: 1, endLine: 3 }],
    });
    const dec = r.chunks[0].calls?.find((c) => c.member === "cache");
    expect(dec).toBeDefined();
    expect(dec?.receiver).toBe("functools");
  });

  it("@app.route('/path') called-attribute decorator → receiver='app', member='route'", () => {
    const src = "@app.route('/path')\ndef handler():\n    return 1\n";
    const tree = parse(src);
    const r = extractFromPythonFile({
      tree,
      code: src,
      relPath: "dec.py",
      language: "python",
      chunks: [{ symbolId: "handler", scope: [], startLine: 1, endLine: 3 }],
    });
    const dec = r.chunks[0].calls?.find((c) => c.member === "route");
    expect(dec).toBeDefined();
    expect(dec?.receiver).toBe("app");
  });

  it("@setupmethod bare-identifier decorator → receiver=null, member='setupmethod'", () => {
    const src = "@setupmethod\ndef handler():\n    return 1\n";
    const tree = parse(src);
    const r = extractFromPythonFile({
      tree,
      code: src,
      relPath: "dec.py",
      language: "python",
      chunks: [{ symbolId: "handler", scope: [], startLine: 1, endLine: 3 }],
    });
    const dec = r.chunks[0].calls?.find((c) => c.member === "setupmethod");
    expect(dec).toBeDefined();
    expect(dec?.receiver).toBeNull();
  });
});

describe("extractFromPythonFile — classExtends edge cases", () => {
  it("base class explicitly `object` is filtered out (`class X(object): ...`)", () => {
    // Python 2 idiom `class Foo(object):` — base text === "object" → skipped.
    const src = "class Foo(object):\n    def bar(self):\n        return 1\n";
    const tree = parse(src);
    const r = extractFromPythonFile({
      tree,
      code: src,
      relPath: "f.py",
      language: "python",
      chunks: [{ symbolId: "Foo", scope: [], startLine: 1, endLine: 3 }],
    });
    // Foo extends object → filtered. classExtends has no entry for Foo.
    expect(r.classExtends?.["Foo"]).toBeUndefined();
  });

  it("class without parens → no classExtends entry (no superclasses field)", () => {
    const src = "class Foo:\n    def bar(self):\n        return 1\n";
    const tree = parse(src);
    const r = extractFromPythonFile({
      tree,
      code: src,
      relPath: "f.py",
      language: "python",
      chunks: [{ symbolId: "Foo", scope: [], startLine: 1, endLine: 3 }],
    });
    expect(r.classExtends?.["Foo"]).toBeUndefined();
  });
});
