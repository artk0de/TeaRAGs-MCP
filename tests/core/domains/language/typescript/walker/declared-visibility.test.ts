/**
 * TypeScript declared visibility (bd tea-rags-mcp-jwjyr.1) — the access level a
 * class member DECLARES, on `ChunkExtraction.visibility`: `private` and an
 * ECMAScript `#name` → private, `protected` → protected, anything else in a class
 * body → public. A declaration outside a class body carries no access modifier,
 * so it records nothing.
 */
import TsLang from "tree-sitter-typescript";
import { describe, expect, it } from "vitest";

import { declaredVisibilityOf } from "../../__helpers__/declared-visibility.js";
import { TypeScriptLanguage } from "../../../../../../src/core/domains/language/typescript/index.js";

const grammar = (TsLang as unknown as { typescript: unknown }).typescript;
const visibilityOf = (src: string) =>
  declaredVisibilityOf(new TypeScriptLanguage(), grammar, src, "a.ts", "typescript");

describe("TypeScript walker — declared visibility", () => {
  it("maps private / protected / public / none / #name on class methods", () => {
    const src = [
      "class A {",
      "  private a() {}",
      "  protected b() {}",
      "  public c() {}",
      "  d() {}",
      "  #e() {}",
      "  private static f() {}",
      "}",
      "",
    ].join("\n");
    expect(visibilityOf(src)).toEqual({
      "A#a": "private",
      "A#b": "protected",
      "A#c": "public",
      "A#d": "public",
      "A##e": "private",
      "A.f": "private",
    });
  });

  it("reads the modifier of a function-valued class property", () => {
    const src = ["class A {", "  private handler = () => 1;", "  protected other = function () {};", "}", ""].join(
      "\n",
    );
    expect(visibilityOf(src)).toEqual({ "A#handler": "private", "A#other": "protected" });
  });

  it("records nothing for a declaration outside a class body", () => {
    const src = ["function top() {}", "const o = { m() {} };", "const f = () => 1;", ""].join("\n");
    expect(visibilityOf(src)).toEqual({});
  });
});
