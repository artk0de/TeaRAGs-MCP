import Parser from "tree-sitter";
import BashLang from "tree-sitter-bash";
import { describe, expect, it } from "vitest";

import { symbolKindOf } from "../../../../../../src/core/domains/language/bash/walker/symbol-kind.js";
import { extractFromBashFile } from "../../../../../../src/core/domains/language/bash/walker/walker.js";

function parse(src: string) {
  const p = new Parser();
  p.setLanguage(BashLang);
  return p.parse(src);
}

// bd tea-rags-mcp-vi0wx — bash's only kind is `function`: a `function_definition`
// node, which both written forms (`function f {}` and `f() {}`) parse to
// identically. Nothing else bashNameOf names, so nothing else is mapped.
describe("bash symbolKindOf — pure mapping", () => {
  it("maps function_definition to function", () => {
    expect(symbolKindOf("function_definition")).toBe("function");
  });

  it("maps every other node type to undefined", () => {
    expect(symbolKindOf("command")).toBeUndefined();
    expect(symbolKindOf("variable_assignment")).toBeUndefined();
    expect(symbolKindOf("program")).toBeUndefined();
  });
});

describe("extractFromBashFile — symbolKind on emitted chunks (tea-rags-mcp-vi0wx)", () => {
  it("tags a `function f {}` definition as function", () => {
    const src = "function deploy() {\n  echo hi\n}\n";
    const r = extractFromBashFile({
      tree: parse(src),
      code: src,
      relPath: "x.sh",
      language: "bash",
      chunks: [{ symbolId: "deploy", scope: [], startLine: 1, endLine: 3 }],
    });
    expect(r.chunks[0].symbolKind).toBe("function");
  });

  it("tags a `f() {}` definition as function — same node type as `function f {}`", () => {
    const src = "deploy() {\n  echo hi\n}\n";
    const r = extractFromBashFile({
      tree: parse(src),
      code: src,
      relPath: "x.sh",
      language: "bash",
      chunks: [{ symbolId: "deploy", scope: [], startLine: 1, endLine: 3 }],
    });
    expect(r.chunks[0].symbolKind).toBe("function");
  });

  it("tags every nested function definition, matched by name at its own start line", () => {
    const src = ["outer() {", "  inner() {", "    :", "  }", "}", ""].join("\n");
    const r = extractFromBashFile({
      tree: parse(src),
      code: src,
      relPath: "lib.sh",
      language: "bash",
      chunks: [
        { symbolId: "lib.sh::outer", scope: [], startLine: 1, endLine: 5 },
        { symbolId: "lib.sh::inner", scope: ["outer"], startLine: 2, endLine: 4 },
      ],
    });
    expect(r.chunks.map((c) => c.symbolKind)).toEqual(["function", "function"]);
  });
});
