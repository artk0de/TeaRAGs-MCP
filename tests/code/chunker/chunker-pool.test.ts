/**
 * Tests for ChunkerPool - worker_threads pool for parallel AST parsing
 *
 * NOTE: Requires `npm run build` before running (workers load compiled JS).
 */

import { afterEach, describe, expect, it } from "vitest";
import { ChunkerPool } from "../../../src/code/chunker/chunker-pool.js";
import { TreeSitterChunker } from "../../../src/code/chunker/tree-sitter-chunker.js";
import type { ChunkerConfig } from "../../../src/code/types.js";

const CHUNKER_CONFIG: ChunkerConfig = {
  chunkSize: 500,
  chunkOverlap: 50,
  maxChunkSize: 1000,
};

const TYPESCRIPT_CODE = `
function add(a: number, b: number): number {
  return a + b;
}

function multiply(a: number, b: number): number {
  return a * b;
}
`.trim();

const PYTHON_CODE = `
def greet(name: str) -> str:
    return f"Hello, {name}!"

def farewell(name: str) -> str:
    return f"Goodbye, {name}!"
`.trim();

const JAVASCRIPT_CODE = `
function divide(a, b) {
  if (b === 0) throw new Error("Division by zero");
  return a / b;
}

function subtract(a, b) {
  return a - b;
}
`.trim();

describe("ChunkerPool", () => {
  let pool: ChunkerPool;

  afterEach(async () => {
    if (pool) {
      await pool.shutdown();
    }
  });

  describe("single file processing", () => {
    it("should process a TypeScript file and return chunks", async () => {
      pool = new ChunkerPool(1, CHUNKER_CONFIG);

      const result = await pool.processFile("test.ts", TYPESCRIPT_CODE, "typescript");

      expect(result.filePath).toBe("test.ts");
      expect(result.chunks.length).toBeGreaterThanOrEqual(2);
      expect(result.chunks.some((c) => c.metadata.name === "add")).toBe(true);
      expect(result.chunks.some((c) => c.metadata.name === "multiply")).toBe(true);
    });

    it("should produce same chunks as direct TreeSitterChunker", async () => {
      pool = new ChunkerPool(1, CHUNKER_CONFIG);
      const directChunker = new TreeSitterChunker(CHUNKER_CONFIG);

      const [poolResult, directResult] = await Promise.all([
        pool.processFile("test.ts", TYPESCRIPT_CODE, "typescript"),
        directChunker.chunk(TYPESCRIPT_CODE, "test.ts", "typescript"),
      ]);

      expect(poolResult.chunks.length).toBe(directResult.length);

      for (let i = 0; i < poolResult.chunks.length; i++) {
        expect(poolResult.chunks[i].content).toBe(directResult[i].content);
        expect(poolResult.chunks[i].metadata.name).toBe(directResult[i].metadata.name);
        expect(poolResult.chunks[i].metadata.language).toBe(directResult[i].metadata.language);
      }
    });

    it("should handle Python files", async () => {
      pool = new ChunkerPool(1, CHUNKER_CONFIG);

      const result = await pool.processFile("test.py", PYTHON_CODE, "python");

      expect(result.filePath).toBe("test.py");
      expect(result.chunks.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("parallel processing", () => {
    it("should process multiple files concurrently with multiple workers", async () => {
      pool = new ChunkerPool(3, CHUNKER_CONFIG);

      const results = await Promise.all([
        pool.processFile("a.ts", TYPESCRIPT_CODE, "typescript"),
        pool.processFile("b.py", PYTHON_CODE, "python"),
        pool.processFile("c.js", JAVASCRIPT_CODE, "javascript"),
      ]);

      expect(results).toHaveLength(3);
      expect(results[0].filePath).toBe("a.ts");
      expect(results[1].filePath).toBe("b.py");
      expect(results[2].filePath).toBe("c.js");

      // Each should have produced chunks
      for (const result of results) {
        expect(result.chunks.length).toBeGreaterThan(0);
      }
    });

    it("should queue requests when more files than workers", async () => {
      pool = new ChunkerPool(1, CHUNKER_CONFIG);

      // Submit 3 files but only 1 worker — they must be queued
      const results = await Promise.all([
        pool.processFile("a.ts", TYPESCRIPT_CODE, "typescript"),
        pool.processFile("b.ts", TYPESCRIPT_CODE, "typescript"),
        pool.processFile("c.ts", TYPESCRIPT_CODE, "typescript"),
      ]);

      expect(results).toHaveLength(3);
      // All should have identical chunks since same code
      expect(results[0].chunks.length).toBe(results[1].chunks.length);
      expect(results[1].chunks.length).toBe(results[2].chunks.length);
    });
  });

  describe("shutdown", () => {
    it("should reject processFile after shutdown", async () => {
      pool = new ChunkerPool(1, CHUNKER_CONFIG);
      await pool.shutdown();

      await expect(
        pool.processFile("test.ts", TYPESCRIPT_CODE, "typescript"),
      ).rejects.toThrow("shut down");
    });
  });

  describe("error handling", () => {
    it("should handle unsupported language gracefully (fallback chunker)", async () => {
      pool = new ChunkerPool(1, CHUNKER_CONFIG);

      // "haskell" is not supported — should fall back to character chunking
      const code = "module Main where\nmain = putStrLn \"Hello\"\n-- more code here to reach minimum size\n-- padding line\n-- padding line\n-- padding line";
      const result = await pool.processFile("test.hs", code, "haskell");

      expect(result.filePath).toBe("test.hs");
      // Character fallback should still produce chunks (or empty for tiny code)
    });
  });
});
