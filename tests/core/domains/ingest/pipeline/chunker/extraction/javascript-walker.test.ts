import Parser from "tree-sitter";
import JsLang from "tree-sitter-javascript";
import { describe, expect, it } from "vitest";

import { extractFromJavascriptFile } from "../../../../../../../src/core/domains/ingest/pipeline/chunker/extraction/javascript-walker.js";

function parse(src: string) {
  const parser = new Parser();
  parser.setLanguage(JsLang as unknown as Parser.Language);
  return parser.parse(src);
}

describe("extractFromJavascriptFile — imports", () => {
  it("captures ES module `import x from 'foo'`", () => {
    const src = "import x from 'foo';\n";
    const r = extractFromJavascriptFile({
      tree: parse(src),
      code: src,
      relPath: "a.js",
      language: "javascript",
      chunks: [],
    });
    expect(r.imports.map((i) => i.importText)).toEqual(["foo"]);
  });

  it("captures `import { a, b } from './foo'`", () => {
    const src = "import { a, b } from './foo';\n";
    const r = extractFromJavascriptFile({
      tree: parse(src),
      code: src,
      relPath: "x.js",
      language: "javascript",
      chunks: [],
    });
    expect(r.imports.map((i) => i.importText)).toEqual(["./foo"]);
  });

  it("captures bare `import 'foo'` side-effect imports", () => {
    const src = "import 'foo';\n";
    const r = extractFromJavascriptFile({
      tree: parse(src),
      code: src,
      relPath: "x.js",
      language: "javascript",
      chunks: [],
    });
    expect(r.imports.map((i) => i.importText)).toEqual(["foo"]);
  });

  it("captures CommonJS `require('./foo')`", () => {
    const src = "const x = require('./foo');\n";
    const r = extractFromJavascriptFile({
      tree: parse(src),
      code: src,
      relPath: "x.js",
      language: "javascript",
      chunks: [],
    });
    expect(r.imports.map((i) => i.importText)).toEqual(["./foo"]);
  });

  it("captures dynamic `import('./foo')`", () => {
    const src = "const x = import('./foo');\n";
    const r = extractFromJavascriptFile({
      tree: parse(src),
      code: src,
      relPath: "x.js",
      language: "javascript",
      chunks: [],
    });
    expect(r.imports.map((i) => i.importText)).toEqual(["./foo"]);
  });

  it("records startLine per import", () => {
    const src = "\nimport a from 'a';\nimport b from 'b';\n";
    const r = extractFromJavascriptFile({
      tree: parse(src),
      code: src,
      relPath: "x.js",
      language: "javascript",
      chunks: [],
    });
    expect(r.imports.map((i) => i.startLine)).toEqual([2, 3]);
  });

  it("does NOT capture method calls named require/import", () => {
    // `obj.require(...)` is a method call, not a require statement.
    const src = "obj.require('foo');\n";
    const r = extractFromJavascriptFile({
      tree: parse(src),
      code: src,
      relPath: "x.js",
      language: "javascript",
      chunks: [],
    });
    expect(r.imports).toEqual([]);
  });
});

describe("extractFromJavascriptFile — calls", () => {
  it("captures bare calls without receiver", () => {
    const src = "foo();\n";
    const r = extractFromJavascriptFile({
      tree: parse(src),
      code: src,
      relPath: "x.js",
      language: "javascript",
      chunks: [{ symbolId: "m", scope: [], startLine: 1, endLine: 1 }],
    });
    const c = r.chunks[0].calls[0];
    expect(c).toMatchObject({ receiver: null, member: "foo" });
  });

  it("captures member-expression calls", () => {
    const src = "obj.method(1);\n";
    const r = extractFromJavascriptFile({
      tree: parse(src),
      code: src,
      relPath: "x.js",
      language: "javascript",
      chunks: [{ symbolId: "m", scope: [], startLine: 1, endLine: 1 }],
    });
    const c = r.chunks[0].calls[0];
    expect(c.receiver).toBe("obj");
    expect(c.member).toBe("method");
  });

  it("excludes require/import calls from chunk.calls (they're imports)", () => {
    const src = "function go() {\n  require('./foo');\n  doThing();\n}\n";
    const r = extractFromJavascriptFile({
      tree: parse(src),
      code: src,
      relPath: "x.js",
      language: "javascript",
      chunks: [{ symbolId: "go", scope: [], startLine: 1, endLine: 4 }],
    });
    const callMembers = r.chunks[0].calls.map((c) => c.member);
    expect(callMembers).toEqual(["doThing"]);
  });
});

