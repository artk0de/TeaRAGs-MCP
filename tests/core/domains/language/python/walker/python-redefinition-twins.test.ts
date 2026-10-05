/**
 * A plain same-id redefinition's body belongs to the symbol it redefines (bd
 * tea-rags-mcp-m99j1.1.80).
 *
 * Two defs (or classes) that compose the same symbolId — `if/else` platform
 * branches, a nested helper redefined in another branch, a test re-declaring a
 * class — share that id by design, and `collectSymbols` keeps the FIRST range.
 * The later twin therefore had no range of its own and its body calls fell to
 * whatever chunk enclosed it: the enclosing CLASS chunk (read as "no enclosing
 * class"), an enclosing def of the wrong frame, or nothing at all for a
 * top-level twin, whose calls were dropped (django `core/files/locks.py`).
 *
 * The id stays shared and the chunk keeps the first range; only the twin's call
 * sites and def-local channels join the chunk that carries its id, whose scope
 * is the twin's own scope by construction.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { ChunkExtraction, FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { pyNameOf } from "../../../../../../src/core/domains/language/python/walker/name-of.js";
import { extractFromPythonFile } from "../../../../../../src/core/domains/language/python/walker/walker.js";

const composer = new DefaultSymbolIdComposer();

/** The production seam: one parse, `collectSymbols` + `pyNameOf`, then the walker. */
function extract(lines: readonly string[]): FileExtraction {
  const src = lines.join("\n");
  const parser = new Parser();
  parser.setLanguage(PyLang);
  const tree = parser.parse(src);
  return extractFromPythonFile({
    tree,
    code: src,
    relPath: "pkg/mod.py",
    language: "python",
    chunks: collectSymbols(tree, pyNameOf, ".", false, composer),
  });
}

function chunk(out: FileExtraction, symbolId: string): ChunkExtraction {
  const found = out.chunks.filter((c) => c.symbolId === symbolId);
  expect(found).toHaveLength(1);
  return found[0];
}

function callLines(c: ChunkExtraction): number[] {
  return c.calls.map((call) => call.startLine).sort((a, b) => a - b);
}

describe("plain same-id redefinition twins (m99j1.1.80)", () => {
  it("attributes a top-level alternative def's calls to the shared chunk instead of dropping them", () => {
    const out = extract([
      "import fcntl", //                         1
      "def _fd(f):", //                          2
      "    return f", //                         3
      "try:", //                                 4
      "    import fcntl", //                     5
      "except ImportError:", //                  6
      "    def lock(f, flags):", //              7
      "        return False", //                 8
      "else:", //                                9
      "    def lock(f, flags):", //             10
      "        ret = fcntl.flock(_fd(f), flags)", // 11
      "        return ret == 0", //             12
      "",
    ]);
    const lock = chunk(out, "lock");
    expect(callLines(lock)).toEqual([11, 11]);
    expect([lock.startLine, lock.endLine]).toEqual([7, 8]);
    expect(lock.assignedLocals).toContain("ret");
  });

  it("attributes a nested helper redefined in another branch to the helper's chunk, in the helper's scope", () => {
    const out = extract([
      "class View:", //                               1
      "    @classmethod", //                          2
      "    def as_view(cls, name):", //               3
      "        if cls.init_every_request:", //        4
      "            def view(**kwargs):", //           5
      "                self = view.view_class()", //  6
      "                return self.dispatch()", //    7
      "        else:", //                             8
      "            self = cls()", //                  9
      "            def view(**kwargs):", //          10
      "                return run(self.dispatch)", // 11
      "        return view", //                      12
      "",
    ]);
    const view = chunk(out, "View.as_view#view");
    expect(callLines(view)).toEqual([6, 7, 11]);
    expect(callLines(chunk(out, "View.as_view"))).toEqual([9]);
    expect(view.scope).toEqual(["View", "as_view"]);
  });

  it("attributes a sequential redefinition inside one def to the shared nested chunk", () => {
    const out = extract([
      "def test_threads():", //       1
      "    def runner():", //          2
      "        first()", //            3
      "    go(runner)", //             4
      "    def runner():", //          5
      "        second()", //           6
      "    go(runner)", //             7
      "",
    ]);
    expect(callLines(chunk(out, "test_threads#runner"))).toEqual([3, 6]);
    expect(callLines(chunk(out, "test_threads"))).toEqual([4, 7]);
  });

  it("attributes a plain redefinition in a class body to the shared method chunk, in the class scope", () => {
    const out = extract([
      "class Point:", //                1
      "    def x(self):", //             2
      "        return 1", //             3
      "", //                            4
      "    def x(self, value):", //     5
      "        self._cs.put(value)", // 6
      "",
    ]);
    const x = chunk(out, "Point#x");
    expect(callLines(x)).toEqual([6]);
    expect(x.scope).toEqual(["Point"]);
    expect(chunk(out, "Point").calls.map((c) => c.startLine)).not.toContain(6);
  });

  it("attributes a re-declared class's colliding method to the shared method chunk, not to the enclosing test", () => {
    const out = extract([
      "class FormsTest:", //                                  1
      "    def test_dynamic(self):", //                       2
      "        class MyForm(Form):", //                       3
      "            def __init__(self, data=None):", //        4
      "                Form.__init__(self, data)", //         5
      "        check(MyForm())", //                           6
      "        class MyForm(Form):", //                       7
      "            field = CharField()", //                   8
      "            def __init__(self, names=False):", //      9
      "                super().__init__()", //               10
      "                self.fields.update(names)", //        11
      "        check(MyForm())", //                          12
      "",
    ]);
    const init = out.chunks.find((c) => c.symbolId.endsWith("MyForm#__init__"));
    expect(init).toBeDefined();
    expect(callLines(init!)).toEqual([5, 10, 10, 11]);
    expect(init!.scope.at(-1)).toBe("MyForm");
    const form = out.chunks.find((c) => c.symbolId.endsWith("test_dynamic.MyForm"));
    expect(form).toBeDefined();
    expect(callLines(form!)).toContain(8);
    const test = chunk(out, "FormsTest#test_dynamic");
    expect(callLines(test)).toEqual([6, 6, 12, 12]);
  });

  it("leaves a twin class's own unique member on its own chunk", () => {
    const out = extract([
      "def test_app():", //                  1
      "    class Module:", //                 2
      "        app = Flask()", //             3
      "    class Module:", //                 4
      "        @staticmethod", //             5
      "        def create_app():", //         6
      "            return Flask()", //        7
      "",
    ]);
    expect(callLines(chunk(out, "test_app.Module.create_app"))).toEqual([7]);
    expect(callLines(chunk(out, "test_app.Module"))).toContain(3);
    expect(callLines(chunk(out, "test_app"))).toEqual([]);
  });

  it("does not move a def that owns its own id", () => {
    const out = extract([
      "def a():", //   1
      "    b()", //    2
      "def c():", //   3
      "    d()", //    4
      "",
    ]);
    expect(callLines(chunk(out, "a"))).toEqual([2]);
    expect(callLines(chunk(out, "c"))).toEqual([4]);
  });
});
