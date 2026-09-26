/**
 * Java walker type/constant declaration facts (spec §1b, W3c): every walk
 * publishes `FileExtraction.typeDeclarations` — one fact per type declaration
 * (class and record → class, interface and `@interface` → interface, enum →
 * enum) and one per `static final` field of a type body (interface and
 * annotation fields are implicitly static final, so every one counts). A
 * nested type's id is composed the way the walker composes symbol ids
 * (`Outer.Inner`), a constant's is its owning type's id plus its name.
 * `conforms` lists the superclass, then the implemented / extended interfaces
 * in clause order, generic arguments dropped. Declarations inside a method, an
 * initializer or an anonymous class body are locals, not facts.
 */
import Parser from "tree-sitter";
import JavaLang from "tree-sitter-java";
import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { JavaLanguage } from "../../../../../../src/core/domains/language/java/index.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { materializeTree } from "../../../../../../src/core/infra/materialize.js";

/** Walk `src` through the seam production runs (materialize, `collectSymbols`, `walker.walk`). */
function extract(src: string, relPath = "src/A.java"): FileExtraction {
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
  return language.walker.walk({ tree, code: src, relPath, language: "java", chunks });
}

describe("Java walker — type declaration facts", () => {
  it("publishes classes, records, interfaces, annotation types and enums with their kinds", () => {
    const src = ["class C {}", "record R(int a) {}", "interface I {}", "@interface Ann {}", "enum E { A, B }", ""].join(
      "\n",
    );

    expect(extract(src).typeDeclarations).toEqual([
      { typeId: "C", symbolKind: "class", line: 1, reopens: false },
      { typeId: "R", symbolKind: "class", line: 2, reopens: false },
      { typeId: "I", symbolKind: "interface", line: 3, reopens: false },
      { typeId: "Ann", symbolKind: "interface", line: 4, reopens: false },
      { typeId: "E", symbolKind: "enum", line: 5, reopens: false },
    ]);
  });

  it("lists the superclass then the interfaces in clause order, generic arguments dropped", () => {
    const src = [
      "class C extends Base<T> implements I, java.io.Serializable, Comparable<C> {}",
      "interface J extends Supplier<String>, Map.Entry<K, V> {}",
      "enum E implements I { X }",
      "record R(int a) implements Comparable<R> {}",
      "",
    ].join("\n");

    expect(extract(src).typeDeclarations).toEqual([
      {
        typeId: "C",
        symbolKind: "class",
        line: 1,
        reopens: false,
        conforms: ["Base", "I", "java.io.Serializable", "Comparable"],
      },
      { typeId: "J", symbolKind: "interface", line: 2, reopens: false, conforms: ["Supplier", "Map.Entry"] },
      { typeId: "E", symbolKind: "enum", line: 3, reopens: false, conforms: ["I"] },
      { typeId: "R", symbolKind: "class", line: 4, reopens: false, conforms: ["Comparable"] },
    ]);
  });

  it("composes nested type and constant ids under their enclosing types", () => {
    const src = [
      "class Outer {",
      "  static class Inner {",
      "    static final int K = 1;",
      "    enum Mode { ON }",
      "  }",
      "  interface Port {}",
      "}",
      "",
    ].join("\n");

    expect(extract(src).typeDeclarations).toEqual([
      { typeId: "Outer", symbolKind: "class", line: 1, reopens: false },
      { typeId: "Outer.Inner", symbolKind: "class", line: 2, reopens: false },
      { typeId: "Outer.Inner.K", symbolKind: "constant", line: 3, reopens: false },
      { typeId: "Outer.Inner.Mode", symbolKind: "enum", line: 4, reopens: false },
      { typeId: "Outer.Port", symbolKind: "interface", line: 6, reopens: false },
    ]);
  });

  it("publishes static final fields of class, record and enum bodies, in either modifier order", () => {
    const src = [
      "class C {",
      "  public static final int MAX = 3;",
      "  final static long A = 1, B = 2;",
      "  static int counter = 0;",
      "  final int instance = 1;",
      "  private String name;",
      "}",
      "record R(int a) { static final int K = 1; }",
      "enum E { X, Y; static final int Q = 3; }",
      "",
    ].join("\n");

    expect(extract(src).typeDeclarations).toEqual([
      { typeId: "C", symbolKind: "class", line: 1, reopens: false },
      { typeId: "C.MAX", symbolKind: "constant", line: 2, reopens: false },
      { typeId: "C.A", symbolKind: "constant", line: 3, reopens: false },
      { typeId: "C.B", symbolKind: "constant", line: 3, reopens: false },
      { typeId: "R", symbolKind: "class", line: 8, reopens: false },
      { typeId: "R.K", symbolKind: "constant", line: 8, reopens: false },
      { typeId: "E", symbolKind: "enum", line: 9, reopens: false },
      { typeId: "E.Q", symbolKind: "constant", line: 9, reopens: false },
    ]);
  });

  it("publishes every interface and annotation field, which are implicitly static final", () => {
    const src = [
      "interface I {",
      "  int X = 1;",
      '  String Y = "a", Z = "b";',
      "  void m();",
      "}",
      "@interface Ann {",
      "  int V = 2;",
      "  String value();",
      "}",
      "",
    ].join("\n");

    expect(extract(src).typeDeclarations).toEqual([
      { typeId: "I", symbolKind: "interface", line: 1, reopens: false },
      { typeId: "I.X", symbolKind: "constant", line: 2, reopens: false },
      { typeId: "I.Y", symbolKind: "constant", line: 3, reopens: false },
      { typeId: "I.Z", symbolKind: "constant", line: 3, reopens: false },
      { typeId: "Ann", symbolKind: "interface", line: 6, reopens: false },
      { typeId: "Ann.V", symbolKind: "constant", line: 7, reopens: false },
    ]);
  });

  it("does not publish locals: method-local classes, anonymous class bodies, initializer blocks", () => {
    const src = [
      "class C {",
      "  static { class InStatic {} }",
      "  void run() {",
      "    final int local = 1;",
      "    class Local { static final int L = 1; }",
      "    Runnable r = new Runnable() {",
      "      static final int ANON = 1;",
      "      public void run() {}",
      "    };",
      "  }",
      "  enum E { A { static final int BODY = 1; } }",
      "}",
      "",
    ].join("\n");

    expect(extract(src).typeDeclarations).toEqual([
      { typeId: "C", symbolKind: "class", line: 1, reopens: false },
      { typeId: "C.E", symbolKind: "enum", line: 11, reopens: false },
    ]);
  });

  it("composes a type nested in a record or annotation type the way its symbol ids compose", () => {
    const src = [
      "record R(int a) {",
      "  static final int K = 1;",
      "  static class Inner { void go() {} }",
      "}",
      "",
    ].join("\n");
    const extraction = extract(src);

    expect(extraction.chunks.map((c) => c.symbolId)).toContain("Inner#go");
    expect(extraction.typeDeclarations).toEqual([
      { typeId: "R", symbolKind: "class", line: 1, reopens: false },
      { typeId: "R.K", symbolKind: "constant", line: 2, reopens: false },
      { typeId: "Inner", symbolKind: "class", line: 3, reopens: false },
    ]);
  });

  it("publishes nothing for a file with no type", () => {
    expect(extract("package com.acme;\n").typeDeclarations).toBeUndefined();
  });
});

