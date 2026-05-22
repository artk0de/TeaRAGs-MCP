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

  describe("classFieldTypes — for cross-class resolver", () => {
    it("collects field types from constructor parameter properties", () => {
      const code = `import { MarkerStore } from "./store";\nclass Coordinator {\n  constructor(private readonly markerStore: MarkerStore) {}\n  go() { this.markerStore.write(); }\n}\n`;
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/coordinator.ts",
        language: "typescript",
        chunks: [{ symbolId: "Coordinator#go", startLine: 4, endLine: 4, scope: ["Coordinator"] }],
      });
      expect(extraction.classFieldTypes).toBeDefined();
      const fields = extraction.classFieldTypes?.["Coordinator"];
      expect(fields).toBeDefined();
      expect(fields?.["markerStore"]).toBe("MarkerStore");
    });

    it("collects field types from public field declarations", () => {
      const code = `class Store {\n  private readonly client: QdrantClient = createClient();\n  read() { return this.client.get(); }\n}\n`;
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/store.ts",
        language: "typescript",
        chunks: [{ symbolId: "Store#read", startLine: 3, endLine: 3, scope: ["Store"] }],
      });
      const fields = extraction.classFieldTypes?.["Store"];
      expect(fields?.["client"]).toBe("QdrantClient");
    });

    it("strips generic parameters — Foo<T> resolves to Foo", () => {
      const code = `class Holder {\n  constructor(private readonly list: Array<number>) {}\n}\n`;
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/holder.ts",
        language: "typescript",
        chunks: [],
      });
      expect(extraction.classFieldTypes?.["Holder"]?.["list"]).toBe("Array");
    });

    it("ignores constructor parameters WITHOUT accessibility modifier (plain params, not fields)", () => {
      const code = `class Plain {\n  constructor(input: string) { this.x = input; }\n}\n`;
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/plain.ts",
        language: "typescript",
        chunks: [],
      });
      // `input` has no `private`/`public`/`readonly` → not a field property
      expect(extraction.classFieldTypes?.["Plain"]).toBeUndefined();
    });

    it("returns empty record for files with no class declarations", () => {
      const code = `export function helper() { return 42; }\n`;
      const tree = parse(code);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath: "src/util.ts",
        language: "typescript",
        chunks: [],
      });
      expect(Object.keys(extraction.classFieldTypes ?? {}).length).toBe(0);
    });
  });
});
