/**
 * A dotted constructor spelling `<recv>.<Upper>(…)` names a class only when
 * `<recv>` can be a NAME a module or class is bound by (bd
 * tea-rags-mcp-m99j1.1.85).
 *
 * django's `core/cache/backends/memcached.py` stores an injected MODULE —
 * `self._lib = library` — and its `_cache` property returns
 * `self._lib.Client(self._servers, …)`. The walker recorded that spelling as a
 * type, every reader strips a dotted spelling to its last segment, and with a
 * project class `Client` in the table (`django/test/client.py`)
 * `self._cache.get(…)` resolved to `Client#get` — fabricated. The receiver
 * there is a VALUE: an attribute of `self` (`self._lib`), a parameter, or a
 * computed expression. No project module or class can be named by one, so the
 * result stays UNKNOWN in every channel that reads a constructor:
 *
 *   - the field channel (`self.x = <recv>.Upper()`), both class keys;
 *   - the local channel (`x = <recv>.Upper()`);
 *   - the return channel (`return <recv>.Upper()`, and a field read back);
 *   - the call-argument channel (`f(<recv>.Upper())`).
 *
 * Additive: a receiver that IS a name — `mod.Client()` (an import binding or
 * module alias), `self.Inner()` / `cls.Inner()` (a class attribute) — reads
 * exactly as before.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { AstNode } from "../../../../../../src/core/contracts/types/ast.js";
import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { PythonLanguage } from "../../../../../../src/core/domains/language/python/index.js";
import { pythonInferredReturnReader } from "../../../../../../src/core/domains/language/python/walker/passes/python-ast-type-source.js";

function parse(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(PyLang);
  return parser.parse(src);
}

type Chunk = { symbolId: string; scope: string[]; startLine: number; endLine: number };

function extract(lines: readonly string[], chunks: Chunk[] = []): FileExtraction {
  const code = `${lines.join("\n")}\n`;
  return new PythonLanguage().walker.walk({
    tree: parse(code),
    code,
    relPath: "pkg/cache.py",
    language: "python",
    chunks,
  });
}

/** `self.<field> = <rhs>` inside `Cache.__init__(self, library)`. */
function fieldOf(rhs: string): { short: string | undefined; keyed: string | undefined } {
  const r = extract([
    "import mod",
    "class Cache:",
    "    def __init__(self, library):",
    "        self._lib = library",
    `        self._client = ${rhs}`,
  ]);
  return {
    short: r.classFieldTypes?.Cache?._client,
    keyed: r.classFieldTypesByClassKey?.["pkg/cache.py::Cache"]?._client,
  };
}

/** The type the local `c` is bound to by `c = <rhs>` inside `Cache.get(self, library)`. */
function localOf(rhs: string): string | undefined {
  const r = extract(
    ["import mod", "class Cache:", "    def get(self, library):", `        c = ${rhs}`, "        return c.get(1)"],
    [{ symbolId: "Cache#get", scope: ["Cache"], startLine: 3, endLine: 5 }],
  );
  const bindings = r.chunks[0]?.localBindings?.c ?? [];
  return bindings.find((b) => b.type !== "")?.type;
}

function findDef(node: AstNode, name: string): AstNode | null {
  if (node.type === "function_definition" && node.childForFieldName("name")?.text === name) return node;
  for (const child of node.namedChildren) {
    const found = findDef(child, name);
    if (found !== null) return found;
  }
  return null;
}

/** The inferred return of `Cache._cache`, whose body is `lines`. */
function returnOf(body: readonly string[]): string | null {
  const code = `${[
    "import mod",
    "class Cache:",
    "    def __init__(self, library):",
    "        self._lib = library",
    "    @property",
    "    def _cache(self):",
    ...body.map((line) => `        ${line}`),
  ].join("\n")}\n`;
  const root = parse(code).rootNode as unknown as AstNode;
  const def = findDef(root, "_cache");
  if (def === null) throw new Error("no _cache def");
  return pythonInferredReturnReader(root)(def, "Cache");
}

