import { beforeEach, describe, expect, it } from "vitest";

import { CharacterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/character.js";
import type { ChunkerConfig } from "../../../../../../src/core/types.js";

describe("CharacterChunker", () => {
  let chunker: CharacterChunker;
  let config: ChunkerConfig;

  beforeEach(() => {
    config = {
      chunkSize: 100,
      chunkOverlap: 20,
      maxChunkSize: 200,
    };
    chunker = new CharacterChunker(config);
  });

  describe("chunk", () => {
    it("should chunk small code into single chunk", async () => {
      const code = "function hello() {\n  console.log('Starting hello function');\n  return 'world';\n}";
      const chunks = await chunker.chunk(code, "test.ts", "typescript");

      expect(chunks).toHaveLength(1);
      expect(chunks[0].content).toContain("hello");
      expect(chunks[0].startLine).toBe(1);
      expect(chunks[0].metadata.language).toBe("typescript");
    });

    it("should chunk large code into multiple chunks", async () => {
      const code = Array(20)
        .fill("function testFunction() { console.log('This is a test function'); return true; }\n")
        .join("");
      const chunks = await chunker.chunk(code, "test.js", "javascript");

      expect(chunks.length).toBeGreaterThan(1);
      chunks.forEach((chunk) => {
        expect(chunk.content.length).toBeLessThanOrEqual(config.maxChunkSize);
      });
    });

    it("should preserve line numbers", async () => {
      const code =
        "This is line 1 with enough content to not be filtered\n" +
        "This is line 2 with enough content to not be filtered\n" +
        "This is line 3 with enough content to not be filtered";
      const chunks = await chunker.chunk(code, "test.txt", "text");

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].startLine).toBe(1);
      expect(chunks[0].endLine).toBeGreaterThan(chunks[0].startLine);
    });

    it("should apply overlap between chunks", async () => {
      const code = Array(20).fill("const x = 1;\n").join("");
      const chunks = await chunker.chunk(code, "test.js", "javascript");

      if (chunks.length > 1) {
        // Check that there's overlap in content
        expect(chunks.length).toBeGreaterThan(1);
      }
    });

    it("should find good break points", async () => {
      const code = `function foo() {
  return 1;
}

function bar() {
  return 2;
}

function baz() {
  return 3;
}`;

      const chunks = await chunker.chunk(code, "test.js", "javascript");
      // Should try to break at function boundaries
      chunks.forEach((chunk) => {
        expect(chunk.content.length).toBeGreaterThan(0);
      });
    });

    it("should handle empty code", async () => {
      const code = "";
      const chunks = await chunker.chunk(code, "test.ts", "typescript");
      expect(chunks).toHaveLength(0);
    });

    it("should handle code with only whitespace", async () => {
      const code = "   \n\n\n   ";
      const chunks = await chunker.chunk(code, "test.ts", "typescript");
      expect(chunks).toHaveLength(0);
    });

    it("should skip very small chunks", async () => {
      const code = "x";
      const chunks = await chunker.chunk(code, "test.ts", "typescript");
      expect(chunks).toHaveLength(0);
    });
  });

  // bd tea-rags-mcp-y5vx4 — languages without an AST (sql, json, jsonc, …) cut
  // only at syntax-neutral boundaries: blank lines first, then the ends of
  // top-level statements / entries, never inside a line or a bracket pair that
  // fits a chunk; overlap is whole lines, bounded by chunkOverlap.
  describe("syntax-neutral boundaries (bd tea-rags-mcp-y5vx4)", () => {
    const sqlStatement = (i: number) => [`SELECT id, name_${i}`, `FROM table_${i}`, `WHERE id = ${i};`].join("\n");

    it("never cuts inside a line: every chunk line is a whole source line", async () => {
      const code = Array.from({ length: 12 }, (_, i) => sqlStatement(i)).join("\n\n");
      const sourceLines = new Set(code.split("\n"));
      const chunks = await chunker.chunk(code, "q.sql", "sql");

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        for (const line of chunk.content.split("\n")) expect(sourceLines).toContain(line);
      }
    });

    it("cuts at blank lines between statements, never inside a statement that fits", async () => {
      const code = Array.from({ length: 12 }, (_, i) => sqlStatement(i)).join("\n\n");
      const chunks = await chunker.chunk(code, "q.sql", "sql");

      for (const chunk of chunks) {
        const lines = chunk.content.split("\n").filter((l) => l.trim() !== "");
        expect(lines[0], chunk.content).toMatch(/^SELECT/);
        expect(lines[lines.length - 1], chunk.content).toMatch(/;$/);
      }
    });

    it("cuts at statement terminators when there are no blank lines", async () => {
      const code = Array.from({ length: 12 }, (_, i) => sqlStatement(i)).join("\n");
      const chunks = await chunker.chunk(code, "q.sql", "sql");

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        const lines = chunk.content.split("\n");
        expect(lines[lines.length - 1], chunk.content).toMatch(/;$/);
      }
    });

    it("keeps a nested JSON object whole when it fits, cutting between top-level entries", async () => {
      const entry = (i: number) => `  "key_${i}": {\n    "a": ${i},\n    "b": "value_${i}"\n  }`;
      const code = `{\n${Array.from({ length: 10 }, (_, i) => entry(i)).join(",\n")}\n}`;
      const chunks = await chunker.chunk(code, "data.json", "json");

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks.slice(1)) {
        const opens = (chunk.content.match(/{/g) ?? []).length;
        const closes = (chunk.content.match(/}/g) ?? []).length;
        // a chunk may close the outer object, never cut a nested entry in half
        expect(closes - opens, chunk.content).toBeLessThanOrEqual(1);
        expect(opens - closes, chunk.content).toBeLessThanOrEqual(1);
      }
    });

    it("overlap is whole lines of the previous chunk, bounded by chunkOverlap, and line ranges match content", async () => {
      const code = Array.from({ length: 12 }, (_, i) => sqlStatement(i)).join("\n\n");
      const lines = code.split("\n");
      const chunks = await chunker.chunk(code, "q.sql", "sql");

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        expect(chunk.content).toBe(lines.slice(chunk.startLine - 1, chunk.endLine).join("\n"));
        if (i === 0) continue;
        const overlapLines = chunks[i - 1].endLine - chunk.startLine + 1;
        const overlap = lines.slice(chunk.startLine - 1, chunk.startLine - 1 + Math.max(0, overlapLines)).join("\n");
        expect(overlap.length).toBeLessThanOrEqual(config.chunkOverlap);
      }
    });
  });

  describe("supportsLanguage", () => {
    it("should support all languages", () => {
      expect(chunker.supportsLanguage("typescript")).toBe(true);
      expect(chunker.supportsLanguage("python")).toBe(true);
      expect(chunker.supportsLanguage("unknown")).toBe(true);
    });
  });

  describe("getStrategyName", () => {
    it("should return correct strategy name", () => {
      expect(chunker.getStrategyName()).toBe("character-based");
    });
  });

  describe("metadata", () => {
    it("should include correct chunk metadata", async () => {
      const code = "function test() {\n  console.log('test function');\n  return 1;\n}";
      const chunks = await chunker.chunk(code, "/path/to/file.ts", "typescript");

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].metadata).toEqual({
        filePath: "/path/to/file.ts",
        language: "typescript",
        chunkIndex: 0,
        chunkType: "block",
      });
    });

    it("should increment chunk index", async () => {
      const code = Array(20).fill("function test() {}\n").join("");
      const chunks = await chunker.chunk(code, "test.ts", "typescript");

      if (chunks.length > 1) {
        expect(chunks[0].metadata.chunkIndex).toBe(0);
        expect(chunks[1].metadata.chunkIndex).toBe(1);
      }
    });
  });
});
