import Parser from "tree-sitter";
import GoLang from "tree-sitter-go";
import { describe, expect, it } from "vitest";

import { extractFromGoFile } from "../../../../../../src/core/domains/language/go/walker/walker.js";

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

// bd tea-rags-mcp-6g9c — local-variable type bindings. Go has no `self`/
// `this`: receivers are user-named AND local vars carry the only static
// type hint for `engine.Use()`-style calls inside `func Default()`. Without
// `var x Foo` / `x := Foo{}` / `x := &Foo{}` bindings, the resolver drops
// every `engine.Use()` edge (no import matches the bare receiver `engine`,
// so the m46z drop fires). Constructor-return `x := NewFoo()` is OUT OF
// SCOPE — the return type can't be known statically without modelling
// every constructor.
describe("extractFromGoFile — local var bindings", () => {
  it("captures `var engine Engine` → { engine: 'Engine' }", () => {
    const src = ["package gin", "func Default() {", "  var engine Engine", "  engine.Use()", "}", ""].join("\n");
    const r = extractFromGoFile({
      tree: parse(src),
      code: src,
      relPath: "gin.go",
      language: "go",
      chunks: [{ symbolId: "Default", scope: [], startLine: 2, endLine: 5 }],
    });
    expect(r.chunks[0].localBindings?.engine).toBe("Engine");
  });

  it("captures short composite-literal decl `x := Engine{}` → { x: 'Engine' }", () => {
    const src = ["package gin", "func Default() {", "  x := Engine{}", "  x.With()", "}", ""].join("\n");
    const r = extractFromGoFile({
      tree: parse(src),
      code: src,
      relPath: "gin.go",
      language: "go",
      chunks: [{ symbolId: "Default", scope: [], startLine: 2, endLine: 5 }],
    });
    expect(r.chunks[0].localBindings?.x).toBe("Engine");
  });

  it("captures short pointer composite-literal decl `y := &Engine{}` → { y: 'Engine' }", () => {
    const src = ["package gin", "func Default() {", "  y := &Engine{}", "  y.Use()", "}", ""].join("\n");
    const r = extractFromGoFile({
      tree: parse(src),
      code: src,
      relPath: "gin.go",
      language: "go",
      chunks: [{ symbolId: "Default", scope: [], startLine: 2, endLine: 5 }],
    });
    expect(r.chunks[0].localBindings?.y).toBe("Engine");
  });

  it("does NOT bind constructor-return `z := NewEngine()` (out of scope)", () => {
    const src = ["package gin", "func Default() {", "  z := NewEngine()", "  z.Use()", "}", ""].join("\n");
    const r = extractFromGoFile({
      tree: parse(src),
      code: src,
      relPath: "gin.go",
      language: "go",
      chunks: [{ symbolId: "Default", scope: [], startLine: 2, endLine: 5 }],
    });
    expect(r.chunks[0].localBindings?.z).toBeUndefined();
  });

  it("unwraps pointer + generic var types: `var p *Engine` / `var b Box[T]` → bare type", () => {
    // `var p *Engine` exercises the pointer-type unwrap and `var b Box[T]`
    // the generic-type base strip in the var-decl binding path — the same
    // shapes readParamBareType handles for receivers / params.
    const src = ["package gin", "func Default() {", "  var p *Engine", "  var b Box[Handler]", "}", ""].join("\n");
    const r = extractFromGoFile({
      tree: parse(src),
      code: src,
      relPath: "gin.go",
      language: "go",
      chunks: [{ symbolId: "Default", scope: [], startLine: 2, endLine: 5 }],
    });
    expect(r.chunks[0].localBindings?.p).toBe("Engine");
    expect(r.chunks[0].localBindings?.b).toBe("Box");
  });

  it("does NOT bind a pointer composite literal of a non-identifier type `m := &map[string]int{}`", () => {
    // `&map[string]int{}` has no bare type_identifier — readCompositeLiteralType
    // must return null rather than fabricate a binding.
    const src = ["package gin", "func Default() {", "  m := &map[string]int{}", "  _ = m", "}", ""].join("\n");
    const r = extractFromGoFile({
      tree: parse(src),
      code: src,
      relPath: "gin.go",
      language: "go",
      chunks: [{ symbolId: "Default", scope: [], startLine: 2, endLine: 5 }],
    });
    expect(r.chunks[0].localBindings?.m).toBeUndefined();
  });
});

