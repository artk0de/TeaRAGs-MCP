/**
 * Python dict-table dispatch extraction (bd tea-rags-mcp-pbwd, epic 542x) —
 * the Python port of the TypeScript lookup-table suites
 * (`typescript-walker.test.ts` "dispatch tables (n0zj)"). Same contract
 * (`FileExtraction.dispatchTables` / `callbackParams`, `CallRef.dispatch` /
 * `dispatchArgs`), Python idioms: `HANDLERS = {"a": f}; HANDLERS[key](x)`,
 * the nested S1 dict read by subscript (`T[k]["w"](x)`), `dict.get`, and
 * attribute-valued entries (`{"a": Cls.method}`, `{"a": module.fn}`).
 */

import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import { extractFromPythonFile } from "../../../../../../src/core/domains/language/python/walker/walker.js";

type Chunk = { symbolId: string; startLine: number; endLine: number; scope: string[] };

function extract(code: string, chunks: Chunk[] = [], relPath = "pkg/d.py") {
  const parser = new Parser();
  parser.setLanguage(PyLang);
  return extractFromPythonFile({ tree: parser.parse(code), code, relPath, language: "python", chunks });
}

describe("extractFromPythonFile — dict dispatch tables (pbwd)", () => {
  it("records an S2 direct-function table (key→fn)", () => {
    const e = extract(['HANDLERS = {"a": on_a, "b": on_b}', ""].join("\n"));
    expect(e.dispatchTables?.["HANDLERS"]?.entries).toEqual({ a: "on_a", b: "on_b" });
  });

  it("records an S1 nested-dict table (key→field→fn)", () => {
    const e = extract(['T = {"a": {"w": fn_a}, "b": {"w": fn_b}}', ""].join("\n"));
    expect(e.dispatchTables?.["T"]?.entries).toEqual({ a: { w: "fn_a" }, b: { w: "fn_b" } });
  });

  it("records method-valued entries as their dotted spelling", () => {
    const e = extract(['T = {"a": Handlers.on_a, "b": handlers.on_b}', ""].join("\n"));
    expect(e.dispatchTables?.["T"]?.entries).toEqual({ a: "Handlers.on_a", b: "handlers.on_b" });
  });

  it("records an annotated table (`T: dict[str, Callable] = {...}`)", () => {
    const e = extract(['T: dict[str, Callable] = {"a": on_a}', ""].join("\n"));
    expect(e.dispatchTables?.["T"]?.entries).toEqual({ a: "on_a" });
  });

  it("drops lambda / call / literal values per entry, and a table left with none", () => {
    const e = extract(
      ['T = {"a": lambda x: x, "b": make(), "c": on_c, "d": 1}', 'CONFIG = {"a": 1, "b": "x"}', ""].join("\n"),
    );
    expect(e.dispatchTables?.["T"]?.entries).toEqual({ c: "on_c" });
    expect(e.dispatchTables?.["CONFIG"]).toBeUndefined();
  });

  it("keeps a non-string key under a bracketed spelling no string key can collide with", () => {
    const e = extract(["T = {Kind.A: on_a, 1: on_one, **EXTRA}", ""].join("\n"));
    expect(e.dispatchTables?.["T"]?.entries).toEqual({ "[Kind.A]": "on_a", "[1]": "on_one" });
  });

  it("does NOT record a table assigned more than once at module level", () => {
    const e = extract(['T = {"a": on_a}', 'T = {"b": on_b}', ""].join("\n"));
    expect(e.dispatchTables?.["T"]).toBeUndefined();
  });

  it("does NOT record a dict literal assigned inside a function", () => {
    const e = extract(["def go():", '    T = {"a": on_a}', ""].join("\n"), [
      { symbolId: "go", startLine: 1, endLine: 2, scope: [] },
    ]);
    expect(e.dispatchTables).toBeUndefined();
  });

  it("tags S2 direct subscript call: H[k](x)", () => {
    const code = [
      'H = {"a": on_a, "b": on_b}', // 1
      "def go(k):", //               2
      "    H[k](1)", //              3
      "",
    ].join("\n");
    const e = extract(code, [{ symbolId: "go", startLine: 2, endLine: 3, scope: [] }]);
    const call = e.chunks[0].calls.find((c) => c.dispatch);
    expect(call?.dispatch).toEqual({ table: "H", field: null, key: null });
    expect(call?.receiver).toBeNull();
    expect(call?.member).toBe("H");
  });

  it("tags a static string-literal key: H[\"a\"](x) → key 'a'", () => {
    const code = ['H = {"a": on_a, "b": on_b}', "def go():", '    H["a"](1)', ""].join("\n");
    const e = extract(code, [{ symbolId: "go", startLine: 2, endLine: 3, scope: [] }]);
    expect(e.chunks[0].calls.find((c) => c.dispatch)?.dispatch).toEqual({ table: "H", field: null, key: "a" });
  });

  it("treats every non-string index as a dynamic key", () => {
    const code = ['H = {"a": on_a}', "def go(self):", "    H[Kind.A](1)", "    H[0](2)", ""].join("\n");
    const e = extract(code, [{ symbolId: "go", startLine: 2, endLine: 4, scope: [] }]);
    const keys = e.chunks[0].calls.filter((c) => c.dispatch).map((c) => c.dispatch?.key);
    expect(keys).toEqual([null, null]);
  });

  it('tags S1 field selection by subscript: T[k]["w"](x)', () => {
    const code = ['T = {"a": {"w": fn_a}}', "def go(k):", '    T[k]["w"](1)', ""].join("\n");
    const e = extract(code, [{ symbolId: "go", startLine: 2, endLine: 3, scope: [] }]);
    const call = e.chunks[0].calls.find((c) => c.dispatch);
    expect(call?.dispatch).toEqual({ table: "T", field: "w", key: null });
    expect(call?.member).toBe("w");
  });

  it('tags dict.get dispatch: H.get(k)(x) and H.get("a", default)(x)', () => {
    const code = ['H = {"a": on_a}', "def go(k):", "    H.get(k)(1)", '    H.get("a", fallback)(2)', ""].join("\n");
    const e = extract(code, [{ symbolId: "go", startLine: 2, endLine: 4, scope: [] }]);
    const refs = e.chunks[0].calls.filter((c) => c.dispatch).map((c) => c.dispatch);
    expect(refs).toEqual([
      { table: "H", field: null, key: null },
      { table: "H", field: null, key: "a" },
    ]);
  });

  it("tags an entry-bound local: handler = H[k]; handler(x)", () => {
    const code = [
      'H = {"a": on_a}', //            1
      "def go(k):", //                  2
      "    handler = H[k]", //          3
      "    handler(1)", //              4
      "",
    ].join("\n");
    const e = extract(code, [{ symbolId: "go", startLine: 2, endLine: 4, scope: [] }]);
    const call = e.chunks[0].calls.find((c) => c.startLine === 4);
    expect(call?.dispatch).toEqual({ table: "H", field: null, key: null });
  });

  it("tags a `.get`-bound local: handler = H.get(k)", () => {
    const code = ['H = {"a": on_a}', "def go(k):", "    handler = H.get(k)", "    handler(1)", ""].join("\n");
    const e = extract(code, [{ symbolId: "go", startLine: 2, endLine: 4, scope: [] }]);
    expect(e.chunks[0].calls.find((c) => c.startLine === 4)?.dispatch).toEqual({ table: "H", field: null, key: null });
  });

  it("does NOT tag a local rebound to a non-dispatch value before the call", () => {
    const code = [
      'H = {"a": on_a}', //         1
      "def go(k):", //               2
      "    handler = H[k]", //       3
      "    handler = other", //      4
      "    handler(1)", //           5
      "",
    ].join("\n");
    const e = extract(code, [{ symbolId: "go", startLine: 2, endLine: 5, scope: [] }]);
    expect(e.chunks[0].calls.find((c) => c.startLine === 5)?.dispatch).toBeUndefined();
  });

  it("does NOT leak a dispatch-bound local into a sibling function", () => {
    const code = [
      'H = {"a": on_a}', //      1
      "def go(k):", //            2
      "    handler = H[k]", //    3
      "def other():", //          4
      "    handler(1)", //        5
      "",
    ].join("\n");
    const e = extract(code, [
      { symbolId: "go", startLine: 2, endLine: 3, scope: [] },
      { symbolId: "other", startLine: 4, endLine: 5, scope: [] },
    ]);
    expect(e.chunks[1].calls[0]?.dispatch).toBeUndefined();
  });

  it("tags a subscript on a name imported with `from m import T`", () => {
    const code = ["from .registry import HANDLERS", "def go(k):", "    HANDLERS[k](1)", ""].join("\n");
    const e = extract(code, [{ symbolId: "go", startLine: 2, endLine: 3, scope: [] }]);
    expect(e.chunks[0].calls.find((c) => c.dispatch)?.dispatch).toEqual({ table: "HANDLERS", field: null, key: null });
  });

  it("does NOT tag a generic instantiation of an imported CapWords class: Attr[bool](...)", () => {
    // flask's `ConfigAttribute[bool]("TESTING")`, polar's `TypeAdapter[FileRead](FileRead)`.
    const code = [
      "from .config import ConfigAttribute",
      "class App:",
      '    testing = ConfigAttribute[bool]("TESTING")',
      "",
    ].join("\n");
    const e = extract(code, [{ symbolId: "App", startLine: 2, endLine: 3, scope: [] }]);
    expect(e.chunks[0].calls.some((c) => c.dispatch)).toBe(false);
  });

  it("still tags an in-file CapWords table — the dict literal is the evidence", () => {
    const code = ['Handlers = {"a": on_a}', "def go(k):", "    Handlers[k](1)", ""].join("\n");
    const e = extract(code, [{ symbolId: "go", startLine: 2, endLine: 3, scope: [] }]);
    expect(e.chunks[0].calls.find((c) => c.dispatch)?.dispatch).toEqual({ table: "Handlers", field: null, key: null });
  });

  it("does NOT tag a subscript call on a name that is neither a table nor imported", () => {
    const code = ["def go(handlers, k):", "    handlers[k](1)", ""].join("\n");
    const e = extract(code, [{ symbolId: "go", startLine: 1, endLine: 2, scope: [] }]);
    expect(e.chunks[0].calls.some((c) => c.dispatch)).toBe(false);
  });

  it("emits dispatchArgs when a candidate set is passed positionally", () => {
    const code = ['H = {"a": on_a}', "def go(k):", "    run(tree, H[k], opts=1)", ""].join("\n");
    const e = extract(code, [{ symbolId: "go", startLine: 2, endLine: 3, scope: [] }]);
    const call = e.chunks[0].calls.find((c) => c.member === "run");
    expect(call?.dispatchArgs).toEqual([{ argIndex: 1, candidate: { table: "H", field: null, key: null } }]);
  });

  it("records callbackParams for a free function invoking its param", () => {
    const code = ["def run(f, x):", "    f(x)", ""].join("\n");
    const e = extract(code, [{ symbolId: "run", startLine: 1, endLine: 2, scope: [] }]);
    expect(e.callbackParams?.["run"]).toEqual([0]);
  });

  it("records callbackParams for a method in CALL-SITE positions (self is not an argument)", () => {
    const code = ["class C:", "    def m(self, a, cb):", "        cb(a)", ""].join("\n");
    const e = extract(code, [
      { symbolId: "C", startLine: 1, endLine: 3, scope: [] },
      { symbolId: "C#m", startLine: 2, endLine: 3, scope: ["C"] },
    ]);
    expect(e.callbackParams?.["C#m"]).toEqual([1]);
  });

  it("keeps a @staticmethod's first parameter as position 0", () => {
    const code = ["class C:", "    @staticmethod", "    def m(cb):", "        cb()", ""].join("\n");
    const e = extract(code, [
      { symbolId: "C", startLine: 1, endLine: 4, scope: [] },
      { symbolId: "C.m", startLine: 3, endLine: 4, scope: ["C"] },
    ]);
    expect(e.callbackParams?.["C.m"]).toEqual([0]);
  });

  it("stops positional indexing at *args and skips the `/` marker", () => {
    const code = ["def run(a, /, b, *rest, c):", "    b()", "    c()", ""].join("\n");
    const e = extract(code, [{ symbolId: "run", startLine: 1, endLine: 3, scope: [] }]);
    expect(e.callbackParams?.["run"]).toEqual([1]);
  });

  it("does NOT record a param that is never invoked", () => {
    const code = ["def run(f):", "    use(f)", ""].join("\n");
    const e = extract(code, [{ symbolId: "run", startLine: 1, endLine: 2, scope: [] }]);
    expect(e.callbackParams).toBeUndefined();
  });

  it("leaves every dispatch channel absent for a file with no tables and no callbacks", () => {
    const e = extract(["def go(x):", "    x.run()", ""].join("\n"), [
      { symbolId: "go", startLine: 1, endLine: 2, scope: [] },
    ]);
    expect(e.dispatchTables).toBeUndefined();
    expect(e.callbackParams).toBeUndefined();
    expect(e.chunks[0].calls.every((c) => c.dispatch === undefined && c.dispatchArgs === undefined)).toBe(true);
  });
});
