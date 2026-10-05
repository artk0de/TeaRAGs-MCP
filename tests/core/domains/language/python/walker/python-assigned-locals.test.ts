/**
 * The names a `def` binds as LOCALS, typed or not (bd tea-rags-mcp-m99j1.1.57).
 *
 * `localBindings` records only the bindings the walker could TYPE and
 * `callResultBindings` only call results, so "this function assigned the name
 * from an expression nothing types" was unobservable to the resolver. Python's
 * own scoping rule makes a name-only set exact: a name assigned anywhere in a
 * function body is that function's local on EVERY line of it.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { ChunkExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { extractFromPythonFile } from "../../../../../../src/core/domains/language/python/walker/walker.js";

interface ChunkSpec {
  symbolId: string;
  startLine: number;
  endLine: number;
}

function chunksOf(lines: string[], chunks: ChunkSpec[]): ChunkExtraction[] {
  const src = lines.join("\n");
  const parser = new Parser();
  parser.setLanguage(PyLang);
  return extractFromPythonFile({
    tree: parser.parse(src),
    code: src,
    relPath: "app/use.py",
    language: "python",
    chunks: chunks.map((c) => ({ ...c, scope: [] })),
  }).chunks;
}

/** One def chunk spanning the whole snippet. */
function assignedOf(lines: string[]): string[] | undefined {
  return chunksOf(lines, [{ symbolId: "run", startLine: 1, endLine: lines.length }])[0].assignedLocals;
}

describe("extractFromPythonFile — assignedLocals", () => {
  it("records an untyped plain assignment, the shape no typed channel sees", () => {
    expect(
      assignedOf(["def run(platform):", "    client = OAUTH_CLIENTS[platform]", "    client.get_profile()"]),
    ).toEqual(["client"]);
  });

  it("records an attribute-read assignment", () => {
    expect(assignedOf(["def run(self):", "    loader = self.app.jinja_loader", "    loader.list_templates()"])).toEqual(
      ["loader"],
    );
  });

  it("records every binding form, each name once, sorted", () => {
    const lines = [
      "def run(rows):",
      "    a = b = rows[0]",
      "    c, (d, *e) = rows",
      "    [f, g] = rows",
      "    h += 1",
      "    i: Thing = make()",
      "    j: Thing",
      "    for k, l in rows:",
      "        pass",
      "    with open(p) as m, ctx() as (n, o):",
      "        pass",
      "    if (q := rows.pop()):",
      "        pass",
      "    try:",
      "        pass",
      "    except ValueError as r:",
      "        pass",
      "    s = [t for t in rows]",
      "    a = 2",
    ];
    expect(assignedOf(lines)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      "i",
      "j",
      "k",
      "l",
      "m",
      "n",
      "o",
      "q",
      "r",
      "s",
      "t",
    ]);
  });

  it("never records an attribute or subscript target — those bind no name", () => {
    expect(assignedOf(["def run(self, d):", "    self.x = 1", "    d[0] = 2", "    obj.y.z = 3"])).toBeUndefined();
  });

  it("excludes the def's own parameters, reassigned or not", () => {
    expect(
      assignedOf(["def run(self, request, *args, flag=None, **kw):", "    request = wrap(request)", "    x = 1"]),
    ).toEqual(["x"]);
  });

  it("excludes names the def declares `global` or `nonlocal`", () => {
    expect(
      assignedOf([
        "def run():",
        "    global CACHE",
        "    nonlocal hits",
        "    CACHE = {}",
        "    hits = 1",
        "    y = 2",
      ]),
    ).toEqual(["y"]);
  });

  it("does not leak a nested def's or class body's assignments into the outer def", () => {
    const lines = [
      "def outer():",
      "    x = 1",
      "    def inner():",
      "        y = 2",
      "    class K:",
      "        z = 3",
      "    lam = lambda w: w",
    ];
    const [outer] = chunksOf(lines, [{ symbolId: "outer", startLine: 1, endLine: 7 }]);
    expect(outer.assignedLocals).toEqual(["lam", "x"]);
  });

  it("gives a nested def its own locals plus the closure locals of its enclosing defs, minus what it rebinds as a parameter", () => {
    const lines = [
      "def outer():",
      "    x = 1",
      "    item = 2",
      "    def inner(item):",
      "        y = x",
      "        item.go()",
    ];
    const [, inner] = chunksOf(lines, [
      { symbolId: "outer", startLine: 1, endLine: 6 },
      { symbolId: "outer.inner", startLine: 4, endLine: 6 },
    ]);
    expect(inner.assignedLocals).toEqual(["x", "y"]);
  });

  it("publishes nothing on a chunk that is not a def — a class body, a module", () => {
    const lines = ["x = 1", "class K:", "    y = 2"];
    const chunks = chunksOf(lines, [{ symbolId: "K", startLine: 2, endLine: 3 }]);
    expect(chunks[0].assignedLocals).toBeUndefined();
  });

  it("joins a decorated def by its `def` line", () => {
    const lines = ["@decorator", "def run():", "    x = 1"];
    const chunks = chunksOf(lines, [{ symbolId: "run", startLine: 2, endLine: 3 }]);
    expect(chunks[0].assignedLocals).toEqual(["x"]);
  });
});
