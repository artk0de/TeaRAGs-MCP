import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Parser from "tree-sitter";
import GoLang from "tree-sitter-go";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CallContext, FileExtraction, NamedSymbol } from "../../../../../../src/core/contracts/types/codegraph.js";
import { GoLanguage } from "../../../../../../src/core/domains/language/go/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * bd tea-rags-mcp-e6xx — a type from ANOTHER package is that package's type,
 * never a project namesake. The walker used to record a function's
 * package-qualified result (`func newHTTP() *http.Client`) by its bare name,
 * `Client`, and the resolver's only gate was "some Go type named `Client`
 * exists in the project" — so a project `api.Client` with a `Do` method took
 * every `c.Do(req)` made on a standard-library `*http.Client`. A qualified
 * callee had the same hole: `httptest.NewServer` was looked up by its bare
 * name in the run-global return-type map and typed as the project's
 * `NewServer` result.
 *
 * A qualified type now keeps its package — as the import path the file's
 * import binds — and types a receiver only when the module map says that path
 * is a PROJECT package declaring the type; a qualified callee types its local
 * only when its package is a project package declaring the function. Walker
 * and resolver together, over a go.mod root, shaped after the re-validator's
 * `gocorpus-r2`.
 */

const sym = (symbolId: string, relPath: string): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
  relPath,
  scope: [],
});

const API = [
  "package api",
  "",
  "type Client struct {",
  "\tName string",
  "}",
  "",
  "func (c *Client) Do() error { return nil }",
  "",
  "func (c *Client) Get(url string) error { return nil }",
  "",
  "type Server struct{}",
  "",
  "func NewServer() *Server { return &Server{} }",
  "",
  "func (s *Server) Close() {}",
];

const APP = [
  "package app",
  "",
  "import (",
  '\t"net/http"',
  '\t"net/http/httptest"',
  '\t"sync"',
  "",
  '\t"example.com/r2/api"',
  ")",
  "",
  "func newHTTP() *http.Client { return &http.Client{} }",
  "",
  "func stdlibCallBinding(req *http.Request) {",
  "\tc := newHTTP()",
  "\tc.Do(req)",
  "}",
  "",
  "func stdlibCallHead(req *http.Request) {",
  "\tnewHTTP().Do(req)",
  "}",
  "",
  "var client = sync.OnceValue(func() *http.Client { return &http.Client{} })",
  "",
  "func stdlibOnce() {",
  '\tclient().Get("x")',
  "}",
  "",
  "func newHTTPValue() http.Client { return http.Client{} }",
  "",
  "func stdlibValueBinding(req *http.Request) {",
  "\tv := newHTTPValue()",
  "\tv.Do(req)",
  "}",
  "",
  "var factory func() *http.Client",
  "",
  "func stdlibFuncVar() {",
  '\tfactory().Get("y")',
  "}",
  "",
  "func stdlibNamesake() {",
  "\tsrv := httptest.NewServer(nil)",
  "\tsrv.Close()",
  "}",
  "",
  "func newAPI() *api.Client { return &api.Client{} }",
  "",
  "func projectCallBinding() {",
  "\tc := newAPI()",
  "\tc.Do()",
  "}",
  "",
  "func projectCallHead() {",
  '\tnewAPI().Get("z")',
  "}",
  "",
  "func projectConstructor() {",
  "\tsrv := api.NewServer()",
  "\tsrv.Close()",
  "}",
];

function walk(relPath: string, lines: string[]): FileExtraction {
  const src = `${lines.join("\n")}\n`;
  const parser = new Parser();
  parser.setLanguage(GoLang);
  const tree = parser.parse(src);
  const chunks = tree.rootNode.children
    .filter((node) => node.type === "function_declaration" || node.type === "method_declaration")
    .map((node) => ({
      symbolId: node.childForFieldName("name")?.text ?? "",
      scope: [],
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    }));
  return new GoLanguage().walker.walk({ tree, code: src, relPath, language: "go", chunks });
}

