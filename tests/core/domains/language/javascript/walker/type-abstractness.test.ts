/**
 * JavaScript type-abstractness census (bd tea-rags-mcp-r8hme.8). JavaScript has
 * no declaration of behaviour without implementation, so every class
 * declaration is concrete and nothing is abstract.
 */
import JsLang from "tree-sitter-javascript";
import { describe, expect, it } from "vitest";

import { typeAbstractnessOf } from "../../__helpers__/type-abstractness.js";
import { JavaScriptLanguage } from "../../../../../../src/core/domains/language/javascript/index.js";

const censusOf = (src: string) => typeAbstractnessOf(new JavaScriptLanguage(), JsLang, src, "a.js", "javascript");

describe("JavaScript walker — type-abstractness census", () => {
  it("counts class declarations as concrete", () => {
    expect(censusOf("export class A {}\nclass B extends A { m() {} }\nconst C = class {};\n")).toEqual({
      abstractTypeCount: 0,
      concreteTypeCount: 2,
    });
  });

  it("reports a file with no class as measured with no types", () => {
    expect(censusOf("export function f() { return 1; }\n")).toEqual({ abstractTypeCount: 0, concreteTypeCount: 0 });
  });
});
