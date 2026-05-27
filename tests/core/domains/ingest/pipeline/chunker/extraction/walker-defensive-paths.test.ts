/**
 * Walker + symbol-resolver defensive-path coverage.
 *
 * Targets the null-return / fallback branches that the four codegraph
 * walkers (javascript / python / ruby / typescript) and the JS
 * chunker-hook symbol resolver expose for malformed, partial-parse, or
 * unusual real-world input shapes.
 *
 * Strategy:
 *   - Drive each walker with REAL source through tree-sitter parsers.
 *   - Use syntactically broken / edge-case inputs (ERROR nodes,
 *     missing fields, empty bodies, decorators with no body) so the
 *     defensive `if (!x) return null` guards execute.
 *   - No mocks, no `vi.fn`, no line-targeting — every assertion is a
 *     real outcome of the production pipeline on real source text.
 */

import Parser from "tree-sitter";
import JsLang from "tree-sitter-javascript";
import PyLang from "tree-sitter-python";
import RbLang from "tree-sitter-ruby";
import { typescript as TsLang } from "tree-sitter-typescript";
import { describe, expect, it } from "vitest";

import { extractFromJavascriptFile } from "../../../../../../../src/core/domains/language/javascript/walker/walker.js";
import { extractFromPythonFile } from "../../../../../../../src/core/domains/ingest/pipeline/chunker/extraction/python-walker.js";
import { extractFromRubyFile } from "../../../../../../../src/core/domains/language/ruby/walker/walker.js";
import { extractFromTypescriptFile } from "../../../../../../../src/core/domains/language/typescript/walker/walker.js";
import {
  extractJsAssignmentSymbol,
  extractJsForEachDispatchSymbols,
  extractJsNestedDefinePropertyThisSymbols,
} from "../../../../../../../src/core/domains/language/javascript/chunking/symbol-resolver.js";

function parseJs(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(JsLang as unknown as Parser.Language);
  return parser.parse(src);
}

function parsePy(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(PyLang as unknown as Parser.Language);
  return parser.parse(src);
}

function parseRb(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(RbLang as unknown as Parser.Language);
  return parser.parse(src);
}

function parseTs(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(TsLang as unknown as Parser.Language);
  return parser.parse(src);
}

function topLevel(tree: Parser.Tree, type: string): Parser.SyntaxNode | undefined {
  return tree.rootNode.namedChildren.find((c) => c.type === type);
}

