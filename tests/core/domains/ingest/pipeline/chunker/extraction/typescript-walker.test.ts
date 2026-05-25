import Parser from "tree-sitter";
import TsLang from "tree-sitter-typescript";
import { describe, expect, it } from "vitest";

import { extractFromTypescriptFile } from "../../../../../../../src/core/domains/ingest/pipeline/chunker/extraction/typescript-walker.js";

function parse(code: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage((TsLang as { typescript: Parser.Language }).typescript);
  return parser.parse(code);
}

describe("extractFromTypescriptFile", () => {
  it("extracts top-level imports with text and startLine", () => {
    const code = `import { Foo } from "./foo";\nimport React from "react";\nfunction main() { Foo.bar(); }\n`;
    const tree = parse(code);
    const extraction = extractFromTypescriptFile({
      tree,
      code,
      relPath: "src/a.ts",
      language: "typescript",
      chunks: [{ symbolId: "main", startLine: 3, endLine: 3, scope: [] }],
    });
    expect(extraction.imports.map((i) => i.importText).sort()).toEqual(["./foo", "react"]);
    expect(extraction.imports.every((i) => i.startLine > 0)).toBe(true);
  });

  // bd tea-rags-mcp-2v16 — record the NAMED SPECIFIERS per import so the
  // resolver can map a call receiver directly to its source module instead
  // of relying on the kebab→Pascal filename-normalize hack.
  describe("importedNames — named specifier capture (bd tea-rags-mcp-2v16)", () => {
    it("records multiple named specifiers for one import", () => {
      const code = `import { RankModule, FooHelper } from "./rank-module.js";\nfunction main() { RankModule.go(); }\n`;
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/a.ts",
        language: "typescript",
        chunks: [{ symbolId: "main", startLine: 2, endLine: 2, scope: [] }],
      });
      const ref = extraction.imports.find((i) => i.importText === "./rank-module.js");
      expect(ref?.importedNames).toEqual(["RankModule", "FooHelper"]);
    });

    it("records the LOCAL name for aliased specifiers ({ A as B } → B)", () => {
      const code = `import { Original as Local } from "./mod.js";\n`;
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/a.ts",
        language: "typescript",
        chunks: [],
      });
      const ref = extraction.imports.find((i) => i.importText === "./mod.js");
      expect(ref?.importedNames).toEqual(["Local"]);
    });

    it("records the default import binding", () => {
      const code = `import RankModule from "./rank-module.js";\n`;
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/a.ts",
        language: "typescript",
        chunks: [],
      });
      const ref = extraction.imports.find((i) => i.importText === "./rank-module.js");
      expect(ref?.importedNames).toEqual(["RankModule"]);
    });

    it("records the namespace binding (* as ns)", () => {
      const code = `import * as ns from "./mod.js";\n`;
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/a.ts",
        language: "typescript",
        chunks: [],
      });
      const ref = extraction.imports.find((i) => i.importText === "./mod.js");
      expect(ref?.importedNames).toEqual(["ns"]);
    });

    it("records combined default + named specifiers", () => {
      const code = `import Default, { Named } from "./mod.js";\n`;
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/a.ts",
        language: "typescript",
        chunks: [],
      });
      const ref = extraction.imports.find((i) => i.importText === "./mod.js");
      expect(ref?.importedNames).toEqual(["Default", "Named"]);
    });

    it("omits importedNames for bare side-effect imports", () => {
      const code = `import "./polyfill.js";\n`;
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/a.ts",
        language: "typescript",
        chunks: [],
      });
      const ref = extraction.imports.find((i) => i.importText === "./polyfill.js");
      expect(ref?.importedNames).toBeUndefined();
    });
  });

  it("attaches calls inside a chunk's line range to that chunk", () => {
    const code = `function main() {\n  Foo.bar();\n  baz();\n}\n`;
    const tree = parse(code);
    const extraction = extractFromTypescriptFile({
      tree,
      code,
      relPath: "src/a.ts",
      language: "typescript",
      chunks: [{ symbolId: "main", startLine: 1, endLine: 4, scope: [] }],
    });
    const calls = extraction.chunks[0]?.calls ?? [];
    expect(calls.map((c) => c.member).sort()).toEqual(["bar", "baz"]);
    const fooCall = calls.find((c) => c.member === "bar");
    expect(fooCall?.receiver).toBe("Foo");
    const bazCall = calls.find((c) => c.member === "baz");
    expect(bazCall?.receiver).toBeNull();
  });

  it("does not attach calls outside any chunk", () => {
    const code = `Foo.outside();\nfunction main() { bar(); }\n`;
    const tree = parse(code);
    const extraction = extractFromTypescriptFile({
      tree,
      code,
      relPath: "src/a.ts",
      language: "typescript",
      chunks: [{ symbolId: "main", startLine: 2, endLine: 2, scope: [] }],
    });
    const memberCalls = extraction.chunks[0].calls.map((c) => c.member);
    expect(memberCalls).toContain("bar");
    expect(memberCalls).not.toContain("outside");
  });

  it("returns an empty extraction when chunks list is empty", () => {
    const code = `import "./x";\n`;
    const tree = parse(code);
    const extraction = extractFromTypescriptFile({
      tree,
      code,
      relPath: "src/empty.ts",
      language: "typescript",
      chunks: [],
    });
    expect(extraction.chunks).toEqual([]);
    expect(extraction.imports.map((i) => i.importText)).toEqual(["./x"]);
  });

  describe("classFieldTypes — for cross-class resolver", () => {
    it("collects field types from constructor parameter properties", () => {
      const code = `import { MarkerStore } from "./store";\nclass Coordinator {\n  constructor(private readonly markerStore: MarkerStore) {}\n  go() { this.markerStore.write(); }\n}\n`;
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/coordinator.ts",
        language: "typescript",
        chunks: [{ symbolId: "Coordinator#go", startLine: 4, endLine: 4, scope: ["Coordinator"] }],
      });
      expect(extraction.classFieldTypes).toBeDefined();
      const fields = extraction.classFieldTypes?.["Coordinator"];
      expect(fields).toBeDefined();
      expect(fields?.["markerStore"]).toBe("MarkerStore");
    });

    it("collects field types from public field declarations", () => {
      const code = `class Store {\n  private readonly client: QdrantClient = createClient();\n  read() { return this.client.get(); }\n}\n`;
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/store.ts",
        language: "typescript",
        chunks: [{ symbolId: "Store#read", startLine: 3, endLine: 3, scope: ["Store"] }],
      });
      const fields = extraction.classFieldTypes?.["Store"];
      expect(fields?.["client"]).toBe("QdrantClient");
    });

    it("strips generic parameters — Foo<T> resolves to Foo", () => {
      const code = `class Holder {\n  constructor(private readonly list: Array<number>) {}\n}\n`;
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/holder.ts",
        language: "typescript",
        chunks: [],
      });
      expect(extraction.classFieldTypes?.["Holder"]?.["list"]).toBe("Array");
    });

    it("ignores constructor parameters WITHOUT accessibility modifier (plain params, not fields)", () => {
      const code = `class Plain {\n  constructor(input: string) { this.x = input; }\n}\n`;
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/plain.ts",
        language: "typescript",
        chunks: [],
      });
      // `input` has no `private`/`public`/`readonly` → not a field property
      expect(extraction.classFieldTypes?.["Plain"]).toBeUndefined();
    });

    it("returns empty record for files with no class declarations", () => {
      const code = `export function helper() { return 42; }\n`;
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/util.ts",
        language: "typescript",
        chunks: [],
      });
      expect(Object.keys(extraction.classFieldTypes ?? {}).length).toBe(0);
    });
  });

  // BUG tea-rags-mcp-otjs — mirror of Ruby tea-rags-mcp-8fnu fix. A single
  // call inside a deeply nested method must attach to ONLY the innermost
  // containing chunk. The chunker emits one chunk per scope level (class /
  // constructor / method) so a call's [startLine, endLine] falls inside
  // multiple ranges. The buggy walker assigned the call to every containing
  // chunk, multiplying caller-edge counts by the nesting depth. Innermost-only
  // fixes the inflated fan-in/fan-out.
  describe("innermost-chunk call attribution (bd tea-rags-mcp-otjs)", () => {
    it("assigns each call to only the innermost containing chunk (class + method)", () => {
      // class BashCallResolver {
      //   resolve() {
      //     pickSingleCandidate(fallback, this.mode);
      //   }
      // }
      const code = [
        "class BashCallResolver {", //                       line 1
        "  resolve() {", //                                  line 2
        "    pickSingleCandidate(fallback, this.mode);", //  line 3  <- the call
        "  }", //                                            line 4
        "}", //                                              line 5
        "",
      ].join("\n");
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/bash-call-resolver.ts",
        language: "typescript",
        chunks: [
          { symbolId: "BashCallResolver", startLine: 1, endLine: 5, scope: [] },
          { symbolId: "BashCallResolver#resolve", startLine: 2, endLine: 4, scope: ["BashCallResolver"] },
        ],
      });
      const methodChunk = extraction.chunks.find((c) => c.symbolId === "BashCallResolver#resolve");
      const classChunk = extraction.chunks.find((c) => c.symbolId === "BashCallResolver");
      expect(methodChunk?.calls.map((c) => c.member)).toContain("pickSingleCandidate");
      // Class-level chunk must NOT also own the same call — would inflate caller edges.
      expect(classChunk?.calls.filter((c) => c.member === "pickSingleCandidate")).toEqual([]);
    });

    it("routes constructor and method calls to their own enclosing chunks", () => {
      const code = [
        "class Service {", //          line 1
        "  constructor() {", //        line 2
        "    initLogger();", //        line 3  <- constructor call
        "  }", //                      line 4
        "  run() {", //                line 5
        "    doWork();", //            line 6  <- method call
        "  }", //                      line 7
        "}", //                        line 8
        "",
      ].join("\n");
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/service.ts",
        language: "typescript",
        chunks: [
          { symbolId: "Service", startLine: 1, endLine: 8, scope: [] },
          { symbolId: "Service#constructor", startLine: 2, endLine: 4, scope: ["Service"] },
          { symbolId: "Service#run", startLine: 5, endLine: 7, scope: ["Service"] },
        ],
      });
      const ctor = extraction.chunks.find((c) => c.symbolId === "Service#constructor");
      const run = extraction.chunks.find((c) => c.symbolId === "Service#run");
      const cls = extraction.chunks.find((c) => c.symbolId === "Service");
      expect(ctor?.calls.map((c) => c.member)).toEqual(["initLogger"]);
      expect(run?.calls.map((c) => c.member)).toEqual(["doWork"]);
      // Class chunk must own neither call.
      expect(cls?.calls.filter((c) => c.member === "initLogger" || c.member === "doWork")).toEqual([]);
    });

    it("keeps top-level function calls in the function chunk (no class scope)", () => {
      const code = ["function postProcess() {", "  doX();", "}", ""].join("\n");
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/post-process.ts",
        language: "typescript",
        chunks: [{ symbolId: "postProcess", startLine: 1, endLine: 3, scope: [] }],
      });
      expect(extraction.chunks[0].calls.map((c) => c.member)).toEqual(["doX"]);
    });

    it("does not cross-contaminate calls between sibling methods", () => {
      const code = [
        "class RankModule {", //        line 1
        "  rankChunks() {", //          line 2
        "    rerank();", //             line 3
        "  }", //                       line 4
        "  rankFiles() {", //           line 5
        "    sortFiles();", //          line 6
        "  }", //                       line 7
        "}", //                         line 8
        "",
      ].join("\n");
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/rank-module.ts",
        language: "typescript",
        chunks: [
          { symbolId: "RankModule", startLine: 1, endLine: 8, scope: [] },
          { symbolId: "RankModule#rankChunks", startLine: 2, endLine: 4, scope: ["RankModule"] },
          { symbolId: "RankModule#rankFiles", startLine: 5, endLine: 7, scope: ["RankModule"] },
        ],
      });
      const rc = extraction.chunks.find((c) => c.symbolId === "RankModule#rankChunks");
      const rf = extraction.chunks.find((c) => c.symbolId === "RankModule#rankFiles");
      const cls = extraction.chunks.find((c) => c.symbolId === "RankModule");
      expect(rc?.calls.map((c) => c.member)).toEqual(["rerank"]);
      expect(rf?.calls.map((c) => c.member)).toEqual(["sortFiles"]);
      // Class chunk owns neither (both are inside method chunks).
      expect(cls?.calls.filter((c) => c.member === "rerank" || c.member === "sortFiles")).toEqual([]);
    });

    it("breaks innermost-chunk ties by deeper scope (longer scope wins)", () => {
      // class A {  // line 1
      //   m() {    // line 2
      //     x();   // line 3   <- call
      //   }        // line 4
      // }          // line 5
      // Both chunks span 4 lines (endLine - startLine === 3 vs === 3) —
      // method-level chunk has the deeper scope and must win.
      const code = ["class A {", "  m() {", "    x();", "  }", "}", ""].join("\n");
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/a.ts",
        language: "typescript",
        chunks: [
          { symbolId: "A", startLine: 1, endLine: 4, scope: [] },
          { symbolId: "A#m", startLine: 2, endLine: 5, scope: ["A"] },
        ],
      });
      const inner = extraction.chunks.find((c) => c.symbolId === "A#m");
      const outer = extraction.chunks.find((c) => c.symbolId === "A");
      expect(inner?.calls.map((c) => c.member)).toContain("x");
      expect(outer?.calls.filter((c) => c.member === "x")).toEqual([]);
    });
  });

  // bd tea-rags-mcp-3a84 — bare `super(arg)` inside a constructor was
  // emitted as a free call `{ receiver: null, member: "super" }` because
  // the call's `function` field is the `super` keyword node (no member
  // expression). The resolver then looked up `super` by short-name, found
  // nothing, and dropped the edge. Emit as `{ receiver: "super",
  // member: "constructor" }` so the existing super-branch in ts-resolver
  // can route to `<EnclosingClass>#constructor` of the parent class.
  describe("super() constructor calls (bd tea-rags-mcp-3a84)", () => {
    it("emits super() as receiver='super' member='constructor', not as a free call", () => {
      const code = `class Child extends Base {\n  constructor() { super(arg); }\n}\n`;
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/child.ts",
        language: "typescript",
        chunks: [{ symbolId: "Child#constructor", startLine: 2, endLine: 2, scope: ["Child"] }],
      });
      const calls = extraction.chunks[0]?.calls ?? [];
      const superCall = calls.find((c) => c.callText.startsWith("super("));
      expect(superCall).toBeDefined();
      expect(superCall?.receiver).toBe("super");
      expect(superCall?.member).toBe("constructor");
    });

    it("does not regress super.method() — still receiver='super' member=<methodName>", () => {
      const code = `class Child extends Base {\n  foo() { super.foo(); }\n}\n`;
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/child.ts",
        language: "typescript",
        chunks: [{ symbolId: "Child#foo", startLine: 2, endLine: 2, scope: ["Child"] }],
      });
      const calls = extraction.chunks[0]?.calls ?? [];
      const superCall = calls.find((c) => c.member === "foo" && c.receiver === "super");
      expect(superCall).toBeDefined();
    });
  });

  // bd tea-rags-mcp-d29r — Walker must extract `class Child extends Parent`
  // relationships so the resolver can route `super()` calls to the PARENT
  // class instead of self-looping back to the enclosing class's own
  // constructor. Mirrors Ruby's `collectRubyClassAncestors` but TS only
  // needs the single `extends` clause (no multiple inheritance, no
  // `prepend`-style insertion). `implements I` is type-only and MUST NOT
  // populate classExtends — it carries no runtime call dispatch.
  describe("classExtends — for super() resolver (bd tea-rags-mcp-d29r)", () => {
    it("records direct extends: class B extends A", () => {
      const code = `class A {}\nclass B extends A {}\n`;
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/a.ts",
        language: "typescript",
        chunks: [],
      });
      expect(extraction.classExtends).toBeDefined();
      expect(extraction.classExtends?.["B"]).toBe("A");
      // Class A has no extends — must not appear in the map.
      expect(extraction.classExtends?.["A"]).toBeUndefined();
    });

    it("records qualified extends: class C extends A.B.C", () => {
      const code = `class C extends A.B.C {}\n`;
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/c.ts",
        language: "typescript",
        chunks: [],
      });
      expect(extraction.classExtends?.["C"]).toBe("A.B.C");
    });

    it("strips generic type args from `extends Base<T>` — only the base name is stored", () => {
      // Exercises the `parentNode.type === "generic_type"` branch in
      // typescript-walker.ts — angle-bracketed type args are not part
      // of the parent class identity.
      const code = `class A<T> {}\nclass B<T> extends A<T> {}\n`;
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/b.ts",
        language: "typescript",
        chunks: [],
      });
      // The class B's parent is "A", not "A<T>".
      expect(extraction.classExtends?.["B"]).toBe("A");
    });

    it("ignores `implements` clauses — only `extends` populates the map", () => {
      const code = `class D implements I {}\n`;
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/d.ts",
        language: "typescript",
        chunks: [],
      });
      // `implements I` is type-only — no runtime parent dispatch.
      expect(extraction.classExtends?.["D"]).toBeUndefined();
    });

    it("leaves classExtends undefined or empty when no class extends anything", () => {
      const code = `class A {}\nfunction helper() {}\n`;
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/a.ts",
        language: "typescript",
        chunks: [],
      });
      // Either undefined or empty record — both are fine for "no data".
      const map = extraction.classExtends ?? {};
      expect(Object.keys(map).length).toBe(0);
    });

    it("survives NDJSON spill — classExtends round-trips through JSON.stringify", () => {
      // The codegraph provider spills FileExtraction to NDJSON between
      // walker pass (pass-1) and resolver pass (pass-2). Plain Record
      // round-trips; Map would serialise to `{}` and lose every entry.
      const code = `class B extends A {}\n`;
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/b.ts",
        language: "typescript",
        chunks: [],
      });
      const restored = JSON.parse(JSON.stringify(extraction)) as typeof extraction;
      expect(restored.classExtends?.["B"]).toBe("A");
    });

    it("handles both extends and implements in the same heritage clause", () => {
      // `class E extends Base implements I, J` — extends populates,
      // implements does not.
      const code = `class E extends Base implements I, J {}\n`;
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/e.ts",
        language: "typescript",
        chunks: [],
      });
      expect(extraction.classExtends?.["E"]).toBe("Base");
    });
  });

  // bd tea-rags-mcp-m19a — `import type { X } from "./x"` is a
  // compile-time-only construct. It produces NO runtime require, hence
  // no file-level dependency edge. Including it in imports[] inflated
  // codegraph fanOut/fanIn for type-only relationships. The fix filters
  // import_statement nodes that carry the `type` modifier at the
  // statement level. Per-specifier `import { type X, Y } from "..."`
  // (where only some specifiers are types) is rarer and out of scope
  // here — the underlying import IS a runtime import (loads Y), so
  // keeping it in imports[] is correct.
  describe("type-only imports filter (bd tea-rags-mcp-m19a)", () => {
    it('excludes `import type { X } from "..."` from imports[]', () => {
      const code = `import type { X } from "./x";\nimport { Y } from "./y";\n`;
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/main.ts",
        language: "typescript",
        chunks: [],
      });
      const sources = extraction.imports.map((i) => i.importText);
      expect(sources).toContain("./y");
      expect(sources).not.toContain("./x");
    });

    it("preserves runtime imports that mix type and value specifiers", () => {
      // `import { type X, Y } from "./y"` IS a runtime import (Y is
      // loaded at runtime). The whole statement stays in imports[].
      const code = `import { type X, Y } from "./y";\n`;
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/main.ts",
        language: "typescript",
        chunks: [],
      });
      expect(extraction.imports.map((i) => i.importText)).toContain("./y");
    });
  });

  // bd tea-rags-mcp-i252 — `new ClassName(args)` is a constructor call,
  // not a free expression. The walker must emit a CallRef with
  // receiver=ClassName, member="constructor" so the resolver can route
  // to ClassName#constructor (which may be the synthetic constructor
  // emitted by the codegraph provider — see bd tea-rags-mcp-vw1u).
  describe("new ClassName(args) constructor calls (bd tea-rags-mcp-i252)", () => {
    it("emits 'new RankModule(a, b)' with receiver='RankModule' member='constructor'", () => {
      const code = ["function build() {", "  return new RankModule(a, b);", "}", ""].join("\n");
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/build.ts",
        language: "typescript",
        chunks: [{ symbolId: "build", startLine: 1, endLine: 3, scope: [] }],
      });
      const calls = extraction.chunks[0]?.calls ?? [];
      const newCall = calls.find((c) => c.callText.startsWith("new RankModule"));
      expect(newCall).toBeDefined();
      expect(newCall?.receiver).toBe("RankModule");
      expect(newCall?.member).toBe("constructor");
    });

    it("preserves qualified class names: 'new ns.SubNS.Foo()' keeps full chain in receiver", () => {
      const code = ["function build() {", "  return new ns.SubNS.Foo();", "}", ""].join("\n");
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/build.ts",
        language: "typescript",
        chunks: [{ symbolId: "build", startLine: 1, endLine: 3, scope: [] }],
      });
      const calls = extraction.chunks[0]?.calls ?? [];
      const newCall = calls.find((c) => c.callText.startsWith("new ns.SubNS.Foo"));
      expect(newCall).toBeDefined();
      expect(newCall?.receiver).toBe("ns.SubNS.Foo");
      expect(newCall?.member).toBe("constructor");
    });

    it("does NOT regress existing Foo.method() member-call extraction", () => {
      // Regression guard: the new_expression branch must not intercept
      // ordinary member calls.
      const code = ["function caller() {", "  Foo.method(arg);", "}", ""].join("\n");
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/caller.ts",
        language: "typescript",
        chunks: [{ symbolId: "caller", startLine: 1, endLine: 3, scope: [] }],
      });
      const calls = extraction.chunks[0]?.calls ?? [];
      const methodCall = calls.find((c) => c.member === "method");
      expect(methodCall).toBeDefined();
      expect(methodCall?.receiver).toBe("Foo");
    });
  });

  describe("edge cases — tolerant of malformed / unusual input", () => {
    it("anonymous class expression `const X = class { ... }` does not appear in classFieldTypes / classExtends", () => {
      // Anonymous class expression — no name field, so the walker's class
      // collectors skip it. The host const Foo is captured by codegraph at
      // the symbol level, but classFieldTypes / classExtends stay empty
      // because they key on the class's own name.
      const code = ["const Foo = class extends Base {", "  bar() { return 1; }", "};", ""].join("\n");
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/anon.ts",
        language: "typescript",
        chunks: [{ symbolId: "Foo", startLine: 1, endLine: 3, scope: [] }],
      });
      // No named class declaration → empty classExtends / classFieldTypes.
      expect(extraction.classExtends ?? {}).toEqual({});
      expect(extraction.classFieldTypes ?? {}).toEqual({});
    });

    it("class declaration without an extends clause emits no classExtends entry", () => {
      // Hits the early-return branch in collectClassExtends when no
      // class_heritage child is present.
      const code = ["class Standalone {", "  foo() { return 1; }", "}", ""].join("\n");
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/standalone.ts",
        language: "typescript",
        chunks: [{ symbolId: "Standalone#foo", startLine: 2, endLine: 2, scope: ["Standalone"] }],
      });
      expect(extraction.classExtends ?? {}).toEqual({});
    });

    it("class with constructor but no fields-as-params emits empty classFieldTypes", () => {
      // Constructor has plain params (no accessibility modifier), so
      // they're NOT class fields. classFieldTypes should be empty.
      const code = ["class Plain {", "  constructor(a: string, b: number) {", "    this.x = a;", "  }", "}", ""].join(
        "\n",
      );
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/plain.ts",
        language: "typescript",
        chunks: [{ symbolId: "Plain#constructor", startLine: 2, endLine: 4, scope: ["Plain"] }],
      });
      expect(extraction.classFieldTypes ?? {}).toEqual({});
    });

    it("abstract class records extends and field types", () => {
      // bd tea-rags-mcp-q3o2 — abstract_class_declaration shape must
      // populate classFieldTypes + classExtends identically to class_declaration.
      const code = [
        "abstract class AbsChild extends AbsBase {",
        "  constructor(protected readonly svc: Service) { super(svc); }",
        "  abstract doIt(): void;",
        "}",
        "",
      ].join("\n");
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/abstract.ts",
        language: "typescript",
        chunks: [{ symbolId: "AbsChild#constructor", startLine: 2, endLine: 2, scope: ["AbsChild"] }],
      });
      expect(extraction.classExtends).toEqual({ AbsChild: "AbsBase" });
      expect(extraction.classFieldTypes).toEqual({ AbsChild: { svc: "Service" } });
    });

    it("type-only import line `import type { X } from 'foo'` is excluded from imports[]", () => {
      // bd tea-rags-mcp-m19a — pure type imports MUST NOT appear in imports[].
      const code = [
        "import type { X } from './x';",
        "import { Y } from './y';",
        "function main() { Y.run(); }",
        "",
      ].join("\n");
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/m.ts",
        language: "typescript",
        chunks: [{ symbolId: "main", startLine: 3, endLine: 3, scope: [] }],
      });
      // Only the runtime import lands.
      expect(extraction.imports.map((i) => i.importText)).toEqual(["./y"]);
    });
  });

  // bd tea-rags-mcp-x6ta — parameter-type bindings for typed-receiver
  // resolution. A call `resolver.resolve(...)` where `resolver` is a
  // FUNCTION PARAMETER typed `CallResolver` previously dropped to the
  // ambiguous short-name fallback (one match per `*CallResolver` impl).
  // The walker now records `{ paramName → type }` per chunk on
  // `localBindings` (same field the Python/Go walkers use) so the
  // resolver can pin `resolver.resolve` to `CallResolver#resolve`.
  describe("parameter-type bindings (localBindings) — bd tea-rags-mcp-x6ta", () => {
    it("binds a top-level function's typed parameter to its type", () => {
      const code = ["function run(resolver: CallResolver) {", "  resolver.resolve(call, ctx);", "}", ""].join("\n");
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/run.ts",
        language: "typescript",
        chunks: [{ symbolId: "run", startLine: 1, endLine: 3, scope: [] }],
      });
      expect(extraction.chunks[0].localBindings?.["resolver"]).toBe("CallResolver");
    });

    it("binds a class method's typed parameter to its type, scoped to that method's chunk", () => {
      const code = [
        "class Foo {", //                line 1
        "  handle(svc: BarService) {", // line 2
        "    svc.go();", //              line 3
        "  }", //                        line 4
        "}", //                          line 5
        "",
      ].join("\n");
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/foo.ts",
        language: "typescript",
        chunks: [
          { symbolId: "Foo", startLine: 1, endLine: 5, scope: [] },
          { symbolId: "Foo#handle", startLine: 2, endLine: 4, scope: ["Foo"] },
        ],
      });
      const handle = extraction.chunks.find((c) => c.symbolId === "Foo#handle");
      expect(handle?.localBindings?.["svc"]).toBe("BarService");
      // The enclosing class chunk must NOT carry the method's parameter
      // binding — bindings are scoped to the declaring chunk's range.
      const cls = extraction.chunks.find((c) => c.symbolId === "Foo");
      expect(cls?.localBindings?.["svc"]).toBeUndefined();
    });

    it("binds a typed parameter of an arrow function assigned to a const", () => {
      const code = ["const run = (resolver: CallResolver) => {", "  resolver.resolve();", "};", ""].join("\n");
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/arrow.ts",
        language: "typescript",
        chunks: [{ symbolId: "run", startLine: 1, endLine: 3, scope: [] }],
      });
      expect(extraction.chunks[0].localBindings?.["resolver"]).toBe("CallResolver");
    });

    it("strips generics — Repo<User> binds to Repo", () => {
      const code = ["function load(repo: Repo<User>) {", "  repo.find();", "}", ""].join("\n");
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/load.ts",
        language: "typescript",
        chunks: [{ symbolId: "load", startLine: 1, endLine: 3, scope: [] }],
      });
      expect(extraction.chunks[0].localBindings?.["repo"]).toBe("Repo");
    });

    it("leaves localBindings undefined when no parameter carries a usable type annotation", () => {
      const code = ["function plain(x, y) {", "  doThing();", "}", ""].join("\n");
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/plain.ts",
        language: "typescript",
        chunks: [{ symbolId: "plain", startLine: 1, endLine: 3, scope: [] }],
      });
      expect(extraction.chunks[0].localBindings).toBeUndefined();
    });
  });
});
