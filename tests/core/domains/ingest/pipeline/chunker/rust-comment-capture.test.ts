import { beforeEach, describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import type { CodeChunk } from "../../../../../../src/core/types.js";

function lineNumbers(code: string, pattern: RegExp): number[] {
  return code
    .split("\n")
    .map((text, index) => ({ text, line: index + 1 }))
    .filter(({ text }) => pattern.test(text))
    .map(({ line }) => line);
}

function chunksCoveringLine(chunks: CodeChunk[], line: number): CodeChunk[] {
  return chunks.filter((chunk) => {
    const ranges = chunk.metadata.lineRanges?.length
      ? chunk.metadata.lineRanges
      : [{ start: chunk.startLine, end: chunk.endLine }];
    return ranges.some((range) => range.start <= line && line <= range.end);
  });
}

describe("TreeSitterChunker — Rust comment capture", () => {
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    chunker = new TreeSitterChunker(
      { chunkSize: 500, chunkOverlap: 50, maxChunkSize: 1000 },
      new DefaultSymbolIdComposer(),
      new LanguageFactory(),
    );
  });

  it("attaches doc and ordinary comments to the following method without leaking them to siblings", async () => {
    const code = `impl Worker {
    /// Sends one message to the worker.
    // The ordinary note belongs to send too.
    fn send(&self, message: &str) -> bool {
        message.len() > 0
    }

    // This comment documents the unrelated fallback method.
    fn fallback(&self) -> bool {
        true
    }
}
`;

    const chunks = await chunker.chunk(code, "worker.rs", "rust");
    const send = chunks.find((chunk) => chunk.metadata.symbolId === "Worker#send");
    const fallback = chunks.find((chunk) => chunk.metadata.symbolId === "Worker#fallback");

    expect(send).toBeDefined();
    expect(send?.content).toContain("Sends one message");
    expect(send?.content).toContain("ordinary note belongs to send");
    expect(send?.startLine).toBe(2);
    expect(fallback?.content).toContain("unrelated fallback method");
    expect(fallback?.content).not.toContain("Sends one message");
    expect(fallback?.content).not.toContain("ordinary note belongs to send");

    const commentLines = lineNumbers(code, /^\s*(\/\/\/|\/\/)/);
    for (const line of commentLines) {
      expect(chunksCoveringLine(chunks, line)).toHaveLength(1);
    }
  });

  it("attaches a comment separated from an associated function by outer attributes and preserves its source start", async () => {
    const code = `impl Worker {
    // Constructs a worker with the default queue.
    #[inline]
    fn new() -> Self {
        Self { queue: Vec::new() }
    }
}
`;

    const chunks = await chunker.chunk(code, "worker.rs", "rust");
    const constructor = chunks.find((chunk) => chunk.metadata.symbolId === "Worker.new");

    expect(constructor).toBeDefined();
    expect(constructor?.content).toContain("Constructs a worker");
    expect(constructor?.content).toContain("#[inline]");
    expect(constructor?.content).toContain("fn new");
    expect(constructor?.startLine).toBe(2);
    expect(constructor?.endLine).toBe(6);
    expect(chunks.filter((chunk) => chunk.metadata.symbolId === "Worker")).toHaveLength(0);
  });

  it("keeps a comment-only trait declaration with its associated method instead of orphaning the comment", async () => {
    const code = `trait Queue {
    /// Returns the next queued item.
    fn next(&self) -> Option<Item>;
}
`;

    const chunks = await chunker.chunk(code, "queue.rs", "rust");
    const next = chunks.find((chunk) => chunk.metadata.symbolId === "Queue::next");

    expect(next).toBeDefined();
    expect(next?.content).toContain("Returns the next queued item");
    expect(next?.content).toContain("fn next");
    expect(next?.startLine).toBe(2);
    expect(chunksCoveringLine(chunks, 2)).toEqual([next]);
  });

  it("does not attach a free comment-only block to the next associated item", async () => {
    const code = `impl Worker {
    // A note about the implementation section.

    fn run(&self) -> bool {
        true
    }
}
`;

    const chunks = await chunker.chunk(code, "worker.rs", "rust");
    const run = chunks.find((chunk) => chunk.metadata.symbolId === "Worker#run");

    expect(run).toBeDefined();
    expect(run?.content).not.toContain("implementation section");
    expect(run?.startLine).toBe(4);
  });
});