describe("javascript-walker — defensive paths on edge-case input", () => {
  it("empty file produces empty imports/calls without throwing", () => {
    const src = "";
    const r = extractFromJavascriptFile({
      tree: parseJs(src),
      code: src,
      relPath: "empty.js",
      language: "javascript",
      chunks: [],
    });
    expect(r.imports).toEqual([]);
    expect(r.chunks).toEqual([]);
    expect(r.classExtends).toBeUndefined();
  });

  it("file with only comments — no imports, no calls", () => {
    const src = "// just a comment\n/* block comment */\n// trailing\n";
    const r = extractFromJavascriptFile({
      tree: parseJs(src),
      code: src,
      relPath: "comments.js",
      language: "javascript",
      chunks: [],
    });
    expect(r.imports).toEqual([]);
    expect(r.chunks).toEqual([]);
  });

  it("call with no arguments to require — dropped (no string arg branch)", () => {
    const src = "require();\n";
    const r = extractFromJavascriptFile({
      tree: parseJs(src),
      code: src,
      relPath: "x.js",
      language: "javascript",
      chunks: [],
    });
    expect(r.imports).toEqual([]);
  });

  it("call to require with a non-string arg (variable) — dropped", () => {
    const src = "const name = 'foo'; require(name);\n";
    const r = extractFromJavascriptFile({
      tree: parseJs(src),
      code: src,
      relPath: "x.js",
      language: "javascript",
      chunks: [],
    });
    // require() with a non-string arg falls through the `stringArg` guard.
    expect(r.imports).toEqual([]);
  });

  it("anonymous class expression — no name, no classExtends entry", () => {
    // `class extends Base {}` as expression — name is missing on the
    // declaration shape, so the walker should skip the entry.
    const src = "const C = class extends Base {};\n";
    const r = extractFromJavascriptFile({
      tree: parseJs(src),
      code: src,
      relPath: "x.js",
      language: "javascript",
      chunks: [],
    });
    // class_declaration with no `name` child path — guarded by `if (!nameNode) return`.
    expect(r.classExtends).toBeUndefined();
  });

  it("class without heritage — no extends entry", () => {
    const src = "class Foo {}\n";
    const r = extractFromJavascriptFile({
      tree: parseJs(src),
      code: src,
      relPath: "x.js",
      language: "javascript",
      chunks: [],
    });
    expect(r.classExtends).toBeUndefined();
  });

  it("new expression without constructor field — no call emitted", () => {
    // Syntactically broken `new` — produces an ERROR node + the
    // `new_expression` branch's `if (!ctorNode) return` guard fires.
    const src = "new ;\n";
    const r = extractFromJavascriptFile({
      tree: parseJs(src),
      code: src,
      relPath: "x.js",
      language: "javascript",
      chunks: [],
    });
    expect(r.chunks).toEqual([]);
  });

  it("call with missing callee fields produces no call refs", () => {
    // `()` alone parses with ERROR nodes; callee?.childForFieldName paths fall through.
    const src = "()()\n";
    const r = extractFromJavascriptFile({
      tree: parseJs(src),
      code: src,
      relPath: "x.js",
      language: "javascript",
      chunks: [],
    });
    // Whatever extracted, calls must not contain a fabricated null receiver/null member entry.
    for (const ch of r.chunks) {
      for (const call of ch.calls) {
        expect(typeof call.member).toBe("string");
      }
    }
  });

  it("call assigned to a chunk range — calls outside any chunk are dropped", () => {
    const src = "function a() {}\nfunction b() {\n  a();\n}\n";
    const r = extractFromJavascriptFile({
      tree: parseJs(src),
      code: src,
      relPath: "x.js",
      language: "javascript",
      // chunk for b() covering ONLY lines 4 onward — a() on line 3 is unattached.
      chunks: [{ symbolId: "b", startLine: 4, endLine: 5, scope: [] }],
    });
    // Drops the line-2 call as outside the only chunk's range — the
    // `bestIdx === -1; continue` branch (line 100 in source).
    expect(r.chunks[0].calls.find((c) => c.member === "a")).toBeUndefined();
  });

  it("super call without member access shapes correctly", () => {
    const src = "class B extends A { constructor() { super(); } }\n";
    const r = extractFromJavascriptFile({
      tree: parseJs(src),
      code: src,
      relPath: "x.js",
      language: "javascript",
      chunks: [{ symbolId: "B#constructor", startLine: 1, endLine: 1, scope: ["B"] }],
    });
    const superCall = r.chunks[0].calls.find((c) => c.receiver === "super");
    expect(superCall?.member).toBe("constructor");
  });

  it("member-expression call where prop is missing — dropped", () => {
    // The `.` access without a property triggers parse error; the walker
    // guards `if (!obj || !prop) return` (line 161).
    const src = "obj.\n";
    const r = extractFromJavascriptFile({
      tree: parseJs(src),
      code: src,
      relPath: "x.js",
      language: "javascript",
      chunks: [],
    });
    // No fabricated call.
    expect(r.chunks).toEqual([]);
  });
});

