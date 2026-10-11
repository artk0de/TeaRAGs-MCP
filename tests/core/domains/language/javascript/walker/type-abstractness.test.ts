/**
 * JavaScript type-abstractness census (bd tea-rags-mcp-r8hme.8). JavaScript
 * has no declaration of behaviour without implementation, so nothing is
 * abstract. A class that declares behaviour of its own is concrete; a class
 * whose members are only a constructor, property fields and getters/setters
 * declares no behaviour — an Error subclass, a data-only shape — and counts as
 * neither (bd tea-rags-mcp-44cpv, decision c-1=a).
 */
import JsLang from "tree-sitter-javascript";
import { describe, expect, it } from "vitest";

import { typeAbstractnessOf } from "../../__helpers__/type-abstractness.js";
import { JavaScriptLanguage } from "../../../../../../src/core/domains/language/javascript/index.js";

const censusOf = (src: string) => typeAbstractnessOf(new JavaScriptLanguage(), JsLang, src, "a.js", "javascript");

describe("JavaScript walker — type-abstractness census", () => {
  it("counts behaviour-declaring class declarations as concrete", () => {
    // `A` is empty — behaviour-free (44cpv c-1) — so only `B` counts, and a
    // class expression is a value, not a declaration.
    expect(censusOf("export class A {}\nclass B extends A { m() {} }\nconst C = class {};\n")).toEqual({
      abstractTypeCount: 0,
      concreteTypeCount: 1,
    });
  });

  it("reports a file with no class as measured with no types", () => {
    expect(censusOf("export function f() { return 1; }\n")).toEqual({ abstractTypeCount: 0, concreteTypeCount: 0 });
  });

  describe("behaviour-free classes (bd tea-rags-mcp-44cpv, decision c-1=a)", () => {
    it("counts an Error subclass of constructor, fields and accessors as neither bucket", () => {
      const src = [
        "export class HttpError extends Error {",
        "  kind = 'http';",
        "  constructor(code) {",
        "    super(code);",
        "    this.code = code;",
        "  }",
        '  get name() { return "HttpError:" + this.code; }',
        "}",
        "",
      ].join("\n");

      expect(censusOf(src)).toEqual({ abstractTypeCount: 0, concreteTypeCount: 0 });
    });

    it("counts a data-only class, an empty class and static data as neither", () => {
      const src = [
        "export class Row { constructor(id, label) { this.id = id; this.label = label; } }",
        "class Unit {}",
        "class Box { get value() { return this.v; } set value(n) { this.v = n; } }",
        "class Limits { static MAX = 3; }",
        "",
      ].join("\n");

      expect(censusOf(src)).toEqual({ abstractTypeCount: 0, concreteTypeCount: 0 });
    });

    it("keeps counting a class as concrete for every form of behaviour a member can take", () => {
      const src = [
        "class WithMethod { run() {} }",
        "class WithStaticMethod { static make() { return new WithStaticMethod(); } }",
        "class WithArrowField { handler = async (x) => x; }",
        "class WithFunctionField { fn = function () { return 1; }; }",
        "",
      ].join("\n");

      expect(censusOf(src)).toEqual({ abstractTypeCount: 0, concreteTypeCount: 4 });
    });
  });
});
