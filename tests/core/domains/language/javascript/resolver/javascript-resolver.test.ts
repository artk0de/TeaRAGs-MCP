import { describe, expect, it } from "vitest";

import type { CallContext, FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import type { LanguageFactoryDescriptor } from "../../../../../../src/core/contracts/types/language.js";
import {
  JavascriptCallResolver,
  mapJavascriptImportToFile,
} from "../../../../../../src/core/domains/language/javascript/resolver/index.js";
import { CallEdgeResolutionRunner } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function ctx(
  callerFile: string,
  imports: { importText: string; startLine: number }[],
  table: InMemoryGlobalSymbolTable,
): CallContext {
  return { callerFile, callerScope: [], imports, symbolTable: table };
}

describe("mapJavascriptImportToFile", () => {
  it("relative import resolves with .js extension by default", () => {
    expect(mapJavascriptImportToFile("./foo", "pkg/main.js")).toBe("pkg/foo.js");
  });

  it("preserves explicit .js extension", () => {
    expect(mapJavascriptImportToFile("./foo.js", "pkg/main.js")).toBe("pkg/foo.js");
  });

  it("preserves explicit .mjs extension", () => {
    expect(mapJavascriptImportToFile("./foo.mjs", "pkg/main.mjs")).toBe("pkg/foo.mjs");
  });

  it("parent path resolves with normalization", () => {
    expect(mapJavascriptImportToFile("../foo", "pkg/sub/x.js")).toBe("pkg/foo.js");
  });

  it("returns null for bare specifiers (npm packages)", () => {
    expect(mapJavascriptImportToFile("lodash", "x.js")).toBeNull();
  });

  it("maps a TypeScript-extension specifier to the file as written (bd tea-rags-mcp-x9qsh)", () => {
    // A JS entry point loading TS source directly — `node
    // --experimental-strip-types`, tsx — writes the `.ts` it means. Appending
    // `.js` produced `worker.ts.js`, a path no file table row matches.
    expect(mapJavascriptImportToFile("./ts-live-resolve-worker.ts", "scripts/spikes/boot.js")).toBe(
      "scripts/spikes/ts-live-resolve-worker.ts",
    );
    expect(mapJavascriptImportToFile("../ui/view.tsx", "scripts/spikes/boot.js")).toBe("scripts/ui/view.tsx");
    expect(mapJavascriptImportToFile("./worker.mts", "scripts/boot.mjs")).toBe("scripts/worker.mts");
    expect(mapJavascriptImportToFile("./worker.cts", "scripts/boot.cjs")).toBe("scripts/worker.cts");
    expect(mapJavascriptImportToFile("./types.d.ts", "scripts/boot.js")).toBe("scripts/types.d.ts");
  });

  it("maps a JSON module to the file as written (bd tea-rags-mcp-x9qsh)", () => {
    // `require("../package.json")` names the JSON file, not `package.json.js`.
    expect(mapJavascriptImportToFile("../package.json", "scripts/postinstall.js")).toBe("package.json");
    expect(mapJavascriptImportToFile("./data/fixtures.json", "src/main.mjs")).toBe("src/data/fixtures.json");
  });
});

describe("JavaScript import file edges (bd tea-rags-mcp-x9qsh)", () => {
  /** File-edge targets the provider's pass-2 runner persists for one JS file. */
  function fileEdgeTargets(relPath: string, importTexts: string[]): string[] {
    const factory = {
      supported: () => ["javascript"],
      create: () => ({ resolver: new JavascriptCallResolver() }),
    } as unknown as LanguageFactoryDescriptor;
    const runner = new CallEdgeResolutionRunner(factory, new CodegraphRunState());
    const extraction: FileExtraction = {
      relPath,
      language: "javascript",
      imports: importTexts.map((importText, index) => ({ importText, startLine: index + 1 })),
      chunks: [],
      fileScope: [],
    };
    return runner.resolve(extraction, new InMemoryGlobalSymbolTable()).fileEdges.map((edge) => edge.targetRelPath);
  }

  it("persists a JS import of a TypeScript file as an edge to that file", () => {
    // The live defect, end to end through the file-edge seam the provider
    // runs: `scripts/spikes/ts-live-resolve-worker-boot.js` doing
    // `await import("./ts-live-resolve-worker.ts")` was stored with target
    // `ts-live-resolve-worker.ts.js`, so the edge pointed at nothing.
    expect(fileEdgeTargets("scripts/spikes/ts-live-resolve-worker-boot.js", ["./ts-live-resolve-worker.ts"])).toEqual([
      "scripts/spikes/ts-live-resolve-worker.ts",
    ]);
  });

  it("persists an import that writes its .js extension as an edge to that file", () => {
    // Node ESM requires the extension, so this is the ordinary JS import. The
    // synthesised-call fallback matched the import by basename: receiver
    // `render-changelog.js` against the import's stripped `render-changelog`,
    // a mismatch that dropped every such edge (6 on this repo's own scripts).
    expect(fileEdgeTargets("scripts/retro-changelog.js", ["./lib/render-changelog.js"])).toEqual([
      "scripts/lib/render-changelog.js",
    ]);
    expect(fileEdgeTargets("scripts/postinstall.mjs", ["./install-fish-completion.mjs"])).toEqual([
      "scripts/install-fish-completion.mjs",
    ]);
  });

  it("keeps one edge per imported file when two imports share a basename", () => {
    // Basename matching sent both `util` imports to whichever came first.
    expect(fileEdgeTargets("src/main.js", ["./a/util", "./b/util.js"])).toEqual(["src/a/util.js", "src/b/util.js"]);
  });

  it("maps an extensionless import or require to the .js file", () => {
    expect(fileEdgeTargets("src/main.js", ["./config", "../shared/log"])).toEqual(["src/config.js", "shared/log.js"]);
  });

  it("emits no edge for a bare package specifier", () => {
    expect(fileEdgeTargets("src/main.js", ["lodash", "node:path", "@scope/pkg/sub"])).toEqual([]);
  });

  it("keeps an edge to a relative target the index does not hold, as TypeScript does", () => {
    // `import("../build/...")` names a real module in a directory the index
    // skips. Unverified like the TypeScript file edge: the mapper answers from
    // the specifier alone and the edge simply joins no file row.
    expect(fileEdgeTargets("scripts/verify-providers.js", ["../build/core/adapters/embeddings/factory.js"])).toEqual([
      "build/core/adapters/embeddings/factory.js",
    ]);
  });
});

describe("JavascriptCallResolver", () => {
  it("resolves receiver-matched relative import to known file", () => {
    const r = new JavascriptCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("pkg/foo.js", [
      { symbolId: "bar", fqName: "bar", shortName: "bar", relPath: "pkg/foo.js", scope: [] },
    ]);
    const target = r.resolve(
      { callText: "foo.bar()", receiver: "foo", member: "bar", startLine: 3 },
      ctx("pkg/main.js", [{ importText: "./foo", startLine: 1 }], t),
    );
    expect(target?.targetRelPath).toBe("pkg/foo.js");
    expect(target?.targetSymbolId).toBe("bar");
  });

  it("matches import basename ignoring .js extension", () => {
    const r = new JavascriptCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("pkg/foo.js", [
      { symbolId: "bar", fqName: "bar", shortName: "bar", relPath: "pkg/foo.js", scope: [] },
    ]);
    const target = r.resolve(
      { callText: "foo.bar()", receiver: "foo", member: "bar", startLine: 3 },
      ctx("pkg/main.js", [{ importText: "./foo.js", startLine: 1 }], t),
    );
    expect(target?.targetRelPath).toBe("pkg/foo.js");
  });

  it("falls back to global short-name when no receiver", () => {
    const r = new JavascriptCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("helpers.js", [
      { symbolId: "doThing", fqName: "doThing", shortName: "doThing", relPath: "helpers.js", scope: [] },
    ]);
    const target = r.resolve(
      { callText: "doThing()", receiver: null, member: "doThing", startLine: 1 },
      ctx("main.js", [], t),
    );
    expect(target?.targetRelPath).toBe("helpers.js");
  });

  it("returns target file with null symbol id when import matches but symbol unknown", () => {
    const r = new JavascriptCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    const target = r.resolve(
      { callText: "foo.ghost()", receiver: "foo", member: "ghost", startLine: 1 },
      ctx("pkg/main.js", [{ importText: "./foo", startLine: 1 }], t),
    );
    expect(target?.targetRelPath).toBe("pkg/foo.js");
    expect(target?.targetSymbolId).toBeNull();
  });

  it("returns null for bare specifier imports (out of scope)", () => {
    const r = new JavascriptCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    const target = r.resolve(
      { callText: "lodash.get()", receiver: "lodash", member: "get", startLine: 1 },
      ctx("main.js", [{ importText: "lodash", startLine: 1 }], t),
    );
    expect(target).toBeNull();
  });

  // The `this.X()` / `super.X()` block (lines 44-53) routes intra-class
  // calls through the same instance/static lookup ladder the TS resolver
  // uses, so JS classes get correct edges to instance methods on the
  // enclosing class. These were uncovered until Slice 2.
  describe("intra-class this/super dispatch (symbolId convention)", () => {
    it("resolves this.X() to <EnclosingClass>#<member> in the SAME file (instance method)", () => {
      const r = new JavascriptCallResolver();
      const t = new InMemoryGlobalSymbolTable();
      t.upsertFile("src/store.js", [
        {
          symbolId: "Store#read",
          fqName: "Store#read",
          shortName: "read",
          relPath: "src/store.js",
          scope: ["Store"],
        },
      ]);
      const target = r.resolve(
        { callText: "this.read()", receiver: "this", member: "read", startLine: 5 },
        {
          callerFile: "src/store.js",
          callerScope: ["Store"],
          imports: [],
          symbolTable: t,
        },
      );
      expect(target?.targetRelPath).toBe("src/store.js");
      expect(target?.targetSymbolId).toBe("Store#read");
    });

    // bd tea-rags-mcp-4rgg — super.X() must route to the PARENT class's
    // method, NOT the enclosing class's own. Without classExtends in ctx
    // the resolver cannot determine the parent and returns null (avoids
    // the self-loop bug). Previously this test asserted the bug as
    // correct behavior; the JS port of the TS fix flips it to null.
    it("returns null on super.X() when classExtends has no entry for the enclosing class", () => {
      const r = new JavascriptCallResolver();
      const t = new InMemoryGlobalSymbolTable();
      t.upsertFile("src/child.js", [
        { symbolId: "Child#init", fqName: "Child#init", shortName: "init", relPath: "src/child.js", scope: ["Child"] },
      ]);
      const target = r.resolve(
        { callText: "super.init()", receiver: "super", member: "init", startLine: 3 },
        { callerFile: "src/child.js", callerScope: ["Child"], imports: [], symbolTable: t },
        // No classExtends — parent unknown, so the only safe result is
        // null. Self-looping back to Child#init would emit a fake edge.
      );
      expect(target).toBeNull();
    });

    it("falls back to <EnclosingClass>.<member> (static dispatch) when instance form is absent", () => {
      const r = new JavascriptCallResolver();
      const t = new InMemoryGlobalSymbolTable();
      t.upsertFile("src/util.js", [
        {
          symbolId: "Util.make",
          fqName: "Util.make",
          shortName: "make",
          relPath: "src/util.js",
          scope: ["Util"],
        },
      ]);
      const target = r.resolve(
        { callText: "this.make()", receiver: "this", member: "make", startLine: 4 },
        { callerFile: "src/util.js", callerScope: ["Util"], imports: [], symbolTable: t },
      );
      expect(target?.targetSymbolId).toBe("Util.make");
    });

    it("falls back to same-file short-name when no instance/static form matches", () => {
      const r = new JavascriptCallResolver();
      const t = new InMemoryGlobalSymbolTable();
      t.upsertFile("src/mixed.js", [
        // top-level helper, NOT class-scoped — shortName lookup wins
        { symbolId: "helper", fqName: "helper", shortName: "helper", relPath: "src/mixed.js", scope: [] },
      ]);
      const target = r.resolve(
        { callText: "this.helper()", receiver: "this", member: "helper", startLine: 6 },
        { callerFile: "src/mixed.js", callerScope: ["Container"], imports: [], symbolTable: t },
      );
      expect(target?.targetSymbolId).toBe("helper");
    });

    it("does NOT misroute this.X() when callerScope is empty (top-level function context)", () => {
      const r = new JavascriptCallResolver();
      const t = new InMemoryGlobalSymbolTable();
      t.upsertFile("src/other.js", [
        { symbolId: "Foo#bar", fqName: "Foo#bar", shortName: "bar", relPath: "src/other.js", scope: ["Foo"] },
      ]);
      // Empty callerScope skips the this/super block entirely. `this` outside a
      // class names no type, so the `Foo#bar` in another file that the global
      // short-name lookup used to return was a naming coincidence — a
      // receiver-bearing call no longer falls through to it (bd tea-rags-mcp-hwwtw).
      const target = r.resolve(
        { callText: "this.bar()", receiver: "this", member: "bar", startLine: 1 },
        { callerFile: "src/caller.js", callerScope: [], imports: [], symbolTable: t },
      );
      expect(target).toBeNull();
    });
  });

  // bd tea-rags-mcp-4rgg — JS mirror of the TS resolver fix. super() must
  // route to the PARENT class via classExtends, NOT self-loop on the
  // enclosing class's own constructor. Empirical: every Child#constructor
  // had a super(...) edge pointing at itself before classExtends wiring.
  describe("super() / super.foo() resolution to parent class via classExtends (bd tea-rags-mcp-4rgg)", () => {
    it("super() in constructor routes to parent class's constructor — NOT enclosing class (self-loop bug)", () => {
      const r = new JavascriptCallResolver();
      const t = new InMemoryGlobalSymbolTable();
      t.upsertFile("src/base.js", [
        {
          symbolId: "Base#constructor",
          fqName: "Base#constructor",
          shortName: "constructor",
          relPath: "src/base.js",
          scope: ["Base"],
        },
      ]);
      t.upsertFile("src/child.js", [
        {
          symbolId: "Child#constructor",
          fqName: "Child#constructor",
          shortName: "constructor",
          relPath: "src/child.js",
          scope: ["Child"],
        },
      ]);
      const result = r.resolve(
        { callText: "super(...args)", receiver: "super", member: "constructor", startLine: 3 },
        {
          callerFile: "src/child.js",
          callerScope: ["Child"],
          imports: [],
          symbolTable: t,
          classExtends: { Child: "Base" },
        },
      );
      // MUST land on Parent#constructor, not Child#constructor.
      expect(result?.targetSymbolId).toBe("Base#constructor");
      expect(result?.targetRelPath).toBe("src/base.js");
    });

    it("super.foo() routes to parent class's instance method foo", () => {
      const r = new JavascriptCallResolver();
      const t = new InMemoryGlobalSymbolTable();
      t.upsertFile("src/base.js", [
        { symbolId: "Base#foo", fqName: "Base#foo", shortName: "foo", relPath: "src/base.js", scope: ["Base"] },
      ]);
      t.upsertFile("src/child.js", [
        { symbolId: "Child#foo", fqName: "Child#foo", shortName: "foo", relPath: "src/child.js", scope: ["Child"] },
      ]);
      const result = r.resolve(
        { callText: "super.foo()", receiver: "super", member: "foo", startLine: 2 },
        {
          callerFile: "src/child.js",
          callerScope: ["Child"],
          imports: [],
          symbolTable: t,
          classExtends: { Child: "Base" },
        },
      );
      expect(result?.targetSymbolId).toBe("Base#foo");
      expect(result?.targetRelPath).toBe("src/base.js");
    });

    it("returns null when classExtends has no entry for the enclosing class (parent unknown)", () => {
      // Without classExtends data, the resolver cannot know the parent.
      // Returning the enclosing class's own method would self-loop —
      // safer to drop the edge.
      const r = new JavascriptCallResolver();
      const t = new InMemoryGlobalSymbolTable();
      t.upsertFile("src/child.js", [
        {
          symbolId: "Child#constructor",
          fqName: "Child#constructor",
          shortName: "constructor",
          relPath: "src/child.js",
          scope: ["Child"],
        },
      ]);
      const result = r.resolve(
        { callText: "super()", receiver: "super", member: "constructor", startLine: 3 },
        {
          callerFile: "src/child.js",
          callerScope: ["Child"],
          imports: [],
          symbolTable: t,
          // No classExtends — parent unknown.
        },
      );
      expect(result).toBeNull();
    });

    // bd tea-rags-mcp-4rgg — file-only fallback. When the parent chain
    // walks but no class in the chain owns `<member>`, the resolver
    // returns a file-only edge pointing at the first ancestor whose
    // file is known. This catches "extends EventEmitter" style cases
    // where the parent lives outside the indexed set but the file
    // containing the parent declaration is visible.
    it("super.foo() returns file-only target (targetSymbolId: null) when parent file known but method not found", () => {
      const r = new JavascriptCallResolver();
      const t = new InMemoryGlobalSymbolTable();
      // Parent class Base exists at file level but DOES NOT declare foo.
      t.upsertFile("src/base.js", [
        {
          symbolId: "Base",
          fqName: "Base",
          shortName: "Base",
          relPath: "src/base.js",
          scope: [],
        },
      ]);
      t.upsertFile("src/child.js", [
        { symbolId: "Child#foo", fqName: "Child#foo", shortName: "foo", relPath: "src/child.js", scope: ["Child"] },
      ]);
      const result = r.resolve(
        { callText: "super.foo()", receiver: "super", member: "foo", startLine: 2 },
        {
          callerFile: "src/child.js",
          callerScope: ["Child"],
          imports: [],
          symbolTable: t,
          classExtends: { Child: "Base" },
        },
      );
      expect(result).not.toBeNull();
      expect(result?.targetRelPath).toBe("src/base.js");
      expect(result?.targetSymbolId).toBeNull();
    });

    // Transitive chain: Child extends Mid extends Base; method lives on Base.
    it("super.foo() walks transitive chain to find method on grandparent", () => {
      const r = new JavascriptCallResolver();
      const t = new InMemoryGlobalSymbolTable();
      t.upsertFile("src/base.js", [
        { symbolId: "Base#foo", fqName: "Base#foo", shortName: "foo", relPath: "src/base.js", scope: ["Base"] },
      ]);
      t.upsertFile("src/mid.js", [
        // Mid does NOT define foo.
        { symbolId: "Mid", fqName: "Mid", shortName: "Mid", relPath: "src/mid.js", scope: [] },
      ]);
      t.upsertFile("src/child.js", [
        { symbolId: "Child#foo", fqName: "Child#foo", shortName: "foo", relPath: "src/child.js", scope: ["Child"] },
      ]);
      const result = r.resolve(
        { callText: "super.foo()", receiver: "super", member: "foo", startLine: 2 },
        {
          callerFile: "src/child.js",
          callerScope: ["Child"],
          imports: [],
          symbolTable: t,
          classExtends: { Child: "Mid", Mid: "Base" },
        },
      );
      // Method found on grandparent — symbolId resolves to Base#foo.
      expect(result?.targetSymbolId).toBe("Base#foo");
      expect(result?.targetRelPath).toBe("src/base.js");
    });

    // Static fallback path inside the parent walk (line 124-129):
    // parent owns `Class.foo` (static) but not `Class#foo` (instance).
    it("super.foo() prefers instance form, but falls back to static form on parent", () => {
      const r = new JavascriptCallResolver();
      const t = new InMemoryGlobalSymbolTable();
      // Parent class Base owns only the STATIC form Base.foo (rare but possible).
      t.upsertFile("src/base.js", [
        { symbolId: "Base.foo", fqName: "Base.foo", shortName: "foo", relPath: "src/base.js", scope: ["Base"] },
      ]);
      t.upsertFile("src/child.js", [
        { symbolId: "Child#bar", fqName: "Child#bar", shortName: "bar", relPath: "src/child.js", scope: ["Child"] },
      ]);
      const result = r.resolve(
        { callText: "super.foo()", receiver: "super", member: "foo", startLine: 2 },
        {
          callerFile: "src/child.js",
          callerScope: ["Child"],
          imports: [],
          symbolTable: t,
          classExtends: { Child: "Base" },
        },
      );
      expect(result?.targetSymbolId).toBe("Base.foo");
      expect(result?.targetRelPath).toBe("src/base.js");
    });

    // Walk exhausts (cycle in classExtends data) → returns null when
    // no file-only fallback could be derived.
    it("returns null when the classExtends chain cycles back to a visited class", () => {
      const r = new JavascriptCallResolver();
      const t = new InMemoryGlobalSymbolTable();
      // Cycle: A → B → A — visited guard prevents infinite loop.
      // Neither class has the method or is in the symbol table.
      const result = r.resolve(
        { callText: "super.x()", receiver: "super", member: "x", startLine: 1 },
        {
          callerFile: "src/a.js",
          callerScope: ["A"],
          imports: [],
          symbolTable: t,
          classExtends: { A: "B", B: "A" },
        },
      );
      expect(result).toBeNull();
    });

    // The qualified parent ("ns.Base" via lastSegment) — file-only
    // fallback uses lastSegment("ns.Base") = "Base" for the short-name
    // lookup. Covers the lastSegment helper (lines 169-173).
    it("super.foo() resolves qualified parent via lastSegment short-name lookup", () => {
      const r = new JavascriptCallResolver();
      const t = new InMemoryGlobalSymbolTable();
      // Symbol table holds Base under short-name "Base" — qualified
      // chain reference is "ns.Base", lastSegment strips to "Base".
      t.upsertFile("src/ns.js", [
        {
          symbolId: "Base",
          fqName: "Base",
          shortName: "Base",
          relPath: "src/ns.js",
          scope: [],
        },
      ]);
      const result = r.resolve(
        { callText: "super.foo()", receiver: "super", member: "foo", startLine: 1 },
        {
          callerFile: "src/child.js",
          callerScope: ["Child"],
          imports: [],
          symbolTable: t,
          classExtends: { Child: "ns.Base" },
        },
      );
      // Method `foo` not found anywhere; falls back to file-only ancestor.
      expect(result).not.toBeNull();
      expect(result?.targetRelPath).toBe("src/ns.js");
      expect(result?.targetSymbolId).toBeNull();
    });

    // File-only fallback via scope match: parent doesn't exist as
    // top-level def, but a symbol with `scope[last] === parent` does
    // (e.g. a method whose enclosing class IS the parent).
    it("file-only fallback finds parent file via scope match when parent has no top-level decl", () => {
      const r = new JavascriptCallResolver();
      const t = new InMemoryGlobalSymbolTable();
      // Parent "Base" has no own top-level definition, but it has a
      // method (member match) whose scope[last] = "Base".
      t.upsertFile("src/base.js", [
        {
          symbolId: "Base#other",
          fqName: "Base#other",
          shortName: "other",
          relPath: "src/base.js",
          scope: ["Base"],
        },
      ]);
      const result = r.resolve(
        { callText: "super.other()", receiver: "super", member: "other", startLine: 1 },
        {
          callerFile: "src/child.js",
          callerScope: ["Child"],
          imports: [],
          symbolTable: t,
          classExtends: { Child: "Base" },
        },
      );
      // Base#other matches as the instance-form direct hit.
      expect(result?.targetSymbolId).toBe("Base#other");
      expect(result?.targetRelPath).toBe("src/base.js");
    });

    // The `constructor` scope-probe path inside fileOnlyFallback setup:
    // when neither the bare parent short-name nor the member exist as
    // a scope match, the resolver probes "constructor" symbols whose
    // scope[last] = parent — typical when only the constructor is
    // emitted for a class.
    it("file-only fallback uses constructor scope probe when no other anchor exists", () => {
      const r = new JavascriptCallResolver();
      const t = new InMemoryGlobalSymbolTable();
      // Only the constructor of Base is in the table — no top-level
      // Base symbol, no Base#someMember, no other scope matches.
      t.upsertFile("src/base.js", [
        {
          symbolId: "Base#constructor",
          fqName: "Base#constructor",
          shortName: "constructor",
          relPath: "src/base.js",
          scope: ["Base"],
        },
      ]);
      const result = r.resolve(
        // Member name not present anywhere — forces walk through
        // the constructor scope probe.
        { callText: "super.nonexistent()", receiver: "super", member: "nonexistent", startLine: 1 },
        {
          callerFile: "src/child.js",
          callerScope: ["Child"],
          imports: [],
          symbolTable: t,
          classExtends: { Child: "Base" },
        },
      );
      expect(result).not.toBeNull();
      expect(result?.targetRelPath).toBe("src/base.js");
      expect(result?.targetSymbolId).toBeNull();
    });
  });
});

// `ctx` helper is defined but only used by mapJavascriptImportToFile
// tests above — keep a no-op reference so the helper passes lint.
void ctx;
