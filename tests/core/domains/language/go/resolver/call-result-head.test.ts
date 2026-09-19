import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Parser from "tree-sitter";
import GoLang from "tree-sitter-go";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CallContext, CallRef, NamedSymbol } from "../../../../../../src/core/contracts/types/codegraph.js";
import { GoLanguage } from "../../../../../../src/core/domains/language/go/index.js";
import { GoCallResolver } from "../../../../../../src/core/domains/language/go/resolver/go-resolver.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * A receiver that is the RESULT of a bare call — gin's `ginS/gins.go` wraps
 * every route helper as `engine().GET(relativePath, handlers...)`, 25 sites —
 * is typed the way a call-bound local is: through the callee's declared return
 * type (`func engine() *gin.Engine`), behind the same known-type gate. A bare
 * call names a declaration of the caller's own package, so only such a
 * declaration types it; a local function value of that name does not.
 */

const sym = (symbolId: string, relPath: string): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
  relPath,
  scope: [],
});

function ginTable(): InMemoryGlobalSymbolTable {
  const t = new InMemoryGlobalSymbolTable();
  t.upsertFile("gin.go", [sym("Engine", "gin.go"), sym("Engine#Run", "gin.go")]);
  t.upsertFile("routergroup.go", [sym("RouterGroup", "routergroup.go"), sym("RouterGroup#GET", "routergroup.go")]);
  t.upsertFile("ginS/gins.go", [sym("engine", "ginS/gins.go")]);
  return t;
}

/**
 * gin's root: its go.mod makes `github.com/gin-gonic/gin` the root package, the
 * one declaring `Engine` — what the walker's recorded `engine` result names.
 */
let ginRoot: string;

beforeAll(() => {
  ginRoot = mkdtempSync(join(tmpdir(), "tea-rags-go-gin-root-"));
  writeFileSync(join(ginRoot, "go.mod"), "module github.com/gin-gonic/gin\n\ngo 1.26.0\n", "utf8");
});

afterAll(() => {
  rmSync(ginRoot, { recursive: true, force: true });
});

function ginsCtx(over: Partial<CallContext> = {}): CallContext {
  return {
    callerFile: "ginS/gins.go",
    callerScope: [],
    imports: [],
    symbolTable: ginTable(),
    projectRoot: ginRoot,
    // What the walker records for `var engine = sync.OnceValue(func() *gin.Engine {…})`
    // (asserted below): keyed by the declaring package (bd tea-rags-mcp-7h6j0),
    // the value the import path and the type, not a bare `Engine`.
    functionReturnTypes: { "ginS::engine": "github.com/gin-gonic/gin.Engine" },
    classFieldTypesByClassKey: {
      "gin.go::Engine": { RouterGroup: "RouterGroup", "embedded:RouterGroup": "RouterGroup" },
      "routergroup.go::RouterGroup": {},
    },
    ...over,
  };
}

const call = (receiver: string, member: string): CallRef => ({
  callText: `${receiver}.${member}()`,
  receiver,
  member,
  startLine: 5,
});

const resolver = new GoCallResolver(new DefaultSymbolIdComposer());

describe("GoCallResolver — call-result receiver heads", () => {
  it("types `engine().Run()` through engine's declared return type", () => {
    expect(resolver.resolve(call("engine()", "Run"), ginsCtx())).toEqual({
      targetRelPath: "gin.go",
      targetSymbolId: "Engine#Run",
    });
  });

  it("promotes through embedding: `engine().GET(...)` → RouterGroup#GET", () => {
    expect(resolver.resolve(call("engine()", "GET"), ginsCtx())?.targetSymbolId).toBe("RouterGroup#GET");
  });

  it("NEGATIVE: a return type naming no known type binds nothing", () => {
    expect(resolver.resolve(call("engine()", "Run"), ginsCtx({ functionReturnTypes: {} }))).toBeNull();
  });

  it("NEGATIVE: a callee not declared in the caller's package types nothing", () => {
    expect(resolver.resolve(call("engine()", "Run"), ginsCtx({ callerFile: "other/other.go" }))).toBeNull();
  });

  it("NEGATIVE: a local function value of the callee's name types nothing", () => {
    const ctx = ginsCtx({ localBindings: { engine: [{ line: 1, type: "" }] } });
    expect(resolver.resolve(call("engine()", "Run"), ctx)).toBeNull();
  });

  it("NEGATIVE: the result of calling a call's result is not the callee's return type", () => {
    expect(resolver.resolve(call("engine()()", "Run"), ginsCtx())).toBeNull();
  });
});