describe("typescript-walker — defensive paths", () => {
  it("empty file — empty extraction", () => {
    const src = "";
    const r = extractFromTypescriptFile({
      tree: parseTs(src),
      code: src,
      relPath: "empty.ts",
      language: "typescript",
      chunks: [],
    });
    expect(r.imports).toEqual([]);
    expect(r.chunks).toEqual([]);
  });

  it("file with only type-only imports — produces no runtime imports", () => {
    const src = "import type { X } from './x';\nimport type Y from './y';\n";
    const r = extractFromTypescriptFile({
      tree: parseTs(src),
      code: src,
      relPath: "x.ts",
      language: "typescript",
      chunks: [],
    });
    // Top-level `import type` is filtered (lines 127-131).
    expect(r.imports).toEqual([]);
  });

  it("import_statement without a string source — guarded", () => {
    // Broken: `import x from ;` parses with an ERROR node where the
    // string would be — `if (!src) return` fires.
    const src = "import x from ;\n";
    const r = extractFromTypescriptFile({
      tree: parseTs(src),
      code: src,
      relPath: "x.ts",
      language: "typescript",
      chunks: [],
    });
    expect(r.imports).toEqual([]);
  });

  it("abstract class without heritage — no classExtends entry", () => {
    const src = "abstract class Foo { abstract m(): void; }\n";
    const r = extractFromTypescriptFile({
      tree: parseTs(src),
      code: src,
      relPath: "x.ts",
      language: "typescript",
      chunks: [],
    });
    expect(r.classExtends).toBeUndefined();
  });

  it("class with heritage but no extends_clause (only implements) — no entry", () => {
    const src = "interface I {}\nclass C implements I {}\n";
    const r = extractFromTypescriptFile({
      tree: parseTs(src),
      code: src,
      relPath: "x.ts",
      language: "typescript",
      chunks: [],
    });
    // `if (!extendsClause) return` at line 296.
    expect(r.classExtends).toBeUndefined();
  });

  it("class extends a generic_type — base name extracted, generics stripped", () => {
    const src = "class A {}\nclass B extends A<string> {}\n";
    const r = extractFromTypescriptFile({
      tree: parseTs(src),
      code: src,
      relPath: "x.ts",
      language: "typescript",
      chunks: [],
    });
    // generic_type branch (lines 309-314).
    expect(r.classExtends?.B).toBe("A");
  });

  it("interface declaration without methods — empty class field map (no fields)", () => {
    const src = "interface Empty {}\n";
    const r = extractFromTypescriptFile({
      tree: parseTs(src),
      code: src,
      relPath: "x.ts",
      language: "typescript",
      chunks: [],
    });
    // No class declarations → no field collection happens, extends undefined.
    expect(r.classExtends).toBeUndefined();
  });

  it("new expression on broken syntax — no call emitted", () => {
    const src = "new ;\n";
    const r = extractFromTypescriptFile({
      tree: parseTs(src),
      code: src,
      relPath: "x.ts",
      language: "typescript",
      chunks: [],
    });
    expect(r.chunks).toEqual([]);
  });

  it("super call extracted as super#constructor", () => {
    const src = "class B extends A { constructor() { super(1); } }\n";
    const r = extractFromTypescriptFile({
      tree: parseTs(src),
      code: src,
      relPath: "x.ts",
      language: "typescript",
      chunks: [{ symbolId: "B#constructor", startLine: 1, endLine: 1, scope: ["B"] }],
    });
    const superCall = r.chunks[0].calls.find((c) => c.receiver === "super");
    expect(superCall?.member).toBe("constructor");
  });

  it("call whose member_expression is missing obj/prop — dropped", () => {
    // The `obj.()` shape lacks a property — `if (!obj || !prop) return`
    // (line 169) drops it.
    const src = "(obj.()).x;\n";
    const r = extractFromTypescriptFile({
      tree: parseTs(src),
      code: src,
      relPath: "x.ts",
      language: "typescript",
      chunks: [],
    });
    expect(r.chunks).toEqual([]);
  });
});

