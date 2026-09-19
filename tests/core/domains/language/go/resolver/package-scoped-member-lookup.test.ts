import { describe, expect, it } from "vitest";

import { resolveGoFiles } from "../__helpers__/go-corpus.js";

/**
 * bd tea-rags-mcp-e6xx, G2-4 — once a declared function's result type has been
 * placed in its package (`*api.Widget` → package `api`; `api.NewClient()`'s
 * bare `Client` → package `api`), the member lookup must stay in that package.
 * It did not: the gate validated the package and discarded it, and
 * `resolveByLocalType` composed `Widget#Paint` and took whichever package
 * declared one. A type ALIAS of an external type (`type Client = http.Client`)
 * is the sharpest case — Go forbids declaring methods on it, so its package
 * holds no member and the call is external, yet an unrelated project
 * `web.Client#Do` answered it (g2i). Each corpus is the G2 re-validator's.
 */

const G2I = {
  "go.mod": "module example.com/ali\n\ngo 1.22\n",
  "api/api.go": [
    "package api",
    "",
    'import "net/http"',
    "",
    "type Client = http.Client",
    "",
    "func NewClient() *Client { return &http.Client{} }",
    "",
  ].join("\n"),
  "web/client.go": [
    "package web",
    "",
    "type Client struct{}",
    "",
    "func (c *Client) Do(x any) error { return nil }",
    "",
  ].join("\n"),
  "app/app.go": [
    "package app",
    "",
    "import (",
    '\t"net/http"',
    "",
    '\t"example.com/ali/api"',
    ")",
    "",
    "func mk() *api.Client { return nil }",
    "",
    "func useMk(req *http.Request) {",
    "\tc := mk()",
    "\tc.Do(req)",
    "}",
    "",
    "func useNew(req *http.Request) {",
    "\tc := api.NewClient()",
    "\tc.Do(req)",
    "}",
    "",
  ].join("\n"),
};

describe("a project alias of an external type has no project member (g2i)", () => {
  it("NEGATIVE: `*api.Client` (= `http.Client`) is not the unrelated `web.Client`", () => {
    expect(resolveGoFiles(G2I).get("app/app.go:13 c.Do")).toBeNull();
  });

  it("NEGATIVE: nor is the `api.Client` a project constructor returns", () => {
    expect(resolveGoFiles(G2I).get("app/app.go:18 c.Do")).toBeNull();
  });
});

const G2A = {
  "go.mod": "module example.com/proj\n\ngo 1.22\n",
  "api/client.go": [
    "package api",
    "",
    'import "net/http"',
    "",
    "type Client struct{ Name string }",
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
    "",
    "type Alias = http.Client",
    "",
    "type Widget struct{}",
    "",
    "func (w *Widget) Size() int { return 0 }",
    "",
  ].join("\n"),
  "web/widget.go": ["package web", "", "type Widget struct{}", "", "func (w *Widget) Paint() {}", ""].join("\n"),
  "app/app.go": [
    "package app",
    "",
    "import (",
    '\th "net/http"',
    '\tht "net/http/httptest"',
    '\t_ "net/http/pprof"',
    "",
    '\tpa "example.com/proj/api"',
    '\t"example.com/proj/api"',
    ")",
    "",
    "func a1() *h.Client { return nil }",
    "",
    "func useA1() {",
    "\tc := a1()",
    "\tc.Do(nil)",
    "}",
    "",
    "func a2() *pa.Client { return nil }",
    "",
    "func useA2() {",
    "\tc2 := a2()",
    "\tc2.Do()",
    "}",
    "",
    "func useA3() {",
    "\ts := ht.NewServer(nil)",
    "\ts.Close()",
    "}",
    "",
    "func useA4() {",
    "\ts := api.NewServer()",
    "\ts.Close()",
    "}",
    "",
    "func al() *api.Alias { return nil }",
    "",
    "func useAl() {",
    "\tx := al()",
    "\tx.Do(nil)",
    "}",
    "",
    "func w1() *api.Widget { return nil }",
    "",
    "func useW1() {",
    "\tw := w1()",
    "\tw.Paint()",
    "\tw.Size()",
    "}",
    "",
    "func useA8() {",
    '\ta2().Get("u")',
    '\ta1().Get("u")',
    "}",
    "",
  ].join("\n"),
};

describe("a result type's members are looked up in the package that declares it (g2a)", () => {
  it("NEGATIVE: `*api.Widget` has no `Paint`; `web.Widget#Paint` does not answer for it", () => {
    expect(resolveGoFiles(G2A).get("app/app.go:47 w.Paint")).toBeNull();
  });

  it("the placed type's own member still resolves", () => {
    expect(resolveGoFiles(G2A).get("app/app.go:48 w.Size")).toBe("Widget#Size @ api/client.go");
  });

  it("NEGATIVE: an alias of `http.Client` re-exported by a project package selects no project member", () => {
    expect(resolveGoFiles(G2A).get("app/app.go:40 x.Do")).toBeNull();
  });

  it("aliased project imports and project constructors keep their edges; aliased stdlib ones stay external", () => {
    const sites = resolveGoFiles(G2A);
    expect(sites.get("app/app.go:16 c.Do")).toBeNull();
    expect(sites.get("app/app.go:23 c2.Do")).toBe("Client#Do @ api/client.go");
    expect(sites.get("app/app.go:28 s.Close")).toBeNull();
    expect(sites.get("app/app.go:33 s.Close")).toBe("Server#Close @ api/client.go");
    expect(sites.get("app/app.go:52 a2().Get")).toBe("Client#Get @ api/client.go");
    expect(sites.get("app/app.go:53 a1().Get")).toBeNull();
  });
});

describe("a placed result type tells a namesake in another package apart", () => {
  const corpus = {
    "go.mod": "module example.com/proj\n\ngo 1.22\n",
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
    "web/client.go": [
      "package web",
      "",
      "type Client struct{}",
      "",
      "func (c *Client) Do() error { return nil }",
      "",
    ].join("\n"),
    "app/app.go": [
      "package app",
      "",
      'import "example.com/proj/api"',
      "",
      "func use() {",
      "\tc := api.NewClient()",
      "\tc.Do()",
      "}",
      "",
    ].join("\n"),
  };

  it("`api.NewClient().Do` is `api.Client#Do`, not an ambiguity with `web.Client#Do`", () => {
    expect(resolveGoFiles(corpus).get("app/app.go:7 c.Do")).toBe("Client#Do @ api/client.go");
  });
});