describe("Go types and callees from a package outside the project", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tea-rags-go-external-"));
    writeFileSync(join(root, "go.mod"), "module example.com/r2\n\ngo 1.22\n", "utf8");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Every call of `app/app.go`, keyed `<enclosing func>:<receiver>.<member>`. */
  function resolveApp(): Map<string, string | null> {
    const api = walk("api/client.go", API);
    const app = walk("app/app.go", APP);
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile(
      "api/client.go",
      ["Client", "Client#Do", "Client#Get", "Server", "NewServer", "Server#Close"].map((id) =>
        sym(id, "api/client.go"),
      ),
    );
    table.upsertFile(
      "app/app.go",
      app.chunks.map((chunk) => sym(chunk.symbolId, "app/app.go")),
    );
    const go = new GoLanguage();
    go.resolver.prepareResolvePass?.({ expectedFileCount: 2, projectRoot: root });
    const out = new Map<string, string | null>();
    for (const chunk of app.chunks) {
      const ctx: CallContext = {
        callerFile: "app/app.go",
        callerScope: [],
        imports: app.imports,
        symbolTable: table,
        projectRoot: root,
        localBindings: chunk.localBindings,
        callResultBindings: chunk.callResultBindings,
        // Run-global in production: every file's return types, merged.
        functionReturnTypes: { ...api.functionReturnTypes, ...app.functionReturnTypes },
        classFieldTypesByClassKey: { ...api.classFieldTypesByClassKey, ...app.classFieldTypesByClassKey },
      };
      for (const call of chunk.calls) {
        const target = go.resolver.resolve(call, ctx);
        out.set(
          `${chunk.symbolId}:${call.receiver}.${call.member}`,
          target ? `${target.targetSymbolId} @ ${target.targetRelPath}` : null,
        );
      }
    }
    return out;
  }

  it("NEGATIVE: a local bound to a call returning `*http.Client` is not the project's Client", () => {
    expect(resolveApp().get("stdlibCallBinding:c.Do")).toBeNull();
  });

  it("NEGATIVE: the result of a call returning `*http.Client` is not the project's Client", () => {
    expect(resolveApp().get("stdlibCallHead:newHTTP().Do")).toBeNull();
  });

  it("NEGATIVE: a `sync.OnceValue` of `*http.Client` is not the project's Client", () => {
    expect(resolveApp().get("stdlibOnce:client().Get")).toBeNull();
  });

  it("NEGATIVE: a non-pointer `http.Client` result is not the project's Client", () => {
    expect(resolveApp().get("stdlibValueBinding:v.Do")).toBeNull();
  });

  it("NEGATIVE: a func-typed var yielding `*http.Client` is not the project's Client", () => {
    expect(resolveApp().get("stdlibFuncVar:factory().Get")).toBeNull();
  });

  it("NEGATIVE: `httptest.NewServer` is not typed through the project's `NewServer`", () => {
    expect(resolveApp().get("stdlibNamesake:srv.Close")).toBeNull();
  });

  it("types a result qualified with a PROJECT package through that package's type", () => {
    const resolved = resolveApp();
    expect(resolved.get("projectCallBinding:c.Do")).toBe("Client#Do @ api/client.go");
    expect(resolved.get("projectCallHead:newAPI().Get")).toBe("Client#Get @ api/client.go");
  });

  it("types a local bound to a qualified PROJECT constructor", () => {
    expect(resolveApp().get("projectConstructor:srv.Close")).toBe("Server#Close @ api/client.go");
  });
});

/**
 * What the walker records for a package-qualified result: the import path its
 * qualifier binds in the declaring file, then the type name — the one address
 * a resolver in ANY file can check against the module map.
 */
function walkReturnTypes(lines: string[]): Record<string, string> | undefined {
  return walk("app/app.go", lines).functionReturnTypes;
}

describe("Go walker — package-qualified return types keep their package", () => {
  it("records `*pkg.T` and `pkg.T` under the import path the qualifier binds", () => {
    const types = walkReturnTypes([
      "package app",
      'import "net/http"',
      "func a() *http.Client { return nil }",
      "func b() http.Client { return http.Client{} }",
    ]);
    expect(types?.a).toBe("net/http.Client");
    expect(types?.b).toBe("net/http.Client");
  });

  it("reads an aliased import's path, not the alias", () => {
    const types = walkReturnTypes(["package app", 'import h "net/http"', "func a() *h.Client { return nil }"]);
    expect(types?.a).toBe("net/http.Client");
  });

  it("keeps a module-path import whole, dots included (gin's `*gin.Engine`)", () => {
    const types = walkReturnTypes([
      "package ginS",
      'import "github.com/gin-gonic/gin"',
      "func engine() *gin.Engine { return nil }",
    ]);
    expect(types?.engine).toBe("github.com/gin-gonic/gin.Engine");
  });

  it("records an unqualified result bare, as before", () => {
    const types = walkReturnTypes(["package app", "func a() *Engine { return nil }"]);
    expect(types?.a).toBe("Engine");
  });
});
