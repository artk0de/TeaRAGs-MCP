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

// BUG tea-rags-mcp-otjs — mirror of Ruby tea-rags-mcp-8fnu fix. The walker
// must attribute each call to ONE chunk only — the smallest containing
// line range, ties broken by deeper scope. Without this, a call inside a
// class method lands on both the class chunk AND the method chunk, doubling
// caller-edge counts. Same root cause and same fix shape as the TS walker.
describe("extractFromJavascriptFile — innermost-chunk call attribution (bd tea-rags-mcp-otjs)", () => {
  it("assigns each call to only the innermost containing chunk (class + method)", () => {
    const src = ["class Resolver {", "  resolve() {", "    pickOne(a, b);", "  }", "}", ""].join("\n");
    const r = extractFromJavascriptFile({
      tree: parse(src),
      code: src,
      relPath: "src/resolver.js",
      language: "javascript",
      chunks: [
        { symbolId: "Resolver", startLine: 1, endLine: 5, scope: [] },
        { symbolId: "Resolver#resolve", startLine: 2, endLine: 4, scope: ["Resolver"] },
      ],
    });
    const method = r.chunks.find((c) => c.symbolId === "Resolver#resolve");
    const cls = r.chunks.find((c) => c.symbolId === "Resolver");
    expect(method?.calls.map((c) => c.member)).toContain("pickOne");
    expect(cls?.calls.filter((c) => c.member === "pickOne")).toEqual([]);
  });

  it("routes constructor and method calls to their own enclosing chunks", () => {
    const src = [
      "class Service {",
      "  constructor() {",
      "    initLogger();",
      "  }",
      "  run() {",
      "    doWork();",
      "  }",
      "}",
      "",
    ].join("\n");
    const r = extractFromJavascriptFile({
      tree: parse(src),
      code: src,
      relPath: "src/service.js",
      language: "javascript",
      chunks: [
        { symbolId: "Service", startLine: 1, endLine: 8, scope: [] },
        { symbolId: "Service#constructor", startLine: 2, endLine: 4, scope: ["Service"] },
        { symbolId: "Service#run", startLine: 5, endLine: 7, scope: ["Service"] },
      ],
    });
    const ctor = r.chunks.find((c) => c.symbolId === "Service#constructor");
    const run = r.chunks.find((c) => c.symbolId === "Service#run");
    const cls = r.chunks.find((c) => c.symbolId === "Service");
    expect(ctor?.calls.map((c) => c.member)).toEqual(["initLogger"]);
    expect(run?.calls.map((c) => c.member)).toEqual(["doWork"]);
    expect(cls?.calls.filter((c) => c.member === "initLogger" || c.member === "doWork")).toEqual([]);
  });

  it("keeps top-level function calls in the function chunk (no class scope)", () => {
    const src = ["function postProcess() {", "  doX();", "}", ""].join("\n");
    const r = extractFromJavascriptFile({
      tree: parse(src),
      code: src,
      relPath: "src/p.js",
      language: "javascript",
      chunks: [{ symbolId: "postProcess", startLine: 1, endLine: 3, scope: [] }],
    });
    expect(r.chunks[0].calls.map((c) => c.member)).toEqual(["doX"]);
  });

  it("does not cross-contaminate calls between sibling methods", () => {
    const src = [
      "class RankModule {",
      "  rankChunks() {",
      "    rerank();",
      "  }",
      "  rankFiles() {",
      "    sortFiles();",
      "  }",
      "}",
      "",
    ].join("\n");
    const r = extractFromJavascriptFile({
      tree: parse(src),
      code: src,
      relPath: "src/rank.js",
      language: "javascript",
      chunks: [
        { symbolId: "RankModule", startLine: 1, endLine: 8, scope: [] },
        { symbolId: "RankModule#rankChunks", startLine: 2, endLine: 4, scope: ["RankModule"] },
        { symbolId: "RankModule#rankFiles", startLine: 5, endLine: 7, scope: ["RankModule"] },
      ],
    });
    const rc = r.chunks.find((c) => c.symbolId === "RankModule#rankChunks");
    const rf = r.chunks.find((c) => c.symbolId === "RankModule#rankFiles");
    const cls = r.chunks.find((c) => c.symbolId === "RankModule");
    expect(rc?.calls.map((c) => c.member)).toEqual(["rerank"]);
    expect(rf?.calls.map((c) => c.member)).toEqual(["sortFiles"]);
    expect(cls?.calls.filter((c) => c.member === "rerank" || c.member === "sortFiles")).toEqual([]);
  });

  it("breaks innermost-chunk ties by deeper scope (longer scope wins)", () => {
    const src = ["class A {", "  m() {", "    x();", "  }", "}", ""].join("\n");
    const r = extractFromJavascriptFile({
      tree: parse(src),
      code: src,
      relPath: "src/a.js",
      language: "javascript",
      chunks: [
        { symbolId: "A", startLine: 1, endLine: 4, scope: [] },
        { symbolId: "A#m", startLine: 2, endLine: 5, scope: ["A"] },
      ],
    });
    const inner = r.chunks.find((c) => c.symbolId === "A#m");
    const outer = r.chunks.find((c) => c.symbolId === "A");
    expect(inner?.calls.map((c) => c.member)).toContain("x");
    expect(outer?.calls.filter((c) => c.member === "x")).toEqual([]);
  });

  // bd tea-rags-mcp-i252 — JS mirror of the TS walker fix. `new
  // ClassName(args)` must surface as a CallRef so the resolver routes
  // it to ClassName#constructor.
  describe("new ClassName(args) constructor calls (bd tea-rags-mcp-i252)", () => {
    it("emits 'new RankModule(a)' with receiver='RankModule' member='constructor'", () => {
      const src = ["function build() {", "  return new RankModule(a);", "}", ""].join("\n");
      const r = extractFromJavascriptFile({
        tree: parse(src),
        code: src,
        relPath: "src/build.js",
        language: "javascript",
        chunks: [{ symbolId: "build", startLine: 1, endLine: 3, scope: [] }],
      });
      const calls = r.chunks[0]?.calls ?? [];
      const newCall = calls.find((c) => c.callText.startsWith("new RankModule"));
      expect(newCall).toBeDefined();
      expect(newCall?.receiver).toBe("RankModule");
      expect(newCall?.member).toBe("constructor");
    });

    it("preserves qualified class names: 'new ns.Foo()' → receiver='ns.Foo'", () => {
      const src = ["function build() {", "  return new ns.Foo();", "}", ""].join("\n");
      const r = extractFromJavascriptFile({
        tree: parse(src),
        code: src,
        relPath: "src/build.js",
        language: "javascript",
        chunks: [{ symbolId: "build", startLine: 1, endLine: 3, scope: [] }],
      });
      const calls = r.chunks[0]?.calls ?? [];
      const newCall = calls.find((c) => c.callText.startsWith("new ns.Foo"));
      expect(newCall).toBeDefined();
      expect(newCall?.receiver).toBe("ns.Foo");
      expect(newCall?.member).toBe("constructor");
    });
  });
});