describe("extractFromJavascriptFile — edge cases", () => {
  it("empty file returns empty extraction", () => {
    const r = extractFromJavascriptFile({
      tree: parse(""),
      code: "",
      relPath: "x.js",
      language: "javascript",
      chunks: [],
    });
    expect(r.imports).toEqual([]);
    expect(r.chunks).toEqual([]);
  });

  it("survives partial parse", () => {
    const src = "import { from\n";
    const r = extractFromJavascriptFile({
      tree: parse(src),
      code: src,
      relPath: "x.js",
      language: "javascript",
      chunks: [],
    });
    expect(r.relPath).toBe("x.js");
  });

  it("ignores comments", () => {
    const src = "// import 'commented';\nimport x from 'foo';\n";
    const r = extractFromJavascriptFile({
      tree: parse(src),
      code: src,
      relPath: "x.js",
      language: "javascript",
      chunks: [],
    });
    expect(r.imports.map((i) => i.importText)).toEqual(["foo"]);
  });
});

// CommonJS require and dynamic import() share the call_expression shape
// but the walker distinguishes them by the function node's type — `require`
// arrives as an identifier, `import()` as the `import` keyword. Co-locating
// both in one file confirms BOTH gates fire and emit imports — not calls.
describe("extractFromJavascriptFile — require vs dynamic import distinguishing path", () => {
  it("captures both require() (identifier) and import() (keyword) as imports in one body", () => {
    const src =
      "function bootstrap() {\n  const a = require('./a');\n  const b = import('./b');\n  return [a, b];\n}\n";
    const r = extractFromJavascriptFile({
      tree: parse(src),
      code: src,
      relPath: "x.js",
      language: "javascript",
      chunks: [{ symbolId: "bootstrap", scope: [], startLine: 1, endLine: 5 }],
    });
    // Both relative paths appear as imports.
    expect(r.imports.map((i) => i.importText).sort()).toEqual(["./a", "./b"]);
    // Neither shows up in chunk.calls — the walker filters identifier
    // `require` AND the `import` callee from collectJsCalls.
    const callMembers = r.chunks[0].calls.map((c) => c.member);
    expect(callMembers).not.toContain("require");
    expect(callMembers).not.toContain("import");
  });

  it("ignores require()/import() with non-string first argument", () => {
    // `require(varName)` has a non-string argument — the walker only
    // captures string-literal specs because dynamic specs can't be
    // resolved statically. Drives the `stringArg` early-return branch.
    const src = "const path = './foo';\nconst x = require(path);\n";
    const r = extractFromJavascriptFile({
      tree: parse(src),
      code: src,
      relPath: "x.js",
      language: "javascript",
      chunks: [],
    });
    expect(r.imports).toEqual([]);
  });

  it("ignores require()/import() with no arguments at all", () => {
    // Pathological code: `require()` with zero args. The walker must
    // not crash — drives the early-return when the args list is empty
    // (no string child found among namedChildren).
    const src = "require();\nimport();\n";
    const r = extractFromJavascriptFile({
      tree: parse(src),
      code: src,
      relPath: "x.js",
      language: "javascript",
      chunks: [],
    });
    expect(r.imports).toEqual([]);
  });

  it("captures only the first string argument of require() — extra args ignored", () => {
    // Some libs pass `require('foo', options)` — only the first string
    // counts as the module spec. Confirms namedChildren.find() picks
    // the first string node it sees.
    const src = "const x = require('./foo', { cache: false });\n";
    const r = extractFromJavascriptFile({
      tree: parse(src),
      code: src,
      relPath: "x.js",
      language: "javascript",
      chunks: [],
    });
    expect(r.imports.map((i) => i.importText)).toEqual(["./foo"]);
  });
});
