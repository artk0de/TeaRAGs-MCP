/**
 * P1 binding forms beyond iteration, walker half (bd tea-rags-mcp-m99j1.1.18,
 * Task 16b): a `with … as name` target carries the CONTEXT expression for the
 * resolver to fold through `__enter__`; an `except E as e` target is an
 * instance of `E`, scoped to its handler; a tuple-unpacking target carries the
 * unpacked expression and its position, or — for a literal tuple — its own
 * element's expression.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { LocalBinding } from "../../../../../../src/core/contracts/types/codegraph.js";
import { extractFromPythonFile } from "../../../../../../src/core/domains/language/python/walker/walker.js";

function bindingsOf(src: string): Record<string, LocalBinding[]> {
  const parser = new Parser();
  parser.setLanguage(PyLang);
  const lines = src.split("\n").length;
  const extraction = extractFromPythonFile({
    tree: parser.parse(src),
    code: src,
    relPath: "app/locks.py",
    language: "python",
    chunks: [{ symbolId: "Worker#run", scope: ["Worker"], startLine: 1, endLine: lines }],
  });
  return extraction.chunks[0].localBindings ?? {};
}

describe("Python walker — context-manager bindings", () => {
  it("`with X() as name` carries the context expression", () => {
    const src = ["class Worker:", "    def run(self):", "        with Lock() as l:", "            l.release()"].join(
      "\n",
    );
    expect(bindingsOf(src).l).toEqual([
      { line: 3, type: "", valueKind: "contextEnter", sourceExpression: "Lock()", endLine: 3 },
    ]);
  });

  it("every item of a multi-item and an `async with` binds its own name", () => {
    const src = [
      "class Worker:",
      "    async def run(self):",
      "        async with Pool() as pool, self.open_session() as session:",
      "            pool.close()",
    ].join("\n");
    const bindings = bindingsOf(src);
    expect(bindings.pool).toEqual([
      { line: 3, type: "", valueKind: "contextEnter", sourceExpression: "Pool()", endLine: 3 },
    ]);
    expect(bindings.session).toEqual([
      { line: 3, type: "", valueKind: "contextEnter", sourceExpression: "self.open_session()", endLine: 3 },
    ]);
  });

  it("a destructuring `as` target binds nothing", () => {
    const src = ["class Worker:", "    def run(self):", "        with pair() as (a, b):", "            a.x()"].join(
      "\n",
    );
    const bindings = bindingsOf(src);
    expect(bindings.a).toBeUndefined();
    expect(bindings.b).toBeUndefined();
  });
});

describe("Python walker — except bindings", () => {
  it("`except E as e` binds an instance of E for the handler's lines only", () => {
    const src = [
      "class Worker:",
      "    def run(self):",
      "        try:",
      "            self.go()",
      "        except ValidationError as e:",
      "            e.update_error_dict({})",
      "            raise",
    ].join("\n");
    expect(bindingsOf(src).e).toEqual([{ line: 5, type: "ValidationError", endLine: 5, scopeEndLine: 7 }]);
  });

  it("a qualified exception class keeps its spelling", () => {
    const src = [
      "class Worker:",
      "    def run(self):",
      "        try:",
      "            self.go()",
      "        except exceptions.ValidationError as err:",
      "            err.update_error_dict({})",
    ].join("\n");
    expect(bindingsOf(src).err).toEqual([{ line: 5, type: "exceptions.ValidationError", endLine: 5, scopeEndLine: 6 }]);
  });

  it("a tuple of exception classes, or a non-class spelling, binds nothing", () => {
    const src = [
      "class Worker:",
      "    def run(self, exc_type):",
      "        try:",
      "            self.go()",
      "        except (KeyError, ValueError) as e:",
      "            e.args",
      "        except exc_type as f:",
      "            f.args",
    ].join("\n");
    const bindings = bindingsOf(src);
    expect(bindings.e).toBeUndefined();
    expect(bindings.f).toBeUndefined();
  });
});

describe("Python walker — tuple-unpacking bindings", () => {
  it("`a, b = f()` binds each name at its position of the unpacked value", () => {
    const src = ["class Worker:", "    def run(self):", "        a, b = make_pair()", "        b.x()"].join("\n");
    const bindings = bindingsOf(src);
    expect(bindings.a).toEqual([
      { line: 3, type: "", valueKind: "tupleElement", sourceExpression: "make_pair()", tupleIndex: 0, endLine: 3 },
    ]);
    expect(bindings.b).toEqual([
      { line: 3, type: "", valueKind: "tupleElement", sourceExpression: "make_pair()", tupleIndex: 1, endLine: 3 },
    ]);
  });

  it("a literal tuple right-hand side binds each name to its own element", () => {
    const src = ["class Worker:", "    def run(self, x):", "        (a, b) = Left(), x", "        a.go()"].join("\n");
    const bindings = bindingsOf(src);
    expect(bindings.a).toEqual([
      { line: 3, type: "", valueKind: "tupleElement", sourceExpression: "Left()", endLine: 3 },
    ]);
    expect(bindings.b).toEqual([{ line: 3, type: "", valueKind: "tupleElement", sourceExpression: "x", endLine: 3 }]);
  });

  it("a starred target, or a literal of another arity, binds nothing", () => {
    const src = ["class Worker:", "    def run(self, z):", "        a, *rest = z", "        c, d = 1, 2, 3"].join("\n");
    const bindings = bindingsOf(src);
    expect(bindings.a).toBeUndefined();
    expect(bindings.rest).toBeUndefined();
    expect(bindings.c).toBeUndefined();
  });
});
