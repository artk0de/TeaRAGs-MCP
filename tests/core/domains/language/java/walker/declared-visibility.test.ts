/**
 * Java declared visibility (bd tea-rags-mcp-jwjyr.1). `private` / `protected` /
 * `public` map one-to-one. Package-private (no modifier) has no slot in the
 * three-value union and records NOTHING — calling it `public` would overstate
 * reach, calling it `private` would drop legal same-package callers. An
 * interface member with no modifier is implicitly public.
 */
import JavaLang from "tree-sitter-java";
import { describe, expect, it } from "vitest";

import { declaredVisibilityOf } from "../../__helpers__/declared-visibility.js";
import { JavaLanguage } from "../../../../../../src/core/domains/language/java/index.js";

const visibilityOf = (src: string) => declaredVisibilityOf(new JavaLanguage(), JavaLang, src, "A.java", "java");

describe("Java walker — declared visibility", () => {
  it("maps the three access keywords and leaves package-private unrecorded", () => {
    const src = [
      "public class A {",
      "  private void a() {}",
      "  protected void b() {}",
      "  public static void c() {}",
      "  void d() {}",
      "  private A() {}",
      "}",
      "",
    ].join("\n");
    expect(visibilityOf(src)).toEqual({
      A: "public",
      "A#a": "private",
      "A#b": "protected",
      "A.c": "public",
      "A#A": "private",
    });
  });

  it("treats a modifier-less interface member as public", () => {
    const src = ["interface I {", "  void m();", "  private void helper() {}", "}", ""].join("\n");
    expect(visibilityOf(src)).toEqual({ "I#m": "public", "I#helper": "private" });
  });
});
