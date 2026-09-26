/**
 * Java walker symbol kinds (tea-rags-mcp-vi0wx): every chunk the walker emits
 * carries the declaration kind of the node that named it. A class is a class,
 * an interface an interface, an enum an enum; a method — instance, static,
 * abstract or interface — and a constructor are methods. Records map to class
 * and annotation types to interface, but `javaNameOf` names neither, so they
 * carry no chunk to tag; a `static final` field has no chunk either.
 */
import Parser from "tree-sitter";
import JavaLang from "tree-sitter-java";
import { describe, expect, it } from "vitest";

import { JavaLanguage } from "../../../../../../src/core/domains/language/java/index.js";
import { symbolKindOf } from "../../../../../../src/core/domains/language/java/walker/symbol-kind.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { materializeTree } from "../../../../../../src/core/infra/materialize.js";

/** `symbolId → symbolKind` through the seam production runs (materialize, `collectSymbols`, `walker.walk`). */
function symbolKindsOf(src: string): Record<string, string | undefined> {
  const language = new JavaLanguage();
  const parser = new Parser();
  parser.setLanguage(JavaLang);
  const rootNode = materializeTree(parser.parse(src).rootNode, src);
  const tree = { rootNode };
  const chunks = collectSymbols(
    tree,
    (node) => language.walker.nameOf(node),
    language.kernel.scopeSeparator ?? ".",
    language.kernel.disambiguateOverloads ?? false,
    new DefaultSymbolIdComposer(),
  );
  const extraction = language.walker.walk({ tree, code: src, relPath: "A.java", language: "java", chunks });
  return Object.fromEntries(extraction.chunks.map((c) => [c.symbolId, c.symbolKind]));
}

describe("Java walker — symbol kind per chunk", () => {
  it("tags classes, interfaces, enums, methods and constructors", () => {
    const src = [
      "public class A {",
      "  public static final int MAX = 3;",
      "  private int n;",
      "  public A() {}",
      "  void run() {}",
      "  static A of() { return new A(); }",
      "}",
      "interface I {",
      "  void m();",
      "  default void d() {}",
      "}",
      "enum E {",
      "  X, Y;",
      "  int code() { return 0; }",
      "}",
      "",
    ].join("\n");

    expect(symbolKindsOf(src)).toEqual({
      A: "class",
      "A#A": "method",
      "A#run": "method",
      "A.of": "method",
      I: "interface",
      "I#m": "method",
      "I#d": "method",
      E: "enum",
      "E#code": "method",
    });
  });

  it("tags nested types and an abstract method by their own node", () => {
    const src = [
      "abstract class Outer {",
      "  abstract void go();",
      "  static class Inner {}",
      "  interface Port { void send(); }",
      "  enum Mode { ON }",
      "}",
      "",
    ].join("\n");

    expect(symbolKindsOf(src)).toEqual({
      Outer: "class",
      "Outer#go": "method",
      "Outer.Inner": "class",
      "Outer.Port": "interface",
      "Outer.Port#send": "method",
      "Outer.Mode": "enum",
    });
  });

  it("tags two declarations sharing one line by their own names", () => {
    const src = ["class P { void a() {} void b() {} }", ""].join("\n");

    expect(symbolKindsOf(src)).toEqual({ P: "class", "P#a": "method", "P#b": "method" });
  });
});

describe("symbolKindOf (java)", () => {
  it.each([
    ["class_declaration", "class"],
    ["record_declaration", "class"],
    ["interface_declaration", "interface"],
    ["annotation_type_declaration", "interface"],
    ["enum_declaration", "enum"],
    ["method_declaration", "method"],
    ["constructor_declaration", "method"],
  ])("maps %s to %s", (nodeType, kind) => {
    expect(symbolKindOf(nodeType)).toBe(kind);
  });

  it("answers undefined for a node that declares no symbol", () => {
    expect(symbolKindOf("field_declaration")).toBeUndefined();
    expect(symbolKindOf("method_invocation")).toBeUndefined();
  });
});
