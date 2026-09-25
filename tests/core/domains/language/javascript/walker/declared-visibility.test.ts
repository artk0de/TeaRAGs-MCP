/**
 * JavaScript declared visibility (bd tea-rags-mcp-jwjyr.1) — JavaScript has one
 * access modifier, the ECMAScript `#name` private name. A class method spelled
 * `#name` → private, every other class method → public, and a declaration
 * outside a class body records nothing.
 */
import JsLang from "tree-sitter-javascript";
import { describe, expect, it } from "vitest";

import { declaredVisibilityOf } from "../../__helpers__/declared-visibility.js";
import { JavaScriptLanguage } from "../../../../../../src/core/domains/language/javascript/index.js";

const visibilityOf = (src: string) => declaredVisibilityOf(new JavaScriptLanguage(), JsLang, src, "a.js", "javascript");

describe("JavaScript walker — declared visibility", () => {
  it("maps #name to private and every other class method to public", () => {
    const src = ["class A {", "  #hidden() {}", "  shown() {}", "  static make() {}", "}", ""].join("\n");
    expect(visibilityOf(src)).toEqual({ "A##hidden": "private", "A#shown": "public", "A.make": "public" });
  });

  it("records nothing for a declaration outside a class body", () => {
    const src = ["function top() {}", "const o = { m() {} };", ""].join("\n");
    expect(visibilityOf(src)).toEqual({});
  });
});
