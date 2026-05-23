import Parser from "tree-sitter";
import GoLang from "tree-sitter-go";
import { describe, expect, it } from "vitest";

import { extractFromGoFile } from "../../../../../../../src/core/domains/ingest/pipeline/chunker/extraction/go-walker.js";

function parse(src: string) {
  const p = new Parser();
  p.setLanguage(GoLang as unknown as Parser.Language);
  return p.parse(src);
}

describe("extractFromGoFile — imports", () => {
  it('captures single-line `import "foo/bar"`', () => {
    const src = 'package main\nimport "foo/bar"\n';
    const r = extractFromGoFile({ tree: parse(src), code: src, relPath: "main.go", language: "go", chunks: [] });
    expect(r.imports.map((i) => i.importText)).toEqual(["foo/bar"]);
  });

  it('captures grouped `import ( "a"; "b/c" )`', () => {
    const src = 'package main\nimport (\n  "a"\n  "b/c"\n)\n';
    const r = extractFromGoFile({ tree: parse(src), code: src, relPath: "main.go", language: "go", chunks: [] });
    expect(r.imports.map((i) => i.importText).sort()).toEqual(["a", "b/c"]);
  });

  it("captures import with alias (the path, alias dropped)", () => {
    const src = 'package main\nimport alias "foo/bar"\n';
    const r = extractFromGoFile({ tree: parse(src), code: src, relPath: "main.go", language: "go", chunks: [] });
    expect(r.imports.map((i) => i.importText)).toEqual(["foo/bar"]);
  });

  it("records startLine per import", () => {
    const src = 'package main\nimport (\n  "a"\n  "b"\n)\n';
    const r = extractFromGoFile({ tree: parse(src), code: src, relPath: "x.go", language: "go", chunks: [] });
    const lines = r.imports.map((i) => i.startLine).sort();
    expect(lines).toEqual([3, 4]);
  });
});

describe("extractFromGoFile — calls", () => {
  it("captures `pkg.Func()`", () => {
    const src = "package main\nfunc main() { pkg.Func() }\n";
    const r = extractFromGoFile({
      tree: parse(src),
      code: src,
      relPath: "main.go",
      language: "go",
      chunks: [{ symbolId: "main", scope: [], startLine: 2, endLine: 2 }],
    });
    const c = r.chunks[0].calls[0];
    expect(c.receiver).toBe("pkg");
    expect(c.member).toBe("Func");
  });

  it("captures bare calls", () => {
    // Avoid `go` — Go keyword for goroutines, not a function call.
    const src = "package main\nfunc main() { run() }\n";
    const r = extractFromGoFile({
      tree: parse(src),
      code: src,
      relPath: "main.go",
      language: "go",
      chunks: [{ symbolId: "main", scope: [], startLine: 2, endLine: 2 }],
    });
    const c = r.chunks[0].calls[0];
    expect(c.receiver).toBeNull();
    expect(c.member).toBe("run");
  });
});

describe("extractFromGoFile — edge cases", () => {
  it("empty file returns empty extraction", () => {
    const r = extractFromGoFile({ tree: parse(""), code: "", relPath: "x.go", language: "go", chunks: [] });
    expect(r.imports).toEqual([]);
  });

  it("ignores comments", () => {
    const src = 'package main\n// import "fake"\nimport "real"\n';
    const r = extractFromGoFile({ tree: parse(src), code: src, relPath: "x.go", language: "go", chunks: [] });
    expect(r.imports.map((i) => i.importText)).toEqual(["real"]);
  });
});

// Selector-expression vs identifier call dispatch — coexisting in one
// body so the per-node branch in collectGoCalls is exercised twice.
describe("extractFromGoFile — call dispatch", () => {
  it("captures `pkg.Func()` alongside bare `helper()` in same body", () => {
    const src = "package main\nfunc main() {\n  pkg.Func()\n  helper()\n}\n";
    const r = extractFromGoFile({
      tree: parse(src),
      code: src,
      relPath: "main.go",
      language: "go",
      chunks: [{ symbolId: "main", scope: [], startLine: 2, endLine: 5 }],
    });
    const pkgFunc = r.chunks[0].calls.find((c) => c.member === "Func");
    const helper = r.chunks[0].calls.find((c) => c.member === "helper");
    expect(pkgFunc?.receiver).toBe("pkg");
    expect(helper?.receiver).toBeNull();
  });
});

// bd tea-rags-mcp-e6xx — per-chunk localBindings (receiver + parameters).
// The resolver consumes `ctx.localBindings[receiver]` to turn a typed-call
// like `c.JSON(...)` inside `(c *Context) Render(...)` into the qualified
// `Context#JSON` target. Without the walker emitting bindings, the resolver
// has no type info and the edge is dropped, yielding 0 callgraph edges
// across an entire Go project (e.g. gin's 1000+ method calls all unresolved).
describe("extractFromGoFile — localBindings", () => {
  it("captures pointer-receiver type binding `c *Context` → { c: 'Context' }", () => {
    const src = ["package gin", "func (c *Context) Render() {", "  c.JSON()", "}", ""].join("\n");
    const r = extractFromGoFile({
      tree: parse(src),
      code: src,
      relPath: "context.go",
      language: "go",
      chunks: [{ symbolId: "Context#Render", scope: [], startLine: 2, endLine: 4 }],
    });
    expect(r.chunks[0].localBindings?.c).toBe("Context");
  });

  it("captures value-receiver type binding `s Service` → { s: 'Service' }", () => {
    const src = ["package gin", "func (s Service) Open() {", "  s.connect()", "}", ""].join("\n");
    const r = extractFromGoFile({
      tree: parse(src),
      code: src,
      relPath: "service.go",
      language: "go",
      chunks: [{ symbolId: "Service#Open", scope: [], startLine: 2, endLine: 4 }],
    });
    expect(r.chunks[0].localBindings?.s).toBe("Service");
  });

  it("captures parameter pointer-type bindings `func f(c *Context)` → { c: 'Context' }", () => {
    const src = ["package gin", "func render(c *Context, status int) {", "  c.JSON()", "}", ""].join("\n");
    const r = extractFromGoFile({
      tree: parse(src),
      code: src,
      relPath: "render.go",
      language: "go",
      chunks: [{ symbolId: "render", scope: [], startLine: 2, endLine: 4 }],
    });
    expect(r.chunks[0].localBindings?.c).toBe("Context");
  });

  it("top-level function without typed pointer params has no bindings (or empty)", () => {
    const src = "package gin\nfunc helper() int { return 1 }\n";
    const r = extractFromGoFile({
      tree: parse(src),
      code: src,
      relPath: "h.go",
      language: "go",
      chunks: [{ symbolId: "helper", scope: [], startLine: 2, endLine: 2 }],
    });
    // Either undefined (preferred — walker omits empty maps) or an empty object.
    const bindings = r.chunks[0].localBindings;
    if (bindings) expect(Object.keys(bindings)).toHaveLength(0);
  });
});
