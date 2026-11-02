import { beforeEach, describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import { classify } from "../../../../../../src/core/primitives/paths/file-classification/index.js";
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

describe("TreeSitterChunker — Rust inline tests read from attribute AST", () => {
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    const config: ChunkerConfig = { chunkSize: 500, chunkOverlap: 50, maxChunkSize: 1000 };
    chunker = new TreeSitterChunker(config, new DefaultSymbolIdComposer(), new LanguageFactory());
  });

  const LIB_RS = `pub fn add(left: usize, right: usize) -> usize {
    let sum = left.saturating_add(right);
    sum
}

#[cfg(test)]
fn fixture() -> usize {
    let seeded = add(20, 22);
    seeded.saturating_mul(1)
}

#[test]
fn smoke() {
    let total = add(fixture(), 0);
    assert_eq!(total, 42);
}

#[cfg(test)] mod tests { use super::*; #[test] fn it_works() { add(1, 2); } }

#[cfg(any(test, feature = "x"))]
mod testing {
    pub fn h() -> usize {
        let helper_value = super::add(3, 4);
        helper_value
    }
}
`;

  const chunkHolding = <T extends { content: string }>(chunks: T[], text: string): T | undefined =>
    chunks.find((chunk) => chunk.content.includes(text));

  it("labels top-level test-only items and same-line attributes, leaving production and conditional cfg alone", async () => {
    const chunks = await chunker.chunk(LIB_RS, "src/lib.rs", "rust");
    const testTypes = new Set(["test", "test_setup"]);

    expect(testTypes.has(chunkHolding(chunks, "pub fn add")?.metadata.chunkType ?? "")).toBe(false);
    expect(testTypes.has(chunkHolding(chunks, "pub fn h")?.metadata.chunkType ?? "")).toBe(false);
    expect(chunkHolding(chunks, "fn fixture()")?.metadata.chunkType).toBe("test_setup");
    expect(chunkHolding(chunks, "fn smoke()")?.metadata.chunkType).toBe("test");
    // The one-line module: `#[cfg(test)]` and `#[test]` share the item's row,
    // which the retired line reader could not see. Every body chunk of the
    // module opens with that row as its container header, so the example is
    // found by id, not by text.
    const itWorks = chunks.find((chunk) => chunk.metadata.symbolId === "lib.tests.it_works");
    expect(itWorks?.metadata.chunkType).toBe("test");
  });

  it("ids a top-level test-only item under the file subject, as the kernel ids a test module", async () => {
    const chunks = await chunker.chunk(LIB_RS, "src/lib.rs", "rust");

    expect(chunkHolding(chunks, "fn fixture()")?.metadata.symbolId).toBe("lib.fixture");
    expect(chunkHolding(chunks, "fn smoke()")?.metadata.symbolId).toBe("lib.smoke");
    expect(chunkHolding(chunks, "pub fn add")?.metadata.symbolId).toBe("add");
  });

  it("keeps the attribute rows above a top-level test item inside its chunk", async () => {
    const chunks = await chunker.chunk(LIB_RS, "src/lib.rs", "rust");
    const smoke = chunkHolding(chunks, "fn smoke()");
    const fixture = chunkHolding(chunks, "fn fixture()");

    expect(smoke?.startLine).toBe(12);
    expect(smoke?.content).toContain("#[test]");
    expect(fixture?.startLine).toBe(6);
    expect(fixture?.content).toContain("#[cfg(test)]");
  });

  it("labels only the test-family functions of a module without a test-only cfg", async () => {
    const code = `mod checks {
    pub fn production_helper(input: usize) -> usize {
        input.saturating_mul(2).saturating_add(1)
    }

    #[test]
    fn helper_doubles() {
        assert_eq!(production_helper(2), 5);
    }
}
`;
    const chunks = await chunker.chunk(code, "src/lib.rs", "rust");

    expect(chunkHolding(chunks, "fn helper_doubles()")?.metadata.chunkType).toBe("test");
    expect(chunkHolding(chunks, "pub fn production_helper")?.metadata.chunkType).toBe("function");
  });

  // Pinned boundary: only chunkable containers (function / impl / trait /
  // struct / enum / mod / macro) can be claimed. A top-level test-only `const`
  // (or `use`, which never joins any chunk) is not one, so it stays in the
  // module remainder with its generic label.
  it("leaves a top-level test-only const in the module remainder", async () => {
    const code = `#[cfg(test)]
const FIXTURE_TABLE: [usize; 6] = [10, 20, 30, 40, 50, 60];

pub fn production_value(input: usize) -> usize {
    input.saturating_mul(2).saturating_add(1)
}

pub fn other_production_value(input: usize) -> usize {
    input.saturating_mul(3).saturating_add(2)
}
`;
    const chunks = await chunker.chunk(code, "src/lib.rs", "rust");
    const holder = chunkHolding(chunks, "const FIXTURE_TABLE");

    expect(holder).toBeDefined();
    expect(holder?.metadata.chunkType).not.toBe("test");
    expect(holder?.metadata.chunkType).not.toBe("test_setup");
  });
});