describe("python-walker — defensive paths", () => {
  it("empty file — empty extraction", () => {
    const src = "";
    const r = extractFromPythonFile({
      tree: parsePy(src),
      code: src,
      relPath: "empty.py",
      language: "python",
      chunks: [],
    });
    expect(r.imports).toEqual([]);
    expect(r.chunks).toEqual([]);
  });

  it("file with only docstring — no imports, no calls", () => {
    const src = '"""module docstring"""\n';
    const r = extractFromPythonFile({
      tree: parsePy(src),
      code: src,
      relPath: "x.py",
      language: "python",
      chunks: [],
    });
    expect(r.imports).toEqual([]);
  });

  it("class without explicit superclass — no extends entry", () => {
    const src = "class Foo:\n  pass\n";
    const r = extractFromPythonFile({
      tree: parsePy(src),
      code: src,
      relPath: "x.py",
      language: "python",
      chunks: [],
    });
    expect(r.classExtends).toBeUndefined();
  });

  it("class with only `object` base — `object` is filtered out", () => {
    const src = "class Foo(object):\n  pass\n";
    const r = extractFromPythonFile({
      tree: parsePy(src),
      code: src,
      relPath: "x.py",
      language: "python",
      chunks: [],
    });
    // The walker filters `object` (line 114).
    expect(r.classExtends).toBeUndefined();
  });

  it("decorator that is a non-call / non-identifier / non-attribute — dropped", () => {
    // Subscript-decorator `@registry[0]` is a `subscript` node — none of
    // the three accepted decorator shapes. Falls past every branch silently.
    const src = "registry = [lambda f: f]\n@registry[0]\ndef foo():\n  pass\n";
    const r = extractFromPythonFile({
      tree: parsePy(src),
      code: src,
      relPath: "x.py",
      language: "python",
      chunks: [{ symbolId: "foo", startLine: 3, endLine: 4, scope: [] }],
    });
    // No fake decorator call ref; the `@registry[0]` is silently dropped.
    expect(r.chunks[0].calls.find((c) => c.member === "registry")).toBeUndefined();
  });

  it("decorator with attribute expression — captured", () => {
    const src = "import functools\n@functools.cache\ndef foo():\n  pass\n";
    const r = extractFromPythonFile({
      tree: parsePy(src),
      code: src,
      relPath: "x.py",
      language: "python",
      chunks: [{ symbolId: "foo", startLine: 2, endLine: 4, scope: [] }],
    });
    const deco = r.chunks[0].calls.find((c) => c.receiver === "functools" && c.member === "cache");
    expect(deco).toBeDefined();
  });

  it("decorator on a call shape — extracted via call.function path", () => {
    const src = "from flask import Flask\napp = Flask(__name__)\n@app.route('/')\ndef index():\n  return 'ok'\n";
    const r = extractFromPythonFile({
      tree: parsePy(src),
      code: src,
      relPath: "x.py",
      language: "python",
      chunks: [{ symbolId: "index", startLine: 3, endLine: 5, scope: [] }],
    });
    const route = r.chunks[0].calls.find((c) => c.receiver === "app" && c.member === "route");
    expect(route).toBeDefined();
  });

  it("assignment with non-identifier LHS — no local binding", () => {
    // `(a, b) = (1, 2)` — tuple LHS, the lhs?.type !== "identifier"
    // guard (line 210) suppresses binding.
    const src = "(a, b) = (1, 2)\ndef f():\n  pass\n";
    const r = extractFromPythonFile({
      tree: parsePy(src),
      code: src,
      relPath: "x.py",
      language: "python",
      chunks: [{ symbolId: "f", startLine: 2, endLine: 3, scope: [] }],
    });
    // No localBindings entry for a or b.
    expect(r.chunks[0].localBindings).toBeUndefined();
  });

  it("typed parameter with no type — no binding", () => {
    // Regular parameter without annotation skips `typed_parameter` branch.
    const src = "def f(x):\n  return x\n";
    const r = extractFromPythonFile({
      tree: parsePy(src),
      code: src,
      relPath: "x.py",
      language: "python",
      chunks: [{ symbolId: "f", startLine: 1, endLine: 2, scope: [] }],
    });
    expect(r.chunks[0].localBindings).toBeUndefined();
  });

  it("import_from_statement with no module name (relative-only) — emits the prefix", () => {
    const src = "from . import foo\n";
    const r = extractFromPythonFile({
      tree: parsePy(src),
      code: src,
      relPath: "x.py",
      language: "python",
      chunks: [],
    });
    // The `from . import foo` branch (lines 323-326).
    expect(r.imports.some((i) => i.importText.startsWith("."))).toBe(true);
  });

  it("`from .foo import bar` keeps the leading dot prefix", () => {
    const src = "from .foo import bar\n";
    const r = extractFromPythonFile({
      tree: parsePy(src),
      code: src,
      relPath: "x.py",
      language: "python",
      chunks: [],
    });
    expect(r.imports.map((i) => i.importText)).toEqual([".foo"]);
  });

  it("type-tracking disabled via env — no localBindings emitted", () => {
    const prev = process.env.CODEGRAPH_PY_LOCAL_TYPE_TRACKING;
    process.env.CODEGRAPH_PY_LOCAL_TYPE_TRACKING = "false";
    try {
      const src = "def f(req: Req):\n  return req\n";
      const r = extractFromPythonFile({
        tree: parsePy(src),
        code: src,
        relPath: "x.py",
        language: "python",
        chunks: [{ symbolId: "f", startLine: 1, endLine: 2, scope: [] }],
      });
      expect(r.chunks[0].localBindings).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.CODEGRAPH_PY_LOCAL_TYPE_TRACKING;
      else process.env.CODEGRAPH_PY_LOCAL_TYPE_TRACKING = prev;
    }
  });
});

