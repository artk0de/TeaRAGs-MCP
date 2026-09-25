/**
 * Go declared visibility (bd tea-rags-mcp-jwjyr.1). Go's only access rule is the
 * identifier's first letter: exported (upper case) → public, unexported →
 * private. "private" here means PACKAGE-private — reachable from every file of
 * the declaring package, not only the declaring type — which is what a consumer
 * of the column must assume.
 */
import GoLang from "tree-sitter-go";
import { describe, expect, it } from "vitest";

import { declaredVisibilityOf } from "../../__helpers__/declared-visibility.js";
import { GoLanguage } from "../../../../../../src/core/domains/language/go/index.js";

const visibilityOf = (src: string) => declaredVisibilityOf(new GoLanguage(), GoLang, src, "pkg/a.go", "go");

describe("Go walker — declared visibility", () => {
  it("maps exported names to public and unexported names to private", () => {
    const src = [
      "package pkg",
      "type Engine struct{}",
      "type node struct{}",
      "func New() *Engine { return nil }",
      "func helper() {}",
      "func (e *Engine) Run() {}",
      "func (e *Engine) reset() {}",
      "",
    ].join("\n");
    expect(visibilityOf(src)).toEqual({
      Engine: "public",
      node: "private",
      New: "public",
      helper: "private",
      "Engine#Run": "public",
      "Engine#reset": "private",
    });
  });
});
