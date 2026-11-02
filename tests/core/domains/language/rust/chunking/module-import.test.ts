import { beforeEach, describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import type { ChunkerConfig } from "../../../../../../src/core/types.js";

// The engine keeps imports out of the module remainder; the attribute rows of
// such an import, and a body-less test-only `mod x;`, must leave it too.
describe("TreeSitterChunker — Rust module remainder keeps imports' attributes and test-only mod declarations out", () => {
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    const config: ChunkerConfig = { chunkSize: 500, chunkOverlap: 50, maxChunkSize: 1000 };
    chunker = new TreeSitterChunker(config, new DefaultSymbolIdComposer(), new LanguageFactory());
  });

  const CODE = `pub fn production_value(input: usize) -> usize {
    input.saturating_mul(2).saturating_add(1)
}

#[cfg(test)]
use super::helper;

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

#[cfg(test)]
mod testutil;

pub mod parser;

pub const DEFAULT_LIMIT: usize = 4096 * 16 + 1024;
`;

  const isTestChunk = (chunkType: string | undefined) => chunkType === "test" || chunkType === "test_setup";

  it("keeps the #[cfg(test)] rows of a test-only import and a body-less test-only mod out of production chunks", async () => {
    const chunks = await chunker.chunk(CODE, "src/lib.rs", "rust");

    for (const chunk of chunks.filter((candidate) => !isTestChunk(candidate.metadata.chunkType))) {
      expect(chunk.content, `${chunk.metadata.chunkType} ${chunk.startLine}`).not.toContain("#[cfg(test)]");
      expect(chunk.content, `${chunk.metadata.chunkType} ${chunk.startLine}`).not.toContain("mod testutil;");
    }
  });

  it("keeps the outer doc comment of a body-less test-only mod out of production chunks", async () => {
    const code = CODE.replace("#[cfg(test)]\nmod testutil;", "/// Shared test helpers.\n#[cfg(test)]\nmod testutil;");
    const chunks = await chunker.chunk(code, "src/lib.rs", "rust");

    for (const chunk of chunks.filter((candidate) => !isTestChunk(candidate.metadata.chunkType))) {
      expect(chunk.content, `${chunk.metadata.chunkType} ${chunk.startLine}`).not.toContain("Shared test helpers.");
    }
  });

  it("drops the attribute of any import with its import, and keeps a production mod declaration", async () => {
    const chunks = await chunker.chunk(CODE, "src/lib.rs", "rust");

    expect(chunks.some((chunk) => chunk.content.includes("#[cfg(windows)]"))).toBe(false);
    const parser = chunks.find((chunk) => chunk.content.includes("pub mod parser;"));
    expect(parser).toBeDefined();
    expect(isTestChunk(parser?.metadata.chunkType)).toBe(false);
  });
});
