import { describe, expect, it } from "vitest";

import { resolveGoFiles } from "../__helpers__/go-corpus.js";

/**
 * bd tea-rags-mcp-e6xx, G2-3 — an UNQUALIFIED result type (`func mk() *Client`)
 * names a type of the package that declares the function, or of a package that
 * file dot-imports, and the walker cannot tell the two apart: `. "net/http"`
 * puts `http.Client` in scope as a bare `Client`. It was accepted whenever ANY
 * project package declared a `Client`, so the re-validator's dot-import corpus
 * (g2a `dot/dot.go`) typed `c := mk(); c.Do(nil)` as the project's `api.Client`.
 *
 * The bare type now counts when the CALLEE's package declares it — a bare
 * callee's package is the caller's, or the dot-imported project package that
 * declares the function — and, in a caller file with a dot import, only then:
 * a dot-imported type is silence, never a project namesake.
 */

const API = [
  "package api",
  "",
  "type Client struct{ Name string }",
  "",
  "func NewClient() *Client { return &Client{} }",
  "",
  "func (c *Client) Do() error { return nil }",
  "",
  "func (c *Client) Get(url string) error { return nil }",
  "",
].join("\n");

const DOT_STDLIB = [
  "package dot",
  "",
  "import (",
  '\t. "net/http"',
  ")",
  "",
  "func mk() *Client { return nil }",
  "",
  "func useDot() {",
  "\tc := mk()",
  "\tc.Do(nil)",
  '\tmk().Get("u")',
  "}",
  "",
].join("\n");

const DOT_PROJECT = [
  "package shop",
  "",
  'import . "example.com/proj/api"',
  "",
  "func mkClient() *Client { return nil }",
  "",
  "func useShop() {",
  "\tc := NewClient()",
  "\tc.Do()",
  "\td := mkClient()",
  "\td.Do()",
  "}",
  "",
].join("\n");

const corpus = {
  "go.mod": "module example.com/proj\n\ngo 1.22\n",
  "api/client.go": API,
  "dot/dot.go": DOT_STDLIB,
  "shop/shop.go": DOT_PROJECT,
};

describe("an unqualified result type under a dot import (g2a `dot/dot.go`)", () => {
  it("NEGATIVE: a dot-imported standard-library `Client` is not the project's `api.Client`", () => {
    const sites = resolveGoFiles(corpus);
    expect(sites.get("dot/dot.go:11 c.Do")).toBeNull();
    expect(sites.get("dot/dot.go:12 mk().Get")).toBeNull();
  });

  it("a constructor declared in a dot-imported PROJECT package types its local through that package", () => {
    expect(resolveGoFiles(corpus).get("shop/shop.go:9 c.Do")).toBe("Client#Do @ api/client.go");
  });

  it("NEGATIVE: a result type the callee's own package does not declare types nothing under a dot import", () => {
    // `mkClient` returns the dot-imported `api.Client`, which is correct Go —
    // but the recorded `Client` is indistinguishable from a namesake, and the
    // shop package declares none. Precision over recall.
    expect(resolveGoFiles(corpus).get("shop/shop.go:11 d.Do")).toBeNull();
  });
});
