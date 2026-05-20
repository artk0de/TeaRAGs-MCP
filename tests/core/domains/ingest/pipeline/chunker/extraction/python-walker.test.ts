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
