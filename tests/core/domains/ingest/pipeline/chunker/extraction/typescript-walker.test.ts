import Parser from "tree-sitter";
import TsLang from "tree-sitter-typescript";
import { describe, expect, it } from "vitest";

import { extractFromTypescriptFile } from "../../../../../../../src/core/domains/ingest/pipeline/chunker/extraction/typescript-walker.js";

function parse(code: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage((TsLang as { typescript: Parser.Language }).typescript);
  return parser.parse(code);
}

describe("extractFromTypescriptFile", () => {
  it("extracts top-level imports with text and startLine", () => {
    const code = `import { Foo } from "./foo";\nimport React from "react";\nfunction main() { Foo.bar(); }\n`;
    const tree = parse(code);
    const extraction = extractFromTypescriptFile({
      tree,
      code,
      relPath: "src/a.ts",
      language: "typescript",
      chunks: [{ symbolId: "main", startLine: 3, endLine: 3, scope: [] }],
    });
    expect(extraction.imports.map((i) => i.importText).sort()).toEqual(["./foo", "react"]);
    expect(extraction.imports.every((i) => i.startLine > 0)).toBe(true);
  });

  it("attaches calls inside a chunk's line range to that chunk", () => {
    const code = `function main() {\n  Foo.bar();\n  baz();\n}\n`;
    const tree = parse(code);
    const extraction = extractFromTypescriptFile({
      tree,
      code,
      relPath: "src/a.ts",
      language: "typescript",
      chunks: [{ symbolId: "main", startLine: 1, endLine: 4, scope: [] }],
    });
    const calls = extraction.chunks[0]?.calls ?? [];
    expect(calls.map((c) => c.member).sort()).toEqual(["bar", "baz"]);
    const fooCall = calls.find((c) => c.member === "bar");
    expect(fooCall?.receiver).toBe("Foo");
    const bazCall = calls.find((c) => c.member === "baz");
    expect(bazCall?.receiver).toBeNull();
  });

  it("does not attach calls outside any chunk", () => {
    const code = `Foo.outside();\nfunction main() { bar(); }\n`;
    const tree = parse(code);
    const extraction = extractFromTypescriptFile({
      tree,
      code,
      relPath: "src/a.ts",
      language: "typescript",
      chunks: [{ symbolId: "main", startLine: 2, endLine: 2, scope: [] }],
    });
    const memberCalls = extraction.chunks[0].calls.map((c) => c.member);
    expect(memberCalls).toContain("bar");
    expect(memberCalls).not.toContain("outside");
  });

  it("returns an empty extraction when chunks list is empty", () => {
    const code = `import "./x";\n`;
    const tree = parse(code);
    const extraction = extractFromTypescriptFile({
      tree,
      code,
      relPath: "src/empty.ts",
      language: "typescript",
      chunks: [],
    });
    expect(extraction.chunks).toEqual([]);
    expect(extraction.imports.map((i) => i.importText)).toEqual(["./x"]);
  });
});