// bd tea-rags-mcp-3a84 — mirror of the TS walker fix. Bare `super(arg)` inside
// a constructor was emitted as a free call `{ receiver: null, member: "super" }`
// because the call's `function` field is the `super` keyword node (no member
// expression). The resolver then looked up `super` by short-name, found
// nothing, and dropped the edge. Emit as `{ receiver: "super",
// member: "constructor" }` so the JS resolver's super-branch can route
// to the PARENT class's constructor via classExtends.
describe("extractFromJavascriptFile — super() constructor calls (bd tea-rags-mcp-3a84)", () => {
  it("emits super() as receiver='super' member='constructor', not as a free call", () => {
    const src = `class Child extends Base {\n  constructor() { super(arg); }\n}\n`;
    const r = extractFromJavascriptFile({
      tree: parse(src),
      code: src,
      relPath: "src/child.js",
      language: "javascript",
      chunks: [{ symbolId: "Child#constructor", startLine: 2, endLine: 2, scope: ["Child"] }],
    });
    const calls = r.chunks[0]?.calls ?? [];
    const superCall = calls.find((c) => c.callText.startsWith("super("));
    expect(superCall).toBeDefined();
    expect(superCall?.receiver).toBe("super");
    expect(superCall?.member).toBe("constructor");
  });

  it("does not regress super.method() — still receiver='super' member=<methodName>", () => {
    const src = `class Child extends Base {\n  foo() { super.foo(); }\n}\n`;
    const r = extractFromJavascriptFile({
      tree: parse(src),
      code: src,
      relPath: "src/child.js",
      language: "javascript",
      chunks: [{ symbolId: "Child#foo", startLine: 2, endLine: 2, scope: ["Child"] }],
    });
    const calls = r.chunks[0]?.calls ?? [];
    const superCall = calls.find((c) => c.member === "foo" && c.receiver === "super");
    expect(superCall).toBeDefined();
  });
});