describe("constructor on a VALUE receiver stays untyped (bd tea-rags-mcp-m99j1.1.85)", () => {
  describe("field channel", () => {
    it("declines `self._client = self._lib.Client(…)` — an attribute of self is a value", () => {
      expect(fieldOf("self._lib.Client(self._servers)")).toEqual({ short: undefined, keyed: undefined });
    });

    it("declines `self._client = library.Client()` — a parameter is a value", () => {
      expect(fieldOf("library.Client()")).toEqual({ short: undefined, keyed: undefined });
    });

    it("declines `self._client = make().Client()` — a computed receiver is a value", () => {
      expect(fieldOf("make().Client()")).toEqual({ short: undefined, keyed: undefined });
    });

    it("keeps `self._client = mod.Client()` — an imported module is a name", () => {
      expect(fieldOf("mod.Client()")).toEqual({ short: "mod.Client", keyed: "mod.Client" });
    });

    it("keeps `self._client = self.Inner()` — a class attribute is a name", () => {
      expect(fieldOf("self.Inner()")).toEqual({ short: "self.Inner", keyed: "self.Inner" });
    });

    it("does not hand the declined spelling to the call-result fold either", () => {
      const r = extract([
        "class Cache:",
        "    def __init__(self, library):",
        "        self._lib = library",
        "        self._client = self._lib.Client()",
      ]);
      expect(r.classFieldCallResults?.["pkg/cache.py::Cache"]?._client).toBeUndefined();
    });
  });

  describe("local channel", () => {
    it("declines `c = self._lib.Client()`", () => {
      expect(localOf("self._lib.Client()")).toBeUndefined();
    });

    it("declines `c = library.Client()` on a parameter", () => {
      expect(localOf("library.Client()")).toBeUndefined();
    });

    it("keeps `c = mod.Client()`", () => {
      expect(localOf("mod.Client()")).toBe("mod.Client");
    });
  });

  describe("call-argument channel", () => {
    /** The argument types recorded at `View(<arg>)` inside `handle(lib)`. */
    const argTypesAt = (arg: string): unknown => {
      const r = extract([
        "import mod",
        "from app.views import View",
        "",
        "def handle(lib):",
        `    return View(${arg})`,
      ]);
      return r.knownTargetCallArgs?.find((site) => site.targets.some((t) => t.endsWith("View#__init__")))?.argTypes;
    };

    it("declines `View(lib.Request())` on a parameter", () => {
      expect(argTypesAt("lib.Request()")).toBeUndefined();
    });

    it("keeps `View(mod.Request())`", () => {
      expect(argTypesAt("mod.Request()")).toEqual([{ form: "instance", name: "mod.Request" }]);
    });
  });

  describe("return channel", () => {
    it("declines `return self._lib.Client(…)`", () => {
      expect(returnOf(["return self._lib.Client(1)"])).toBeNull();
    });

    it("declines a property returning a field written from `self._lib.Client(…)` (the memcached shape)", () => {
      expect(returnOf(["self._client = self._lib.Client(1)", "return self._client"])).toBeNull();
    });

    it("keeps `return mod.Client()`", () => {
      expect(returnOf(["return mod.Client()"])).toBe("Client");
    });
  });
});

/**
 * A function-LOCAL bound to a value is a value receiver too (bd
 * tea-rags-mcp-m99j1.1.88): `lib = load(); lib.Client()` and django's
 * `engine = import_module(settings.SESSION_ENGINE); engine.SessionStore()`
 * construct whatever the bound value holds. A local bound to a NAME
 * (`lib = mod`), an import inside the def, an annotated local, a module-level
 * binding, or a local with any other kind of binding reads exactly as before.
 */
