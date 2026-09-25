/**
 * Java type-abstractness census (bd tea-rags-mcp-r8hme.8). An interface or an
 * `abstract` class is abstract; any other class, an enum and a record are
 * concrete; an annotation type counts as neither.
 */
import JavaLang from "tree-sitter-java";
import { describe, expect, it } from "vitest";

import { typeAbstractnessOf } from "../../__helpers__/type-abstractness.js";
import { JavaLanguage } from "../../../../../../src/core/domains/language/java/index.js";

const censusOf = (src: string) => typeAbstractnessOf(new JavaLanguage(), JavaLang, src, "A.java", "java");

describe("Java walker — type-abstractness census", () => {
  it("reads interfaces and abstract classes as abstract, the rest as concrete", () => {
    const src = [
      "public interface Store { int get(); }",
      "public abstract class Base { abstract void run(); }",
      "final class Impl extends Base { void run() {} static class Inner {} }",
      "enum Kind { A }",
      "record Row(int id) {}",
      "@interface Marker {}",
      "",
    ].join("\n");

    expect(censusOf(src)).toEqual({ abstractTypeCount: 2, concreteTypeCount: 4 });
  });
});
