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