// bd tea-rags-mcp-6g9c (follow-up) — function-return-type binding. Real gin
// `func Default() *Engine` does `engine := New(); engine.Use(...)`. `engine :=
// New()` is a FUNCTION-RETURN assignment, not a composite literal, so the
// walker can't know `engine`'s type from the chunk alone — but `New`'s DECLARED
// return type IS static. The walker records two things:
//   (a) file-level functionReturnTypes: `New → "Engine"` (strip leading `*`).
//   (b) per-chunk localCallBindings: `engine → "New"` (varName → called func).
// The resolver later composes (b)+(a) → `engine → "Engine"` and feeds the
// existing resolveByLocalType. The walker stays pure — no resolution here.
describe("extractFromGoFile — functionReturnTypes (file-level)", () => {
  it("captures pointer return `func New() *Engine` → { New: 'Engine' }", () => {
    const src = ["package gin", "func New() *Engine { return &Engine{} }", ""].join("\n");
    const r = extractFromGoFile({ tree: parse(src), code: src, relPath: "gin.go", language: "go", chunks: [] });
    expect(r.functionReturnTypes?.New).toBe("Engine");
  });

  it("captures value return `func Make() Engine` → { Make: 'Engine' }", () => {
    const src = ["package gin", "func Make() Engine { return Engine{} }", ""].join("\n");
    const r = extractFromGoFile({ tree: parse(src), code: src, relPath: "gin.go", language: "go", chunks: [] });
    expect(r.functionReturnTypes?.Make).toBe("Engine");
  });

  it("captures method return `func (c *Context) Build() *Result` keyed by method name → { Build: 'Result' }", () => {
    const src = ["package gin", "func (c *Context) Build() *Result { return nil }", ""].join("\n");
    const r = extractFromGoFile({ tree: parse(src), code: src, relPath: "ctx.go", language: "go", chunks: [] });
    expect(r.functionReturnTypes?.Build).toBe("Result");
  });

  it("does NOT record multi-return `func New() (*Engine, error)` (ambiguous which return feeds the var)", () => {
    const src = ["package gin", "func New() (*Engine, error) { return nil, nil }", ""].join("\n");
    const r = extractFromGoFile({ tree: parse(src), code: src, relPath: "gin.go", language: "go", chunks: [] });
    expect(r.functionReturnTypes?.New).toBeUndefined();
  });

  it("does NOT record a function with no return type `func run()`", () => {
    const src = ["package gin", "func run() { helper() }", ""].join("\n");
    const r = extractFromGoFile({ tree: parse(src), code: src, relPath: "gin.go", language: "go", chunks: [] });
    expect(r.functionReturnTypes?.run).toBeUndefined();
  });

  it("records the bare type for a qualified return `func Pkg() pkg.Thing` → { Pkg: 'Thing' }", () => {
    // pkg.Thing is an external type that won't be in the symbol table, so the
    // resolver naturally drops it — but the walker still records the bare name.
    const src = ["package gin", "func Pkg() pkg.Thing { return pkg.Thing{} }", ""].join("\n");
    const r = extractFromGoFile({ tree: parse(src), code: src, relPath: "gin.go", language: "go", chunks: [] });
    expect(r.functionReturnTypes?.Pkg).toBe("Thing");
  });
});

describe("extractFromGoFile — localCallBindings (per-chunk var := Call())", () => {
  it("captures `engine := New()` → localCallBindings { engine: 'New' }", () => {
    const src = ["package gin", "func Default() {", "  engine := New()", "  engine.Use()", "}", ""].join("\n");
    const r = extractFromGoFile({
      tree: parse(src),
      code: src,
      relPath: "gin.go",
      language: "go",
      chunks: [{ symbolId: "Default", scope: [], startLine: 2, endLine: 5 }],
    });
    expect(r.chunks[0].localCallBindings?.engine).toBe("New");
    // Walker must NOT pre-resolve the type — that's the resolver's job.
    expect(r.chunks[0].localBindings?.engine).toBeUndefined();
  });

  it("captures `e := pkg.New()` → localCallBindings { e: 'New' } (selector func, bare last segment)", () => {
    const src = ["package gin", "func Default() {", "  e := pkg.New()", "  e.Use()", "}", ""].join("\n");
    const r = extractFromGoFile({
      tree: parse(src),
      code: src,
      relPath: "gin.go",
      language: "go",
      chunks: [{ symbolId: "Default", scope: [], startLine: 2, endLine: 5 }],
    });
    expect(r.chunks[0].localCallBindings?.e).toBe("New");
  });

  it("does NOT record multi-LHS `a, b := New(), Other()` (can't pair var↔return)", () => {
    const src = ["package gin", "func Default() {", "  a, b := New(), Other()", "  _ = a", "}", ""].join("\n");
    const r = extractFromGoFile({
      tree: parse(src),
      code: src,
      relPath: "gin.go",
      language: "go",
      chunks: [{ symbolId: "Default", scope: [], startLine: 2, endLine: 5 }],
    });
    expect(r.chunks[0].localCallBindings?.a).toBeUndefined();
    expect(r.chunks[0].localCallBindings?.b).toBeUndefined();
  });

  it("does NOT record a chained-call RHS `x := New().Configure()` (operand is a call, not a pkg ident)", () => {
    const src = ["package gin", "func Default() {", "  x := New().Configure()", "  _ = x", "}", ""].join("\n");
    const r = extractFromGoFile({
      tree: parse(src),
      code: src,
      relPath: "gin.go",
      language: "go",
      chunks: [{ symbolId: "Default", scope: [], startLine: 2, endLine: 5 }],
    });
    expect(r.chunks[0].localCallBindings?.x).toBeUndefined();
  });

  // BOUNDARY (bd tea-rags-mcp-6g9c) — multi-name short decl whose RHS is a
  // SINGLE call returning multiple values (`a, b := foo()`). This differs
  // from the already-covered `a, b := New(), Other()` (two RHS calls): here
  // one call feeds both vars, so the walker cannot statically pair `a` or
  // `b` with a return type. Only the single-LHS, single-call form is
  // handled — locking that this two-name single-call shape binds NOTHING
  // (neither localCallBindings nor localBindings), so a regression that
  // started attributing both vars to `foo`'s return is caught.
  it("does NOT record multi-name single-call decl `a, b := foo()` (can't pair var↔return)", () => {
    const src = ["package gin", "func Default() {", "  a, b := foo()", "  _ = a", "  _ = b", "}", ""].join("\n");
    const r = extractFromGoFile({
      tree: parse(src),
      code: src,
      relPath: "gin.go",
      language: "go",
      chunks: [{ symbolId: "Default", scope: [], startLine: 2, endLine: 6 }],
    });
    expect(r.chunks[0].localCallBindings?.a).toBeUndefined();
    expect(r.chunks[0].localCallBindings?.b).toBeUndefined();
    expect(r.chunks[0].localBindings?.a).toBeUndefined();
    expect(r.chunks[0].localBindings?.b).toBeUndefined();
  });
});