describe("Java walker — type declaration facts leave the rest of the extraction unchanged", () => {
  // Pinned from the walker BEFORE the typeDeclarations channel existed: the
  // chunk set, symbol kinds, calls, bindings, imports and facets must be
  // byte-identical.
  const src = [
    "package com.acme;",
    "",
    "import java.util.List;",
    "",
    "public class Service extends Base implements Runnable {",
    "  public static final int LIMIT = 3;",
    "  private Repo repo;",
    "",
    "  public Service(Repo repo) { this.repo = repo; }",
    "",
    "  public void run() {",
    "    List<String> names = repo.names();",
    "    helper(names.size());",
    "  }",
    "",
    "  static int helper(int n) { return Math.max(n, LIMIT); }",
    "",
    '  interface Port { String NAME = "p"; void send(); }',
    "}",
    "",
  ].join("\n");

  it("keeps chunks, calls, imports and facets byte-identical", () => {
    const { typeDeclarations, ...rest } = extract(src, "src/Service.java");

    expect(typeDeclarations).toEqual([
      { typeId: "Service", symbolKind: "class", line: 5, reopens: false, conforms: ["Base", "Runnable"] },
      { typeId: "Service.LIMIT", symbolKind: "constant", line: 6, reopens: false },
      { typeId: "Service.Port", symbolKind: "interface", line: 18, reopens: false },
      { typeId: "Service.Port.NAME", symbolKind: "constant", line: 18, reopens: false },
    ]);
    expect(rest).toEqual({
      relPath: "src/Service.java",
      language: "java",
      imports: [{ importText: "java.util.List", startLine: 3 }],
      chunks: [
        {
          symbolId: "Service",
          scope: [],
          startLine: 5,
          endLine: 19,
          calls: [],
          symbolKind: "class",
          visibility: "public",
        },
        {
          symbolId: "Service#Service",
          scope: ["Service"],
          startLine: 9,
          endLine: 9,
          calls: [],
          symbolKind: "method",
          localBindings: { repo: [{ line: 9, type: "Repo" }] },
          visibility: "public",
        },
        {
          symbolId: "Service#run",
          scope: ["Service"],
          startLine: 11,
          endLine: 14,
          calls: [
            { callText: "repo.names()", receiver: "repo", member: "names", startLine: 12 },
            { callText: "helper(names.size())", receiver: null, member: "helper", startLine: 13 },
            { callText: "names.size()", receiver: "names", member: "size", startLine: 13 },
          ],
          symbolKind: "method",
          localBindings: { names: [{ line: 12, type: "List" }] },
          visibility: "public",
        },
        {
          symbolId: "Service.helper",
          scope: ["Service"],
          startLine: 16,
          endLine: 16,
          calls: [{ callText: "Math.max(n, LIMIT)", receiver: "Math", member: "max", startLine: 16 }],
          symbolKind: "method",
        },
        {
          symbolId: "Service.Port",
          scope: ["Service"],
          startLine: 18,
          endLine: 18,
          calls: [],
          symbolKind: "interface",
        },
        {
          symbolId: "Service.Port#send",
          scope: ["Service", "Port"],
          startLine: 18,
          endLine: 18,
          calls: [],
          symbolKind: "method",
          visibility: "public",
        },
      ],
      fileScope: [],
      classFieldTypes: { Service: { repo: "Repo" } },
      typeAbstractness: { abstractTypeCount: 1, concreteTypeCount: 1 },
      identifierDeclarations: [
        { name: "LIMIT", kind: "field", line: 6, ownerSymbolId: "Service", typeName: "int", typeSource: "annotation" },
        { name: "repo", kind: "field", line: 7, ownerSymbolId: "Service", typeName: "Repo", typeSource: "annotation" },
        {
          name: "repo",
          kind: "param",
          line: 9,
          ownerSymbolId: "Service#Service",
          typeName: "Repo",
          typeSource: "annotation",
        },
        {
          name: "names",
          kind: "local",
          line: 12,
          ownerSymbolId: "Service#run",
          typeName: "String",
          typeSource: "annotation",
          typeMultiplicity: "many",
          boundCallee: { member: "names", receiver: "repo" },
        },
        {
          name: "helper",
          kind: "return",
          line: 16,
          ownerSymbolId: "Service.helper",
          typeName: "int",
          typeSource: "annotation",
        },
        {
          name: "n",
          kind: "param",
          line: 16,
          ownerSymbolId: "Service.helper",
          typeName: "int",
          typeSource: "annotation",
        },
      ],
    });
  });
});
