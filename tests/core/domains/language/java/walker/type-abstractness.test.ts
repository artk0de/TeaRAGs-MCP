/**
 * Java type-abstractness census (bd tea-rags-mcp-r8hme.8). An interface or an
 * `abstract` class is abstract. A type that declares behaviour of its own is
 * concrete; a type whose members are only constructors, fields and static
 * initializers declares no behaviour — an Exception subclass, a record, an
 * enum of constants — and counts as neither (bd tea-rags-mcp-44cpv, decision
 * c-1=a). An annotation type declares no behaviour and counts as neither too.
 */
import JavaLang from "tree-sitter-java";
import { describe, expect, it } from "vitest";

import { typeAbstractnessOf } from "../../__helpers__/type-abstractness.js";
import { JavaLanguage } from "../../../../../../src/core/domains/language/java/index.js";

const censusOf = (src: string) => typeAbstractnessOf(new JavaLanguage(), JavaLang, src, "A.java", "java");

describe("Java walker — type-abstractness census", () => {
  it("reads interfaces and abstract classes as abstract, behaviour-declaring types as concrete", () => {
    const src = [
      "public interface Store { int get(); }",
      "public abstract class Base { abstract void run(); }",
      "final class Impl extends Base { void run() {} static class Inner {} }",
      "enum Kind { A }",
      "record Row(int id) {}",
      "@interface Marker {}",
      "",
    ].join("\n");

    // `Inner` (empty), `Kind` (constants only) and `Row` (components only) are
    // behaviour-free (44cpv c-1); only `Impl`, which declares `run`, counts.
    expect(censusOf(src)).toEqual({ abstractTypeCount: 2, concreteTypeCount: 1 });
  });

  describe("behaviour-free types (bd tea-rags-mcp-44cpv, decision c-1=a)", () => {
    it("counts an Exception subclass of constructor and fields as neither bucket", () => {
      const src = [
        "public final class PipelineException extends Exception {",
        '  public static final String KIND = "pipeline";',
        "  private final String code;",
        "  public PipelineException(String code) { super(code); this.code = code; }",
        "  static { register(PipelineException.class); }",
        "}",
        "",
      ].join("\n");

      expect(censusOf(src)).toEqual({ abstractTypeCount: 0, concreteTypeCount: 0 });
    });

    it("counts an empty class as neither", () => {
      expect(censusOf("class Empty {}\n")).toEqual({ abstractTypeCount: 0, concreteTypeCount: 0 });
    });

    it("keeps counting a type as concrete for every form of behaviour a member can take", () => {
      const src = [
        "class WithMethod { void run() {} }",
        "class WithStaticMethod { static Impl make() { return null; } }",
        "class WithLambdaField { Runnable handler = () -> {}; }",
        "record Doubler(int id) { public int doubled() { return id * 2; } }",
        "enum Coded { A, B; void m() {} }",
        "",
      ].join("\n");

      expect(censusOf(src)).toEqual({ abstractTypeCount: 0, concreteTypeCount: 5 });
    });
  });
});
