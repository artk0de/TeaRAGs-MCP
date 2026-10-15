import { beforeEach, describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import type { ChunkerConfig } from "../../../../../../src/core/types.js";

describe("TreeSitterChunker — Rust test scopes", () => {
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    const config: ChunkerConfig = { chunkSize: 500, chunkOverlap: 50, maxChunkSize: 1000 };
    chunker = new TreeSitterChunker(config, new DefaultSymbolIdComposer(), new LanguageFactory());
  });

  it("emits test chunks for cfg(test) modules with stable scope and parent identity", async () => {
    const code = `mod production {
    pub fn value() -> usize {
        7
    }
}

#[cfg(test)]
mod tests {
    fn fixture() -> usize {
        7
    }

    #[test]
    fn parses_value() {
        assert_eq!(fixture(), 7);
    }

    mod nested {
        #[test]
        fn parses_nested_value() {
            assert_eq!(super::fixture(), 7);
        }
    }
}
`;

    const chunks = await chunker.chunk(code, "src/lib.rs", "rust");
    const parse = chunks.find((chunk) => chunk.metadata.symbolId?.endsWith("parses_value"));
    const nested = chunks.find((chunk) => chunk.metadata.symbolId?.endsWith("parses_nested_value"));

    expect(parse?.metadata.chunkType).toBe("test");
    expect(parse?.metadata.parentType).toBe("test_scope");
    expect(parse?.metadata.parentSymbolId).toBe("lib.tests");
    expect(parse?.metadata.symbolId).toBe("lib.tests.parses_value");
    expect(nested?.metadata.chunkType).toBe("test");
    expect(nested?.metadata.parentType).toBe("test_scope");
    expect(nested?.metadata.parentSymbolId).toBe("lib.tests.nested");
    expect(nested?.metadata.symbolId).toBe("lib.tests.nested.parses_nested_value");
  });

  it("keeps Rust test setup separate from examples and does not relabel production chunks", async () => {
    const code = `pub fn production_value(input: usize) -> usize {
    let doubled = input * 2;
    let adjusted = doubled.saturating_add(3);
    adjusted.saturating_sub(3)
}

#[cfg(test)]
mod tests {
    fn fixture() -> usize {
        production_value(7)
    }

    #[test]
    fn uses_fixture() {
        assert_eq!(fixture(), 7);
    }
}
`;

    const chunks = await chunker.chunk(code, "src/lib.rs", "rust");
    const production = chunks.find((chunk) => chunk.metadata.symbolId === "production_value");
    const setup = chunks.find((chunk) => chunk.metadata.chunkType === "test_setup");
    const example = chunks.find((chunk) => chunk.metadata.symbolId === "lib.tests.uses_fixture");

    expect(production?.metadata.chunkType).toBe("function");
    expect(production?.metadata.symbolId).toBe("production_value");
    expect(setup?.metadata.symbolId).toBe("lib.tests");
    expect(setup?.metadata.parentSymbolId).toBe("lib");
    expect(setup?.content).toContain("fn fixture");
    expect(example?.content).not.toContain("fn fixture");
  });
});