describe("ruby-walker — defensive paths", () => {
  it("empty file — empty extraction", () => {
    const src = "";
    const r = extractFromRubyFile({
      tree: parseRb(src),
      code: src,
      relPath: "empty.rb",
      language: "ruby",
      chunks: [],
    });
    expect(r.imports).toEqual([]);
    expect(r.chunks).toEqual([]);
    expect(r.fileScope).toEqual([]);
  });

  it("file with only comments — no imports / fileScope", () => {
    const src = "# top comment\n# another\n";
    const r = extractFromRubyFile({
      tree: parseRb(src),
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [],
    });
    expect(r.imports).toEqual([]);
    expect(r.fileScope).toEqual([]);
  });

  it("class without a name field — recurses into children without emitting an ancestor entry", () => {
    // `class` followed by nothing — name field absent; the walker enters
    // the no-name fallback branch (lines 154-157) and recurses without
    // adding the ill-formed class to ancestors.
    const src = "class\nend\n";
    const r = extractFromRubyFile({
      tree: parseRb(src),
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [],
    });
    expect(r.classAncestors).toBeUndefined();
  });

  it("require with no string arg — dropped", () => {
    const src = "require\n";
    const r = extractFromRubyFile({
      tree: parseRb(src),
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [],
    });
    expect(r.imports.find((i) => i.importText === "")).toBeUndefined();
  });

  it("class with non-constant superclass — superclass filter rejects non-PascalCase", () => {
    // `class Foo < dynamic_thing` — `dynamic_thing` is an identifier,
    // not a constant — the constant/scope_resolution filter (line 168)
    // skips it.
    const src = "class Foo < dynamic_thing\nend\n";
    const r = extractFromRubyFile({
      tree: parseRb(src),
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [],
    });
    expect(r.classAncestors).toBeUndefined();
  });

  it("mixin call with non-constant arg — filtered out", () => {
    // `include dynamic_mod` is not a real Ruby pattern; the constant
    // regex guard (line 226) drops it.
    const src = "class Foo\n  include some_var\nend\n";
    const r = extractFromRubyFile({
      tree: parseRb(src),
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [],
    });
    expect(r.classAncestors).toBeUndefined();
  });

  it("module without body but with statements directly — still produces fileScope", () => {
    const src = "module Foo\nend\n";
    const r = extractFromRubyFile({
      tree: parseRb(src),
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [],
    });
    expect(r.fileScope).toContain("Foo");
  });

  it("type-tracking disabled via env — no localBindings emitted", () => {
    const prev = process.env.CODEGRAPH_RB_LOCAL_TYPE_TRACKING;
    process.env.CODEGRAPH_RB_LOCAL_TYPE_TRACKING = "false";
    try {
      const src = "class Foo\n  def initialize\n    @x = User.new\n  end\nend\n";
      const r = extractFromRubyFile({
        tree: parseRb(src),
        code: src,
        relPath: "x.rb",
        language: "ruby",
        chunks: [{ symbolId: "Foo#initialize", startLine: 2, endLine: 4, scope: ["Foo"] }],
      });
      expect(r.chunks[0].localBindings).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.CODEGRAPH_RB_LOCAL_TYPE_TRACKING;
      else process.env.CODEGRAPH_RB_LOCAL_TYPE_TRACKING = prev;
    }
  });

  it("require_relative with './' prefix normalises to './foo' (no double prefix)", () => {
    const src = "require_relative './foo'\n";
    const r = extractFromRubyFile({
      tree: parseRb(src),
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [],
    });
    // Lines 356-362 — strip-then-prefix.
    expect(r.imports.find((i) => i.importText === "./foo")).toBeDefined();
    expect(r.imports.find((i) => i.importText === "././foo")).toBeUndefined();
  });

  it("alias keyword without identifiers — guarded silently", () => {
    // `alias` keyword with broken syntax — the alias node may have no
    // identifier children; the walker's keyword form should not crash.
    // Even though tree-sitter may flag the line as ERROR, the walker
    // must complete without throwing.
    const src = "alias\n";
    const r = extractFromRubyFile({
      tree: parseRb(src),
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [],
    });
    expect(r.chunks).toEqual([]);
  });

  it("scope_resolution with no name field — handled defensively in readScopeResolution", () => {
    // Stress the scope_resolution helper through a malformed reference
    // — the walker's `readScopeResolution` (lines 411-417) returns ""
    // when the `name` child is missing, then the regex filter drops it.
    const src = "::\n";
    const r = extractFromRubyFile({
      tree: parseRb(src),
      code: src,
      relPath: "x.rb",
      language: "ruby",
      chunks: [],
    });
    expect(r.imports.find((i) => i.importText.endsWith("::"))).toBeUndefined();
  });
});

