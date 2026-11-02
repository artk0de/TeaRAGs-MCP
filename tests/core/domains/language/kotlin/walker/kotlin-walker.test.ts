import KotlinLang from "@tree-sitter-grammars/tree-sitter-kotlin";
import Parser from "tree-sitter";
import { describe, expect, it } from "vitest";

import { extractFromKotlinFile } from "../../../../../../src/core/domains/language/kotlin/walker/walker.js";

function parse(src: string) {
  const parser = new Parser();
  parser.setLanguage(KotlinLang);
  return parser.parse(src);
}

const src = `package app
import foo.Bar
class User {
  fun greet(who: String): String {
    save(who)
    return Bar.make(who)
  }
}
`;

describe("extractFromKotlinFile", () => {
  it("records imports and calls", () => {
    const result = extractFromKotlinFile({
      tree: parse(src),
      code: src,
      relPath: "User.kt",
      language: "kotlin",
      chunks: [{ symbolId: "User#greet", scope: ["User"], startLine: 4, endLine: 7 }],
    });
    expect(result.imports.map((item) => item.importText)).toEqual(["foo.Bar"]);
    expect(result.chunks[0].calls.map((call) => [call.receiver, call.member])).toEqual([
      [null, "save"],
      ["Bar", "make"],
    ]);
    expect(result.chunks[0].symbolKind).toBe("method");
  });

  it("records this.paint() with receiver this and a top-level function as a function", () => {
    const code = [
      "class Widget {",
      "  fun draw() {",
      "    this.paint()",
      "  }",
      "  fun paint() {}",
      "}",
      "fun topLevel(name: String): String {",
      "  return name.trim()",
      "}",
      "",
    ].join("\n");
    const result = extractFromKotlinFile({
      tree: parse(code),
      code,
      relPath: "Widget.kt",
      language: "kotlin",
      chunks: [
        { symbolId: "Widget#draw", scope: ["Widget"], startLine: 2, endLine: 4 },
        { symbolId: "Widget#paint", scope: ["Widget"], startLine: 5, endLine: 5 },
        { symbolId: "topLevel", scope: [], startLine: 7, endLine: 9 },
      ],
    });
    const draw = result.chunks.find((chunk) => chunk.symbolId === "Widget#draw");
    const top = result.chunks.find((chunk) => chunk.symbolId === "topLevel");
    expect(draw?.calls.map((call) => [call.receiver, call.member])).toEqual([["this", "paint"]]);
    expect(draw?.symbolKind).toBe("method");
    expect(top?.symbolKind).toBe("function");
    expect(top?.calls.map((call) => [call.receiver, call.member])).toEqual([["name", "trim"]]);
  });

  it("keeps a star import", () => {
    const code = "import foo.Bar.*\nfun topLevel(name: String): String { return name }\n";
    const result = extractFromKotlinFile({
      tree: parse(code),
      code,
      relPath: "Lib.kt",
      language: "kotlin",
      chunks: [],
    });
    expect(result.imports.map((item) => item.importText)).toEqual(["foo.Bar.*"]);
  });
});