describe("TreeSitterChunker — Rust file made test-only by an inner #![cfg(test)]", () => {
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    const config: ChunkerConfig = { chunkSize: 500, chunkOverlap: 50, maxChunkSize: 1000 };
    chunker = new TreeSitterChunker(config, new DefaultSymbolIdComposer(), new LanguageFactory());
  });

  const BODY = `use std::vec::Vec;

pub fn make_fixture() -> Vec<u8> {
    let mut bytes = Vec::with_capacity(16);
    bytes.extend_from_slice(&[1, 2, 3, 4]);
    bytes
}

impl Fixture {
    fn new() -> Self {
        Fixture { bytes: make_fixture() }
    }
}

#[test]
fn uses_fixture() {
    let fixture = Fixture::new();
    assert_eq!(fixture.bytes.len(), 4);
}
`;

  it("types every chunk of the file as a test chunk, the #[test] function as test", async () => {
    const chunks = await chunker.chunk(`#![cfg(test)]\n\n${BODY}`, "src/foo/helpers.rs", "rust");

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(["test", "test_setup"], `${chunk.metadata.symbolId} ${chunk.startLine}`).toContain(
        chunk.metadata.chunkType,
      );
    }
    const usesFixture = chunks.find((chunk) => chunk.content.includes("fn uses_fixture()"));
    expect(usesFixture?.metadata.chunkType).toBe("test");
    expect(usesFixture?.metadata.symbolId).toBe("helpers.uses_fixture");
    expect(chunks.find((chunk) => chunk.content.includes("pub fn make_fixture"))?.metadata.symbolId).toBe(
      "helpers.make_fixture",
    );
    expect(chunks.find((chunk) => chunk.content.startsWith("impl Fixture"))?.metadata.symbolId).toBe("helpers.Fixture");
  });

  it("ids a module of a test-only file as a test scope, as an inline test module", async () => {
    const code = `#![cfg(test)]

mod nested {
    #[test]
    fn it_works() {
        assert_eq!(super::make_fixture().len(), 4);
    }
}
`;
    const chunks = await chunker.chunk(code, "src/foo/helpers.rs", "rust");
    const itWorks = chunks.find((chunk) => chunk.metadata.symbolId === "helpers.nested.it_works");

    expect(itWorks?.metadata.chunkType).toBe("test");
  });

  // Pinned boundary: the module remainder (top-level rows no chunk carries —
  // here a struct under the 50-char chunk floor) is emitted by the engine
  // (`TreeSitterChunker#withModuleRemainder`) as `block`; no language hook or
  // classifier types it, so a test-only file's remainder stays production-typed.
  it("leaves the module remainder of a test-only file to the engine", async () => {
    const code = `#![cfg(test)]

pub struct Fixture {
    bytes: Vec<u8>,
}

pub fn make_fixture() -> Vec<u8> {
    let mut bytes = Vec::with_capacity(16);
    bytes.extend_from_slice(&[1, 2, 3, 4]);
    bytes
}
`;
    const chunks = await chunker.chunk(code, "src/foo/helpers.rs", "rust");

    expect(chunks.find((chunk) => chunk.content.includes("pub struct Fixture"))?.metadata.chunkType).toBe("block");
    expect(chunks.find((chunk) => chunk.content.includes("pub fn make_fixture"))?.metadata.chunkType).toBe(
      "test_setup",
    );
  });

  it("keeps production chunk types when the file has no inner test-only cfg", async () => {
    const chunks = await chunker.chunk(BODY, "src/foo/helpers.rs", "rust");
    const typeOf = (text: string) => chunks.find((chunk) => chunk.content.includes(text))?.metadata.chunkType;

    expect(typeOf("pub fn make_fixture")).toBe("function");
    expect(typeOf("fn new()")).not.toMatch(/^test/);
    expect(typeOf("fn uses_fixture()")).toBe("test");
  });
});

describe("Rust test files by path", () => {
  it("classifies tests.rs — the body of `#[cfg(test)] mod tests;` — as a test file", () => {
    expect(classify("src/foo/tests.rs").isTest).toBe(true);
  });
});