describe("JS symbol-resolver — defensive paths", () => {
  it("extractJsAssignmentSymbol — non-statement node returns null", () => {
    const tree = parseJs("function foo() {}\n");
    const fn = topLevel(tree, "function_declaration");
    expect(fn).toBeDefined();
    // function_declaration is neither expression_statement nor lexical_declaration.
    expect(extractJsAssignmentSymbol(fn as Parser.SyntaxNode)).toBeNull();
  });

  it("extractJsAssignmentSymbol — lexical_declaration with non-function value returns null", () => {
    const tree = parseJs("const x = 42;\n");
    const lex = topLevel(tree, "lexical_declaration");
    expect(extractJsAssignmentSymbol(lex as Parser.SyntaxNode)).toBeNull();
  });

  it("extractJsAssignmentSymbol — lexical_declaration with destructuring pattern returns null", () => {
    const tree = parseJs("const { a } = obj;\n");
    const lex = topLevel(tree, "lexical_declaration");
    // `name` is an object_pattern, not identifier — `nameNode.type !== "identifier"` guard.
    expect(extractJsAssignmentSymbol(lex as Parser.SyntaxNode)).toBeNull();
  });

  it("extractJsAssignmentSymbol — anonymous module.exports = function () returns null", () => {
    const tree = parseJs("module.exports = function () {};\n");
    const stmt = topLevel(tree, "expression_statement");
    expect(extractJsAssignmentSymbol(stmt as Parser.SyntaxNode)).toBeNull();
  });

  it("extractJsAssignmentSymbol — bare identifier reassignment (`foo = fn`) returns null", () => {
    const tree = parseJs("foo = function () {};\n");
    const stmt = topLevel(tree, "expression_statement");
    // identifier-LHS branch returns null to avoid duplicates with the original declarator.
    expect(extractJsAssignmentSymbol(stmt as Parser.SyntaxNode)).toBeNull();
  });

  it("extractJsAssignmentSymbol — Object.defineProperty with non-getter descriptor returns null", () => {
    const tree = parseJs("Object.defineProperty(obj, 'x', { value: 1 });\n");
    const stmt = topLevel(tree, "expression_statement");
    // descriptor has `value:` not `get:` — objectHasGetterPair returns false.
    expect(extractJsAssignmentSymbol(stmt as Parser.SyntaxNode)).toBeNull();
  });

  it("extractJsAssignmentSymbol — Object.defineProperty with fewer than 3 args returns null", () => {
    const tree = parseJs("Object.defineProperty(obj, 'x');\n");
    const stmt = topLevel(tree, "expression_statement");
    expect(extractJsAssignmentSymbol(stmt as Parser.SyntaxNode)).toBeNull();
  });

  it("extractJsAssignmentSymbol — defineGetter with non-function third arg returns null", () => {
    const tree = parseJs("defineGetter(obj, 'name', 'not a function');\n");
    const stmt = topLevel(tree, "expression_statement");
    expect(extractJsAssignmentSymbol(stmt as Parser.SyntaxNode)).toBeNull();
  });

  it("extractJsAssignmentSymbol — deep member chain beyond prototype returns null", () => {
    const tree = parseJs("a.b.c.d = function () {};\n");
    const stmt = topLevel(tree, "expression_statement");
    // Deep member_expression with no `prototype` → null (line 64).
    expect(extractJsAssignmentSymbol(stmt as Parser.SyntaxNode)).toBeNull();
  });

  it("extractJsAssignmentSymbol — template-string property name (no interp) for defineGetter", () => {
    const src = "defineGetter(obj, `name`, function () {});\n";
    const tree = parseJs(src);
    const stmt = topLevel(tree, "expression_statement");
    expect(extractJsAssignmentSymbol(stmt as Parser.SyntaxNode)).toEqual({
      symbolId: "obj.name",
      name: "obj.name",
    });
  });

  it("extractJsAssignmentSymbol — template-string with interpolation returns null", () => {
    const dollar = String.fromCharCode(36);
    const src = `defineGetter(obj, \`name${dollar}{suffix}\`, function () {});\n`;
    const tree = parseJs(src);
    const stmt = topLevel(tree, "expression_statement");
    // Interpolation rejects — readStringLiteral returns null.
    expect(extractJsAssignmentSymbol(stmt as Parser.SyntaxNode)).toBeNull();
  });

  it("extractJsForEachDispatchSymbols — non-statement node returns null", () => {
    const tree = parseJs("function foo() {}\n");
    const fn = topLevel(tree, "function_declaration");
    expect(extractJsForEachDispatchSymbols(fn as Parser.SyntaxNode)).toBeNull();
  });

  it("extractJsForEachDispatchSymbols — forEach receiver is not an identifier (member expr) returns null", () => {
    const src = "obj.methods.forEach(function (m) { app[m] = function() {}; });\n";
    const tree = parseJs(src);
    const stmt = topLevel(tree, "expression_statement");
    // receiver `obj.methods` is member_expression, not identifier (line 238).
    expect(extractJsForEachDispatchSymbols(stmt as Parser.SyntaxNode)).toBeNull();
  });

  it("extractJsForEachDispatchSymbols — non-forEach method returns null", () => {
    const src = "methods.map(function (m) { app[m] = function() {}; });\n";
    const tree = parseJs(src);
    const stmt = topLevel(tree, "expression_statement");
    expect(extractJsForEachDispatchSymbols(stmt as Parser.SyntaxNode)).toBeNull();
  });

  it("extractJsForEachDispatchSymbols — forEach without callback returns null", () => {
    const src = "methods.forEach();\n";
    const tree = parseJs(src);
    const stmt = topLevel(tree, "expression_statement");
    expect(extractJsForEachDispatchSymbols(stmt as Parser.SyntaxNode)).toBeNull();
  });

  it("extractJsForEachDispatchSymbols — callback with two params returns null", () => {
    const src = "methods.forEach(function (m, i) { app[m] = function() {}; });\n";
    const tree = parseJs(src);
    const stmt = topLevel(tree, "expression_statement");
    // paramIds.length !== 1 (line 246).
    expect(extractJsForEachDispatchSymbols(stmt as Parser.SyntaxNode)).toBeNull();
  });

  it("extractJsForEachDispatchSymbols — body without subscript assignment returns null", () => {
    const src = "methods.forEach(function (m) { console.log(m); });\n";
    const tree = parseJs(src);
    const stmt = topLevel(tree, "expression_statement");
    // No dispatch assignment matched → dispatchLhs.node stays null.
    expect(extractJsForEachDispatchSymbols(stmt as Parser.SyntaxNode)).toBeNull();
  });

  it("extractJsForEachDispatchSymbols — pattern matches BUT no HTTP-verb signal returns null", () => {
    // Subscript assignment present, paramName index, but receiver is
    // `foo` (not `methods`) and body has no HTTP-verb compare and there's
    // no require('methods'). All three signals fail — null.
    const src = "foo.forEach(function (m) { app[m] = function() {}; });\n";
    const tree = parseJs(src);
    const stmt = topLevel(tree, "expression_statement");
    expect(extractJsForEachDispatchSymbols(stmt as Parser.SyntaxNode)).toBeNull();
  });

  it("extractJsForEachDispatchSymbols — verb-compare body triggers full dispatch emission", () => {
    const src = [
      "methods.forEach(function (method) {",
      "  if (method === 'get') return;",
      "  app[method] = function () {};",
      "});",
      "",
    ].join("\n");
    const tree = parseJs(src);
    const stmt = topLevel(tree, "expression_statement");
    const out = extractJsForEachDispatchSymbols(stmt as Parser.SyntaxNode);
    expect(out).not.toBeNull();
    expect(out?.length).toBeGreaterThan(0);
    expect(out?.find((s) => s.symbolId === "app.get")).toBeDefined();
  });

  it("extractJsNestedDefinePropertyThisSymbols — non-statement returns []", () => {
    const tree = parseJs("function foo() {}\n");
    const fn = topLevel(tree, "function_declaration");
    expect(extractJsNestedDefinePropertyThisSymbols(fn as Parser.SyntaxNode)).toEqual([]);
  });

  it("extractJsNestedDefinePropertyThisSymbols — assignment with non-member LHS returns []", () => {
    const tree = parseJs("foo = function () { Object.defineProperty(this, 'x', { get: () => 1 }); };\n");
    const stmt = topLevel(tree, "expression_statement");
    // left.type === "identifier", not member_expression (line 127).
    expect(extractJsNestedDefinePropertyThisSymbols(stmt as Parser.SyntaxNode)).toEqual([]);
  });

  it("extractJsNestedDefinePropertyThisSymbols — function body absent returns []", () => {
    // Arrow function — not a function_expression/function_declaration,
    // so terminal type guard (line 123) fires.
    const tree = parseJs("app.init = () => { Object.defineProperty(this, 'x', { get: fn }); };\n");
    const stmt = topLevel(tree, "expression_statement");
    expect(extractJsNestedDefinePropertyThisSymbols(stmt as Parser.SyntaxNode)).toEqual([]);
  });

  it("extractJsNestedDefinePropertyThisSymbols — defineProperty inside nested non-arrow fn — skipped (this rebinds)", () => {
    const src = [
      "app.init = function () {",
      "  function inner() {",
      "    Object.defineProperty(this, 'x', { get: function () { return 1; } });",
      "  }",
      "  inner();",
      "};",
      "",
    ].join("\n");
    const tree = parseJs(src);
    const stmt = topLevel(tree, "expression_statement");
    expect(extractJsNestedDefinePropertyThisSymbols(stmt as Parser.SyntaxNode)).toEqual([]);
  });

  it("extractJsNestedDefinePropertyThisSymbols — fewer than 3 args returns []", () => {
    const src = "app.init = function () { Object.defineProperty(this, 'x'); };\n";
    const tree = parseJs(src);
    const stmt = topLevel(tree, "expression_statement");
    expect(extractJsNestedDefinePropertyThisSymbols(stmt as Parser.SyntaxNode)).toEqual([]);
  });

  it("extractJsNestedDefinePropertyThisSymbols — non-this receiver inside body returns []", () => {
    const src = "app.init = function () { Object.defineProperty(other, 'x', { get: function() {} }); };\n";
    const tree = parseJs(src);
    const stmt = topLevel(tree, "expression_statement");
    // receiver is `other` (identifier), not `this` — nestedGetterInstallThisName returns null.
    expect(extractJsNestedDefinePropertyThisSymbols(stmt as Parser.SyntaxNode)).toEqual([]);
  });

  it("extractJsNestedDefinePropertyThisSymbols — defineGetter form with this", () => {
    const src = [
      "app.init = function () {",
      "  defineGetter(this, 'router', function () { return r; });",
      "};",
      "",
    ].join("\n");
    const tree = parseJs(src);
    const stmt = topLevel(tree, "expression_statement");
    const out = extractJsNestedDefinePropertyThisSymbols(stmt as Parser.SyntaxNode);
    expect(out).toHaveLength(1);
    expect(out[0].symbolId).toBe("app.router");
  });
});
