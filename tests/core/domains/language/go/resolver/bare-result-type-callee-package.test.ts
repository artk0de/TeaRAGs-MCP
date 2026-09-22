import { describe, expect, it } from "vitest";

import { resolveGoFiles } from "../__helpers__/go-corpus.js";

/**
 * bd tea-rags-mcp-e6xx, F3-2 — the rest of G2-3. An UNQUALIFIED result type of
 * a FUNCTION (`func mk() *Client`) names a type of the package that declares
 * the function, or of a package some file of that package dot-imports; the
 * record cannot say which. G2-3 placed it in the callee's package when that
 * package declares it, and otherwise fell back to the package-blind known-type
 * gate unless the CALLER's file had a dot import. The dot import that matters
 * is in the CALLEE's file, which may be a sibling of the caller's or another
 * package's, so the fallback still took `net/http`'s `Client` for the
 * project's `api.Client`.
 *
 * When the callee's package is known and does not declare the bare type, that
 * type is a builtin (no symbol) or dot-imported in the callee's file — never a
 * type of some other project package — so it types nothing. The package-blind
 * gate is left to a method's result, whose package the resolver cannot know.
 */

/** The re-validator's corpus `f3a`. */
const F3A = {
  "go.mod": "module example.com/proj\n\ngo 1.22\n",
  "api/client.go": [
    "package api",
    "",
    "type Client struct{ Name string }",
    "",
    "func (c *Client) Do() error { return nil }",
    "",
    "func (c *Client) Get(url string) error { return nil }",
    "",
  ].join("\n"),
  "app/app.go": [
    "package app",
    "",
    'import "example.com/proj/util"',
    "",
    "// X1: qualified callee from another package whose file dot-imports net/http; no dot import here.",
    "func x1() {",
    "\tc := util.Mk()",
    "\tc.Do(nil)",
    '\tutil.Mk().Get("u")',
    "}",
    "",
  ].join("\n"),
  "same/a.go": [
    "package same",
    "",
    "import (",
    '\t. "net/http"',
    ")",
    "",
    "// mk returns net/http's Client through a dot import in this file.",
    "func mk() *Client { return nil }",
    "",
  ].join("\n"),
  "same/b.go": [
    "package same",
    "",
    "// X2: bare callee of the SAME package, declared in a sibling file that dot-imports; no dot import here.",
    "func x2() {",
    "\tc := mk()",
    "\tc.Do(nil)",
    '\tmk().Get("u")',
    "}",
    "",
  ].join("\n"),
  "util/mk.go": [
    "package util",
    "",
    "import (",
    '\t. "net/http"',
    ")",
    "",
    "// Mk returns net/http's Client through a dot import in THIS file.",
    "func Mk() *Client { return nil }",
    "",
  ].join("\n"),
};

describe("a bare result type dot-imported in the CALLEE's file (f3a)", () => {
  it("NEGATIVE: a same-package callee declared beside a dot import does not type its result as the project's `Client`", () => {
    const sites = resolveGoFiles(F3A);
    expect(sites.get("same/b.go:6 c.Do")).toBeNull();
    expect(sites.get("same/b.go:7 mk().Get")).toBeNull();
  });

  it("NEGATIVE: a callee of another package whose file dot-imports types nothing either", () => {
    expect(resolveGoFiles(F3A).get("app/app.go:8 c.Do")).toBeNull();
  });

  it("control: the callees themselves still resolve", () => {
    const sites = resolveGoFiles(F3A);
    expect(sites.get("same/b.go:5 null.mk")).toBe("mk @ same/a.go");
    expect(sites.get("app/app.go:7 util.Mk")).toBe("Mk @ util/mk.go");
  });
});

/**
 * The re-validator's corpus `g2j`: two packages each declare `New`. The e6xx
 * gate placed the cross-absorbed bare record in the callee's package and so
 * typed nothing — precision only, and it lost `A#Run` with it: getting that
 * back needed the channel keyed by the declaring package, which is what bd
 * tea-rags-mcp-7h6j0 did. Each call now reads its OWN package's `New` record,
 * whoever was walked last.
 */
const G2J = {
  "go.mod": "module example.com/nn\n\ngo 1.22\n",
  "a/a.go": [
    "package a",
    "",
    "type A struct{}",
    "",
    "func New() *A { return &A{} }",
    "",
    "func (x *A) Run() {}",
    "",
    "func useLocal() {",
    "\tx := New()",
    "\tx.Run()",
    "}",
    "",
  ].join("\n"),
  "app/app.go": [
    "package app",
    "",
    "import (",
    '\t"example.com/nn/a"',
    '\t"example.com/nn/b"',
    ")",
    "",
    "func use() {",
    "\tp := a.New()",
    "\tp.Run()",
    "\tq := b.New()",
    "\tq.Run()",
    "}",
    "",
  ].join("\n"),
  "b/b.go": [
    "package b",
    "",
    "type B struct{}",
    "",
    "func New() *B { return &B{} }",
    "",
    "func (y *B) Run() {}",
    "",
    "func useLocal() {",
    "\ty := New()",
    "\ty.Run()",
    "}",
    "",
  ].join("\n"),
};

describe("a bare result type another package's namesake function recorded (g2j)", () => {
  it("each package's `New` types its own calls, never the namesake's record", () => {
    const sites = resolveGoFiles(G2J);
    expect(sites.get("a/a.go:11 x.Run")).toBe("A#Run @ a/a.go");
    expect(sites.get("app/app.go:10 p.Run")).toBe("A#Run @ a/a.go");
  });

  it("control: the package that declares the recorded type keeps its edges", () => {
    const sites = resolveGoFiles(G2J);
    expect(sites.get("app/app.go:12 q.Run")).toBe("B#Run @ b/b.go");
    expect(sites.get("b/b.go:11 y.Run")).toBe("B#Run @ b/b.go");
  });
});