// bd tea-rags-mcp-d29r — Walker must extract `class Child extends Parent`
// relationships so the resolver can route `super()` calls to the PARENT
// class instead of self-looping back to the enclosing class's own
// constructor. JS has identical single-inheritance shape to TS.
describe("extractFromJavascriptFile — classExtends (bd tea-rags-mcp-d29r)", () => {
  it("records direct extends: class B extends A", () => {
    const src = `class A {}\nclass B extends A {}\n`;
    const r = extractFromJavascriptFile({
      tree: parse(src),
      code: src,
      relPath: "src/a.js",
      language: "javascript",
      chunks: [],
    });
    expect(r.classExtends).toBeDefined();
    expect(r.classExtends?.["B"]).toBe("A");
    // Class A has no extends — must not appear in the map.
    expect(r.classExtends?.["A"]).toBeUndefined();
  });

  it("records qualified extends: class C extends A.B.C", () => {
    const src = `class C extends A.B.C {}\n`;
    const r = extractFromJavascriptFile({
      tree: parse(src),
      code: src,
      relPath: "src/c.js",
      language: "javascript",
      chunks: [],
    });
    expect(r.classExtends?.["C"]).toBe("A.B.C");
  });

  it("leaves classExtends undefined or empty when no class extends anything", () => {
    const src = `class A {}\nfunction helper() {}\n`;
    const r = extractFromJavascriptFile({
      tree: parse(src),
      code: src,
      relPath: "src/a.js",
      language: "javascript",
      chunks: [],
    });
    const map = r.classExtends ?? {};
    expect(Object.keys(map).length).toBe(0);
  });

  it("survives NDJSON spill — classExtends round-trips through JSON.stringify", () => {
    // The codegraph provider spills FileExtraction to NDJSON between
    // walker pass and resolver pass. Plain Record round-trips; Map
    // would serialise to `{}` and lose every entry.
    const src = `class B extends A {}\n`;
    const r = extractFromJavascriptFile({
      tree: parse(src),
      code: src,
      relPath: "src/b.js",
      language: "javascript",
      chunks: [],
    });
    const restored = JSON.parse(JSON.stringify(r)) as typeof r;
    expect(restored.classExtends?.["B"]).toBe("A");
  });

  it("class with qualified extends `class B extends ns.A` keeps full chain", () => {
    const src = `class B extends ns.A {}\n`;
    const r = extractFromJavascriptFile({
      tree: parse(src),
      code: src,
      relPath: "src/b.js",
      language: "javascript",
      chunks: [],
    });
    expect(r.classExtends?.["B"]).toBe("ns.A");
  });

  it("anonymous class expression does NOT appear in classExtends", () => {
    // `const Foo = class extends Base {...}` — no class_declaration with name,
    // so collectJsClassExtends skips it.
    const src = `const Foo = class extends Base { bar() {} };\n`;
    const r = extractFromJavascriptFile({
      tree: parse(src),
      code: src,
      relPath: "src/anon.js",
      language: "javascript",
      chunks: [],
    });
    const map = r.classExtends ?? {};
    expect(map["Foo"]).toBeUndefined();
  });

  it("class without `extends` produces no entry in classExtends", () => {
    const src = `class Standalone { foo() { return 1; } }\n`;
    const r = extractFromJavascriptFile({
      tree: parse(src),
      code: src,
      relPath: "src/s.js",
      language: "javascript",
      chunks: [],
    });
    const map = r.classExtends ?? {};
    expect(Object.keys(map)).toEqual([]);
  });

  it("super() in JS constructor → receiver='super' member='constructor' (bd tea-rags-mcp-3a84)", () => {
    const src = "class B extends A {\n  constructor() {\n    super();\n  }\n}\n";
    const r = extractFromJavascriptFile({
      tree: parse(src),
      code: src,
      relPath: "src/sup.js",
      language: "javascript",
      chunks: [{ symbolId: "B#constructor", scope: ["B"], startLine: 2, endLine: 4 }],
    });
    const superCall = r.chunks[0]?.calls?.find((c) => c.receiver === "super");
    expect(superCall).toBeDefined();
    expect(superCall?.member).toBe("constructor");
  });
});