describe("constructor on a function-local VALUE receiver stays untyped (bd tea-rags-mcp-m99j1.1.88)", () => {
  /** `c`'s bound type inside `Cache.get(self)`, whose body is `body` followed by `return c.get(1)`. */
  const localIn = (body: readonly string[], prelude: readonly string[] = []): string | undefined => {
    const lines = [
      "import importlib",
      "import mod",
      ...prelude,
      "class Cache:",
      "    def get(self):",
      ...body.map((line) => `        ${line}`),
      "        return c.get(1)",
    ];
    const start = lines.indexOf("    def get(self):") + 1;
    const r = extract(lines, [{ symbolId: "Cache#get", scope: ["Cache"], startLine: start, endLine: lines.length }]);
    return (r.chunks[0]?.localBindings?.c ?? []).find((b) => b.type !== "")?.type;
  };

  describe("local channel", () => {
    it("declines `lib = load(); c = lib.Client()`", () => {
      expect(localIn(["lib = load()", "c = lib.Client()"])).toBeUndefined();
    });

    it("declines `mod = importlib.import_module(…)` shadowing a module import", () => {
      expect(localIn(["mod = importlib.import_module('x')", "c = mod.Client()"])).toBeUndefined();
    });

    it("declines a dotted chain rooted at the value local (`lib.sub.Client()`)", () => {
      expect(localIn(["lib = load()", "c = lib.sub.Client()"])).toBeUndefined();
    });

    it("declines a local bound to a value in an ENCLOSING def (closure)", () => {
      const r = extract(
        [
          "def outer():",
          "    lib = load()",
          "    def inner():",
          "        c = lib.Client()",
          "        return c.get(1)",
          "    return inner",
        ],
        [{ symbolId: "outer#inner", scope: ["outer"], startLine: 3, endLine: 5 }],
      );
      expect((r.chunks[0]?.localBindings?.c ?? []).find((b) => b.type !== "")?.type).toBeUndefined();
    });

    it("keeps `lib = mod; c = lib.Client()` — an alias of a module name", () => {
      expect(localIn(["lib = mod", "c = lib.Client()"])).toBe("lib.Client");
    });

    it("keeps `import mod as lib` inside the def", () => {
      expect(localIn(["import mod as lib", "c = lib.Client()"])).toBe("lib.Client");
    });

    it("keeps a local with one value and one name binding", () => {
      expect(localIn(["lib = load()", "lib = mod", "c = lib.Client()"])).toBe("lib.Client");
    });

    it("keeps an annotated local (`lib: Mod = load()`)", () => {
      expect(localIn(["lib: Mod = load()", "c = lib.Client()"])).toBe("lib.Client");
    });

    it("keeps a module-level `lib = load()` — no def binds the receiver", () => {
      expect(localIn(["c = lib.Client()"], ["lib = load()"])).toBe("lib.Client");
    });
  });

  it("declines the field channel `self._client = lib.Client()` on a value local", () => {
    const r = extract([
      "class Cache:",
      "    def __init__(self):",
      "        lib = load()",
      "        self._client = lib.Client()",
    ]);
    expect(r.classFieldTypes?.Cache?._client).toBeUndefined();
    expect(r.classFieldTypesByClassKey?.["pkg/cache.py::Cache"]?._client).toBeUndefined();
  });

  it("declines the return channel `return lib.Client()` on a value local", () => {
    expect(returnOf(["lib = load()", "return lib.Client(1)"])).toBeNull();
  });

  it("declines the call-argument channel `View(lib.Request())` on a value local", () => {
    const r = extract([
      "from app.views import View",
      "",
      "def handle():",
      "    lib = load()",
      "    return View(lib.Request())",
    ]);
    const site = r.knownTargetCallArgs?.find((s) => s.targets.some((t) => t.endsWith("View#__init__")));
    expect(site?.argTypes).toBeUndefined();
  });
});

/**
 * A BARE CapWords callee that is itself a def-local bound to a value (bd
 * tea-rags-mcp-m99j1.1.90) — django's oracle `creation.py`
 * `DatabaseWrapper = type(self.connection); return DatabaseWrapper(...)`, or a
 * test's `FormSet = formset_factory(...); FormSet(...)` — names no class: LEGB
 * makes the local shadow every class of that short name, and the local holds
 * whatever the value is at run time. A local aliasing a name
 * (`Wrapper = mod.Client`), an import inside the def, a module-level binding,
 * or no binding at all reads exactly as before.
 */