/**
 * gin's `engine` is no function declaration: it is the package-level
 * `var engine = sync.OnceValue(func() *gin.Engine { … })`, a func VALUE whose
 * call yields the literal's result. The walker records what calling such a
 * var returns alongside the declared functions' return types, so the head
 * above is typed at all.
 */
function walkReturnTypes(lines: string[]): Record<string, string> | undefined {
  const src = `${lines.join("\n")}\n`;
  const parser = new Parser();
  parser.setLanguage(GoLang);
  return new GoLanguage().walker.walk({
    tree: parser.parse(src),
    code: src,
    relPath: "ginS/gins.go",
    language: "go",
    chunks: [],
  }).functionReturnTypes;
}

describe("Go walker — what calling a package-level func-valued var returns", () => {
  it("records `var engine = sync.OnceValue(func() *gin.Engine {…})` (gin's ginS)", () => {
    const types = walkReturnTypes([
      "package ginS",
      'import (\n\t"sync"\n\n\t"github.com/gin-gonic/gin"\n)',
      "var engine = sync.OnceValue(func() *gin.Engine {",
      "\treturn gin.Default()",
      "})",
    ]);
    expect(types?.["ginS::engine"]).toBe("github.com/gin-gonic/gin.Engine");
  });

  it("records a pointer to a package-qualified type as the qualified form reads: the import path, then the type", () => {
    const types = walkReturnTypes([
      "package app",
      'import "example.com/app/render"',
      "func Build() *render.JSON { return nil }",
      "func Value() render.JSON { return render.JSON{} }",
    ]);
    expect(types?.["ginS::Build"]).toBe("example.com/app/render.JSON");
    expect(types?.["ginS::Build"]).toBe(types?.["ginS::Value"]);
  });

  it("records a var initialized by a function literal, and a var of a func type", () => {
    const types = walkReturnTypes([
      "package app",
      "var build = func() *Engine { return nil }",
      "var factory func(name string) Engine",
    ]);
    expect(types?.["ginS::build"]).toBe("Engine");
    expect(types?.["ginS::factory"]).toBe("Engine");
  });

  it("NEGATIVE: a wrapper other than the standard library's sync.OnceValue records nothing", () => {
    const types = walkReturnTypes([
      "package app",
      'import (\n\tsync "example.com/mysync"\n\t"example.com/lazy"\n)',
      "var a = sync.OnceValue(func() *Engine { return nil })",
      "var b = lazy.OnceValue(func() *Engine { return nil })",
    ]);
    expect(types?.["ginS::a"]).toBeUndefined();
    expect(types?.["ginS::b"]).toBeUndefined();
  });

  it("types gin's `engine().GET(…)` end to end, walker to resolver", () => {
    const lines = [
      "package ginS",
      'import (\n\t"sync"\n\n\t"github.com/gin-gonic/gin"\n)',
      "var engine = sync.OnceValue(func() *gin.Engine {",
      "\treturn gin.Default()",
      "})",
      "func GET(relativePath string) {",
      "\tengine().GET(relativePath)",
      "}",
    ];
    const src = `${lines.join("\n")}\n`;
    const parser = new Parser();
    parser.setLanguage(GoLang);
    const go = new GoLanguage();
    const funcLine = src.split("\n").findIndex((l) => l.startsWith("func GET")) + 1;
    const extraction = go.walker.walk({
      tree: parser.parse(src),
      code: src,
      relPath: "ginS/gins.go",
      language: "go",
      chunks: [{ symbolId: "GET", scope: [], startLine: funcLine, endLine: funcLine + 2 }],
    });
    const table = ginTable();
    table.upsertFile("ginS/gins.go", [sym("GET", "ginS/gins.go")]);
    const [site] = extraction.chunks[0].calls;
    // The run's project root, as production hands it over: gin's go.mod makes
    // `github.com/gin-gonic/gin` the root package, the one declaring `Engine`.
    const root = mkdtempSync(join(tmpdir(), "tea-rags-go-gins-"));
    try {
      writeFileSync(join(root, "go.mod"), "module github.com/gin-gonic/gin\n\ngo 1.26.0\n", "utf8");
      const target = go.resolver.resolve(site, {
        ...ginsCtx({ symbolTable: table }),
        imports: extraction.imports,
        functionReturnTypes: extraction.functionReturnTypes,
        projectRoot: root,
      });
      expect(target?.targetSymbolId).toBe("RouterGroup#GET");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
