import { describe, expect, it } from "vitest";

import { resolveGoFiles } from "../__helpers__/go-corpus.js";
import type { ImportRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import { goImportBoundName } from "../../../../../../src/core/domains/language/go/import-binding.js";

/**
 * bd tea-rags-mcp-e6xx, G2-1 — the qualifier a plain Go import binds is its
 * package clause, and the ONLY evidence the importing file carries is the path.
 * Go's tooling assumes a name from it (`golang.org/x/tools`
 * `ImportPathToAssumedName`): a trailing major-version element `/vN` is not the
 * name, the name ends at the first character no identifier holds (`yaml.v3` →
 * `yaml`), and a leading `go-` is dropped (`go-json` → `json`). Taking the last
 * path segment instead bound `v4` for echo, so `echo.New()` named no import and
 * was read as a METHOD call on a value — and the project's own `New() *Server`
 * typed the local. Each corpus below is one of the G2 re-validator's.
 */

const plain = (importText: string): ImportRef => ({ importText, startLine: 1 });

describe("goImportBoundName — Go's assumed-name rule", () => {
  it.each([
    ["net/http", "http"],
    ["github.com/gin-gonic/gin", "gin"],
    ["github.com/labstack/echo/v4", "echo"],
    ["example.com/lib/v2", "lib"],
    ["gopkg.in/yaml.v3", "yaml"],
    ["gopkg.in/lib.v3", "lib"],
    ["github.com/goccy/go-json", "json"],
    ["github.com/pelletier/go-toml/v2", "toml"],
    ["github.com/mattn/go-sqlite3", "sqlite3"],
    ["v2", "v2"],
  ])("`%s` binds `%s`", (importText, bound) => {
    expect(goImportBoundName(plain(importText))).toBe(bound);
  });

  it("an explicit alias always wins; a dot or blank import binds no qualifier", () => {
    expect(goImportBoundName({ ...plain("github.com/labstack/echo/v4"), importedNames: ["e"] })).toBe("e");
    expect(goImportBoundName({ ...plain("net/http"), importedNames: ["."] })).toBeUndefined();
    expect(goImportBoundName({ ...plain("net/http"), importedNames: ["_"] })).toBeUndefined();
  });
});

const G2H = {
  "go.mod": "module example.com/svc\n\ngo 1.22\n",
  "app/app.go": [
    "package app",
    "",
    "import (",
    '\t"io"',
    '\t"net/http/httptest"',
    "",
    '\t"github.com/goccy/go-json"',
    '\t"github.com/labstack/echo/v4"',
    '\t"gopkg.in/yaml.v3"',
    ")",
    "",
    "func serve() {",
    "\te := echo.New()",
    '\te.Start(":8080")',
    "}",
    "",
    "func decodeYAML(r io.Reader, v any) {",
    "\td := yaml.NewDecoder(r)",
    "\td.Decode(v)",
    "}",
    "",
    "func decodeJSON(r io.Reader, v any) {",
    "\td := json.NewDecoder(r)",
    "\td.Decode(v)",
    "}",
    "",
    "func control() {",
    "\ts := httptest.NewServer(nil)",
    "\ts.Close()",
    "}",
    "",
  ].join("\n"),
  "codec/codec.go": [
    "package codec",
    "",
    'import "io"',
    "",
    "type Decoder struct{}",
    "",
    "func NewDecoder(r io.Reader) *Decoder { return &Decoder{} }",
    "",
    "func (d *Decoder) Decode(v any) error { return nil }",
    "",
  ].join("\n"),
  "server/server.go": [
    "package server",
    "",
    "type Server struct{}",
    "",
    "func New() *Server { return &Server{} }",
    "",
    "func (s *Server) Start(addr string) error { return nil }",
    "",
  ].join("\n"),
};

describe("an EXTERNAL package whose bound name is not its path's last segment (g2h)", () => {
  it("NEGATIVE: `echo.New()` from `…/echo/v4` does not type its local as the project's `Server`", () => {
    const sites = resolveGoFiles(G2H);
    expect(sites.get("app/app.go:13 echo.New")).toBeNull();
    expect(sites.get("app/app.go:14 e.Start")).toBeNull();
  });

  it("NEGATIVE: `yaml.NewDecoder` (`gopkg.in/yaml.v3`) and `json.NewDecoder` (`go-json`) are not the project's", () => {
    const sites = resolveGoFiles(G2H);
    expect(sites.get("app/app.go:19 d.Decode")).toBeNull();
    expect(sites.get("app/app.go:24 d.Decode")).toBeNull();
  });

  it("NEGATIVE (control): a bound name that matches the path stays external", () => {
    expect(resolveGoFiles(G2H).get("app/app.go:29 s.Close")).toBeNull();
  });
});

/** A PROJECT module imported under a version-suffixed path: the qualifier is the package clause, `lib`. */
function versionedLibCorpus(modulePath: string): Record<string, string> {
  return {
    "go.mod": `module ${modulePath}\n\ngo 1.22\n`,
    "lib.go": [
      "package lib",
      "",
      "type Engine struct{}",
      "",
      "func New() *Engine { return &Engine{} }",
      "",
      "func (e *Engine) Run() {}",
      "",
    ].join("\n"),
    "cmd/cmd.go": [
      "package cmd",
      "",
      `import "${modulePath}"`,
      "",
      "func build() *lib.Engine { return lib.New() }",
      "",
      "func useBuild() {",
      "\te := build()",
      "\te.Run()",
      "\tbuild().Run()",
      "}",
      "",
      "func useNew() {",
      "\te := lib.New()",
      "\te.Run()",
      "}",
      "",
    ].join("\n"),
  };
}

describe("a PROJECT module under a `/vN` or `gopkg.in` path (g2b, g2f)", () => {
  it.each([["example.com/lib/v2"], ["gopkg.in/lib.v3"]])("`%s` — calls through `lib` resolve", (modulePath) => {
    const sites = resolveGoFiles(versionedLibCorpus(modulePath));
    expect(sites.get("cmd/cmd.go:5 lib.New")).toBe("New @ lib.go");
    expect(sites.get("cmd/cmd.go:9 e.Run")).toBe("Engine#Run @ lib.go");
    expect(sites.get("cmd/cmd.go:10 build().Run")).toBe("Engine#Run @ lib.go");
    expect(sites.get("cmd/cmd.go:14 lib.New")).toBe("New @ lib.go");
    expect(sites.get("cmd/cmd.go:15 e.Run")).toBe("Engine#Run @ lib.go");
  });
});

describe("a PROJECT package whose package clause is not the assumed name", () => {
  const corpus = {
    "go.mod": "module example.com/proj\n\ngo 1.22\n",
    "api/v1/types.go": [
      "package v1",
      "",
      "type Pod struct{}",
      "",
      "func NewPod() *Pod { return &Pod{} }",
      "",
      "func (p *Pod) Run() {}",
      "",
    ].join("\n"),
    "internal/json-iter/iter.go": [
      "// Package jsoniter is spelled differently from its directory.",
      "package jsoniter",
      "",
      "type Iterator struct{}",
      "",
      "func Parse() *Iterator { return &Iterator{} }",
      "",
      "func (it *Iterator) Next() {}",
      "",
    ].join("\n"),
    "app/app.go": [
      "package app",
      "",
      "import (",
      '\t"example.com/proj/api/v1"',
      '\t"example.com/proj/internal/json-iter"',
      ")",
      "",
      "func use() {",
      "\tp := v1.NewPod()",
      "\tp.Run()",
      "\tit := jsoniter.Parse()",
      "\tit.Next()",
      "}",
      "",
    ].join("\n"),
  };

  it("binds the qualifier the package's own `package` clause declares", () => {
    const sites = resolveGoFiles(corpus);
    expect(sites.get("app/app.go:9 v1.NewPod")).toBe("NewPod @ api/v1/types.go");
    expect(sites.get("app/app.go:10 p.Run")).toBe("Pod#Run @ api/v1/types.go");
    expect(sites.get("app/app.go:11 jsoniter.Parse")).toBe("Parse @ internal/json-iter/iter.go");
    expect(sites.get("app/app.go:12 it.Next")).toBe("Iterator#Next @ internal/json-iter/iter.go");
  });
});

/**
 * F3-4 (the re-validator's corpus `f3c`) — a build-ignored file in a package
 * directory may declare another package (`lib/a_tools.go`, `//go:build
 * ignore` + `package tools`). Read as the package's clause, it bound the
 * import to `tools`, and the clause read being certain, the assumed `lib` no
 * longer applied.
 */
describe("a PROJECT package beside a build-ignored file of another package (f3c)", () => {
  const corpus = {
    "go.mod": "module example.com/proj\n\ngo 1.22\n",
    "app/app.go": [
      "package app",
      "",
      "import (",
      '\t"example.com/proj/internal/go-foo-bar"',
      '\t"example.com/proj/lib"',
      ")",
      "",
      "// Z1: lib's first file (by name) is a build-ignored `package tools`.",
      "func z1() {",
      "\te := lib.New()",
      "\te.Run()",
      "}",
      "",
      "// Z2: directory go-foo-bar declares `package foobar` (assumed name would be `foo`).",
      "func z2() {",
      "\tt := foobar.Make()",
      "\tt.Go()",
      "}",
      "",
    ].join("\n"),
    "internal/go-foo-bar/x.go": [
      "package foobar",
      "",
      "type Thing struct{}",
      "",
      "func Make() *Thing { return &Thing{} }",
      "",
      "func (t *Thing) Go() {}",
      "",
    ].join("\n"),
    "lib/a_tools.go": ["//go:build ignore", "", "package tools", "", "func Gen() {}", ""].join("\n"),
    "lib/lib.go": [
      "package lib",
      "",
      "type Engine struct{}",
      "",
      "func New() *Engine { return &Engine{} }",
      "",
      "func (e *Engine) Run() {}",
      "",
    ].join("\n"),
  };

  it("binds the qualifier the package's buildable files declare", () => {
    const sites = resolveGoFiles(corpus);
    expect(sites.get("app/app.go:10 lib.New")).toBe("New @ lib/lib.go");
    expect(sites.get("app/app.go:11 e.Run")).toBe("Engine#Run @ lib/lib.go");
  });

  it("control: a clause that differs from the assumed name still binds", () => {
    const sites = resolveGoFiles(corpus);
    expect(sites.get("app/app.go:16 foobar.Make")).toBe("Make @ internal/go-foo-bar/x.go");
    expect(sites.get("app/app.go:17 t.Go")).toBe("Thing#Go @ internal/go-foo-bar/x.go");
  });
});

/**
 * F4 / N1 (the re-validator's corpora `f4c/lib5`, `f4d/zeta`) — a doc.go block
 * comment whose prose starts a line with "package" is no package clause. Read
 * as one, `package being` disagreed with the package's real files and the
 * clause went unread: under dir `lib5`, package `eps`, nothing bound `eps`
 * (regression); under dir `zeta`, package `zeta`, only the assumed name
 * rescued the call (converse — it must keep resolving).
 */
describe("a PROJECT package documented by a block comment that mentions `package` (f4c, f4d)", () => {
  const doc = (name: string): string =>
    [
      "/*",
      `Package ${name} drives an analysis over the`,
      "package being analyzed, and reports what it finds.",
      "*/",
      `package ${name}`,
      "",
    ].join("\n");
  const engine = (name: string): string =>
    [
      `package ${name}`,
      "",
      "type Engine struct{}",
      "",
      "func New() *Engine { return &Engine{} }",
      "",
      "func (e *Engine) Run() {}",
      "",
    ].join("\n");
  const corpus = {
    "go.mod": "module example.com/proj\n\ngo 1.22\n",
    "app/app.go": [
      "package app",
      "",
      "import (",
      '\t"example.com/proj/lib5"',
      '\t"example.com/proj/zeta"',
      ")",
      "",
      "func c5() {",
      "\te := eps.New()",
      "\te.Run()",
      "}",
      "",
      "func z1() {",
      "\te := zeta.New()",
      "\te.Run()",
      "}",
      "",
    ].join("\n"),
    "lib5/api.go": engine("eps"),
    "lib5/doc.go": doc("eps"),
    "zeta/doc.go": doc("zeta"),
    "zeta/zeta.go": engine("zeta"),
  };

  it("binds the qualifier the package clause declares past the doc comment (dir `lib5`, package `eps`)", () => {
    const sites = resolveGoFiles(corpus);
    expect(sites.get("app/app.go:9 eps.New")).toBe("New @ lib5/api.go");
    expect(sites.get("app/app.go:10 e.Run")).toBe("Engine#Run @ lib5/api.go");
  });

  it("control: a package named after its directory keeps binding (dir `zeta`, package `zeta`)", () => {
    const sites = resolveGoFiles(corpus);
    expect(sites.get("app/app.go:14 zeta.New")).toBe("New @ zeta/zeta.go");
    expect(sites.get("app/app.go:15 e.Run")).toBe("Engine#Run @ zeta/zeta.go");
  });
});

/**
 * A repository with NO go.mod (g2e): an import path is read as a repository
 * directory, which a GOPATH-era project's host-prefixed self-import never
 * names. Precision over recall — cross-package typing needs a module root, so
 * both the standard-library result and the self-import type nothing.
 */
describe("a repository without a go.mod fails closed across packages (g2e)", () => {
  const corpus = {
    "api/client.go": [
      "package api",
      "",
      "type Client struct{}",
      "",
      "func NewClient() *Client { return &Client{} }",
      "",
      "func (c *Client) Do() error { return nil }",
      "",
    ].join("\n"),
    "app/app.go": [
      "package app",
      "",
      "import (",
      '\t"net/http"',
      "",
      '\t"example.com/gp/api"',
      ")",
      "",
      "func mk() *http.Client { return nil }",
      "",
      "func useMk() {",
      "\tc := mk()",
      "\tc.Do(nil)",
      "}",
      "",
      "func mkAPI() *api.Client { return nil }",
      "",
      "func useAPI() {",
      "\tc := mkAPI()",
      "\tc.Do()",
      "\td := api.NewClient()",
      "\td.Do()",
      "}",
      "",
    ].join("\n"),
  };

  it("NEGATIVE: a standard-library result never binds the project's namesake", () => {
    expect(resolveGoFiles(corpus).get("app/app.go:13 c.Do")).toBeNull();
  });

  it("NEGATIVE: a host-prefixed self-import names no project package without a module root", () => {
    const sites = resolveGoFiles(corpus);
    expect(sites.get("app/app.go:20 c.Do")).toBeNull();
    expect(sites.get("app/app.go:21 api.NewClient")).toBeNull();
    expect(sites.get("app/app.go:22 d.Do")).toBeNull();
  });
});

describe("a callee qualifier that names neither an import nor a local fails closed", () => {
  const corpus = {
    "go.mod": "module example.com/svc\n\ngo 1.22\n",
    "server/server.go": [
      "package server",
      "",
      "type Server struct{}",
      "",
      "func New() *Server { return &Server{} }",
      "",
      "func (s *Server) Start() {}",
      "",
      "type Builder struct{}",
      "",
      "func NewBuilder() *Builder { return &Builder{} }",
      "",
      "func (b *Builder) Build() *Server { return &Server{} }",
      "",
    ].join("\n"),
    "server/use.go": [
      "package server",
      "",
      'import "github.com/ext/registry"',
      "",
      "var pool = registry.Default()",
      "",
      "func fromPool() {",
      "\tc := pool.New()",
      "\tc.Start()",
      "}",
      "",
      "func fromLocal() {",
      "\tb := NewBuilder()",
      "\ts := b.Build()",
      "\ts.Start()",
      "}",
      "",
    ].join("\n"),
  };

  it("NEGATIVE: `pool.New()` on a value the resolver cannot see is not the package function `New`", () => {
    expect(resolveGoFiles(corpus).get("server/use.go:9 c.Start")).toBeNull();
  });

  it("a qualifier that IS a local in scope still reads the method's declared return type", () => {
    expect(resolveGoFiles(corpus).get("server/use.go:15 s.Start")).toBe("Server#Start @ server/server.go");
  });
});

describe("a local in scope shadows the import of its name as a callee qualifier", () => {
  const corpus = {
    "go.mod": "module example.com/app\n\ngo 1.22\n",
    "render/render.go": [
      "package render",
      "",
      "type Writer struct{}",
      "",
      "func New() *Writer { return &Writer{} }",
      "",
      "func (w *Writer) Flush() {}",
      "",
      "type Other struct{}",
      "",
      "func (o *Other) Flush() {}",
      "",
      "type Renderer struct{}",
      "",
      "func (r *Renderer) Make() *Other { return &Other{} }",
      "",
    ].join("\n"),
    "app/app.go": [
      "package app",
      "",
      'import "example.com/app/render"',
      "",
      "func use(render *render.Renderer) {",
      "\tw := render.Make()",
      "\tw.Flush()",
      "}",
      "",
    ].join("\n"),
  };

  it("`render.Make()` on a parameter named `render` is a method call, typed by the method's return", () => {
    expect(resolveGoFiles(corpus).get("app/app.go:7 w.Flush")).toBe("Other#Flush @ render/render.go");
  });
});