describe("bare constructor callee that is a function-local VALUE stays untyped (bd tea-rags-mcp-m99j1.1.90)", () => {
  const localIn = (body: readonly string[], prelude: readonly string[] = []): string | undefined => {
    const lines = ["import mod", ...prelude, "class Cache:", "    def get(self):", ...body.map((l) => `        ${l}`)];
    lines.push("        return c.get(1)");
    const start = lines.indexOf("    def get(self):") + 1;
    const r = extract(lines, [{ symbolId: "Cache#get", scope: ["Cache"], startLine: start, endLine: lines.length }]);
    return (r.chunks[0]?.localBindings?.c ?? []).find((b) => b.type !== "")?.type;
  };

  describe("local channel", () => {
    it("declines `Wrapper = type(self.conn); c = Wrapper()`", () => {
      expect(localIn(["Wrapper = type(self.conn)", "c = Wrapper()"])).toBeUndefined();
    });

    it("declines `FormSet = formset_factory(F); c = FormSet()`", () => {
      expect(localIn(["FormSet = formset_factory(F)", "c = FormSet()"])).toBeUndefined();
    });

    it("declines a value local of an ENCLOSING def (closure)", () => {
      const r = extract(
        [
          "def outer():",
          "    Model = apps.get_model('a', 'B')",
          "    def inner():",
          "        c = Model()",
          "        return c.get(1)",
          "    return inner",
        ],
        [{ symbolId: "outer#inner", scope: ["outer"], startLine: 3, endLine: 5 }],
      );
      expect((r.chunks[0]?.localBindings?.c ?? []).find((b) => b.type !== "")?.type).toBeUndefined();
    });

    it("keeps a bare class with no local binding (`c = Client()`)", () => {
      expect(localIn(["c = Client()"])).toBe("Client");
    });

    it("keeps `Wrapper = mod.Client; c = Wrapper()` — an alias of a name", () => {
      expect(localIn(["Wrapper = mod.Client", "c = Wrapper()"])).toBe("Wrapper");
    });

    it("keeps `from mod import Client` inside the def", () => {
      expect(localIn(["from mod import Client", "c = Client()"])).toBe("Client");
    });

    it("keeps a module-level `Client = make()` — no def binds the name", () => {
      expect(localIn(["c = Client()"], ["Client = make()"])).toBe("Client");
    });

    // django admin's hook idiom: `ModelForm = self.get_form(...)` returns the
    // namesake or a subclass of it — measured CORRECT on every resolved row.
    it("keeps `ModelForm = self.get_form(); c = ModelForm()` — a class hook on self", () => {
      expect(localIn(["ModelForm = self.get_form(request)", "c = ModelForm()"])).toBe("ModelForm");
    });

    it("keeps a `cls.<hook>()` binding too", () => {
      expect(localIn(["Form = cls.get_form_class()", "c = Form()"])).toBe("Form");
    });

    it("declines `Model = apps.get_model('a', 'B')` — a migration's historical model", () => {
      expect(localIn(["Model = apps.get_model('a', 'B')", "c = Model()"])).toBeUndefined();
    });
  });

  it("keeps the return channel for `ChangeList = self.get_changelist(r); return ChangeList(r)`", () => {
    expect(returnOf(["ChangeList = self.get_changelist(1)", "return ChangeList(1)"])).toBe("ChangeList");
  });

  it("declines the field channel `self._client = Wrapper()` on a value local", () => {
    const r = extract([
      "class Cache:",
      "    def __init__(self):",
      "        Wrapper = type(self.conn)",
      "        self._client = Wrapper()",
    ]);
    expect(r.classFieldTypes?.Cache?._client).toBeUndefined();
    expect(r.classFieldTypesByClassKey?.["pkg/cache.py::Cache"]?._client).toBeUndefined();
    expect(r.classFieldCallResults?.["pkg/cache.py::Cache"]?._client).toBeUndefined();
  });

  it("declines the return channel (django oracle `_maindb_connection` shape)", () => {
    expect(returnOf(["DatabaseWrapper = type(self._lib)", "return DatabaseWrapper(1)"])).toBeNull();
  });

  it("keeps the return channel for a bare class with no local binding", () => {
    expect(returnOf(["return DatabaseWrapper(1)"])).toBe("DatabaseWrapper");
  });

  it("declines the call-argument channel `View(Req())` on a value local", () => {
    const r = extract([
      "from app.views import View",
      "",
      "def handle():",
      "    Req = make()",
      "    return View(Req())",
    ]);
    const site = r.knownTargetCallArgs?.find((s) => s.targets.some((t) => t.endsWith("View#__init__")));
    expect(site?.argTypes).toBeUndefined();
  });
});
