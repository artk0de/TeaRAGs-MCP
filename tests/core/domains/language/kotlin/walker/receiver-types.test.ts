import KotlinLang from "@tree-sitter-grammars/tree-sitter-kotlin";
import Parser from "tree-sitter";
import { describe, expect, it } from "vitest";

import { materializeTree } from "../../../../../../src/core/adapters/tree-sitter/materialize.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { KotlinLanguage } from "../../../../../../src/core/domains/language/kotlin/index.js";

function walk(src: string) {
  const language = new KotlinLanguage();
  const parser = new Parser();
  parser.setLanguage(KotlinLang);
  const rootNode = materializeTree(parser.parse(src).rootNode, src);
  const tree = { rootNode };
  const chunks = collectSymbols(tree, (node) => language.walker.nameOf(node), ".", true, new DefaultSymbolIdComposer());
  return language.walker.walk({ tree, code: src, relPath: "App.kt", language: "kotlin", chunks });
}

describe("Kotlin walker — receiver types", () => {
  it("qualifies nested owners and does not infer types from literals or receiver factories", () => {
    const extraction = walk(
      [
        "class Outer {",
        "  class Inner {",
        "    val qualified: pkg.Repo? = null",
        "    val generic: Box<Repo> = Box()",
        "    val unknownElements: List<*> = listOf()",
        "    val literal = 42",
        "    val receiverFactory = Repo.create()",
        "    fun run() {",
        "      val shared: Repo = Repo()",
        "      if (true) { val shared: Other = Other() }",
        "    }",
        "  }",
        "}",
      ].join("\n"),
    );
    expect(extraction.classFieldTypes?.["Outer.Inner"]).toEqual({
      qualified: "Repo",
      generic: "Box",
      unknownElements: "List",
    });
    const run = extraction.chunks.find((chunk) => chunk.symbolId === "Outer.Inner#run");
    expect(run?.localBindings?.shared).toEqual([
      { line: 9, type: "Repo" },
      { line: 10, type: "Other" },
    ]);
    expect(extraction.identifierDeclarations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "qualified", typeName: "pkg.Repo" }),
        expect.objectContaining({ name: "generic", typeName: "Box" }),
        expect.objectContaining({ name: "unknownElements", typeName: "List" }),
      ]),
    );
  });

  it("records constructor parameters, collection elements and the return type after an extension receiver", () => {
    const extraction = walk(
      [
        "class Repo {}",
        "class App(val provided: Repo, count: Int) {",
        "  val items: List<Repo> = listOf()",
        "  fun String.convert(input: Repo?): List<Repo> {",
        "    val result = Repo()",
        "    return listOf(result)",
        "  }",
        "}",
      ].join("\n"),
    );
    expect(extraction.identifierDeclarations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "provided", kind: "field", typeName: "Repo" }),
        expect.objectContaining({ name: "count", kind: "param", typeName: "Int" }),
        expect.objectContaining({ name: "items", kind: "field", typeName: "Repo", typeMultiplicity: "many" }),
        expect.objectContaining({ name: "input", kind: "param", typeName: "Repo" }),
        expect.objectContaining({ name: "result", kind: "local", typeName: "Repo", typeSource: "constructor" }),
        expect.objectContaining({ name: "convert", kind: "return", typeName: "Repo", typeMultiplicity: "many" }),
      ]),
    );
  });

  it("keeps constructor and declared property types on their owning class", () => {
    const extraction = walk(
      [
        "class Repo {}",
        "class App(val supplied: Repo, unused: String) {",
        "  val inferred = Repo()",
        "  var optional: Repo? = null",
        "  fun run() {",
        "    val local = Repo()",
        "    val annotated: Repo = local",
        "    val unknown = factory()",
        "  }",
        "}",
      ].join("\n"),
    );
    expect(extraction.classFieldTypes?.App).toEqual({ supplied: "Repo", inferred: "Repo", optional: "Repo" });
    const run = extraction.chunks.find((chunk) => chunk.symbolId === "App#run");
    expect(run?.localBindings?.local).toEqual([{ line: 6, type: "Repo" }]);
    expect(run?.localBindings?.annotated).toEqual([{ line: 7, type: "Repo" }]);
    expect(run?.localBindings?.unknown).toBeUndefined();
    expect(extraction.classFieldTypes?.App).not.toHaveProperty("unused");
  });

  it("makes file properties visible in each function while keeping local bindings in their scope", () => {
    const extraction = walk(
      [
        "class Repo {}",
        "val shared = Repo()",
        "fun first() {",
        "  val local: Repo? = Repo()",
        "}",
        "fun second() {}",
      ].join("\n"),
    );
    const first = extraction.chunks.find((chunk) => chunk.symbolId === "first");
    const second = extraction.chunks.find((chunk) => chunk.symbolId === "second");
    expect(first?.localBindings?.shared).toEqual([{ line: 1, type: "Repo" }]);
    expect(second?.localBindings?.shared).toEqual([{ line: 1, type: "Repo" }]);
    expect(first?.localBindings?.local).toEqual([{ line: 4, type: "Repo" }]);
    expect(second?.localBindings?.local).toBeUndefined();
  });

  it("binds a parameter on the method and a constructor property on the class", () => {
    const src = [
      "class Repo {",
      "  fun save() {}",
      "}",
      "class App(val repo: Repo) {",
      "  fun run(other: Repo) {",
      "    repo.save()",
      "    other.save()",
      "  }",
      "}",
      "",
    ].join("\n");
    const extraction = walk(src);
    const run = extraction.chunks.find((chunk) => chunk.symbolId === "App#run");
    expect(run?.localBindings?.other).toEqual([{ line: 5, type: "Repo" }]);
    expect(extraction.classFieldTypes?.App).toEqual({ repo: "Repo" });
  });
});
