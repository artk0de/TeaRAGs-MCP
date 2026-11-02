import { beforeEach, describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import { classify } from "../../../../../../src/core/primitives/paths/file-classification/index.js";
import type { ChunkerConfig } from "../../../../../../src/core/types.js";

/** A chunk whose type sets `payload.isTest` — anything else is production code. */
const isTestChunk = (chunk: { metadata: { chunkType?: string } }): boolean =>
  chunk.metadata.chunkType === "test" || chunk.metadata.chunkType === "test_setup";

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

  it("keeps the outer doc comment above a test-only item inside its test chunk, out of production chunks", async () => {
    const code = `pub fn production_value(input: usize) -> usize {
    input.saturating_mul(2).saturating_add(1)
}

/// Documented test module.
#[allow(dead_code)]
#[cfg(all(test, feature = "slow"))]
mod slow_tests {
    #[test]
    fn slow_add() {
        assert_eq!(40 + 2, 42);
    }
}

/** Documented fixture. */
#[cfg(test)]
fn fixture() -> usize {
    let table = [10, 20, 30, 40, 50, 60];
    table.iter().sum()
}

#[allow(dead_code)]
/// Documented test impl.
#[cfg(test)]
impl Engine {
    fn idle_for_tests() -> Self {
        Engine { speed: 0 }
    }
}

/// Documented test struct.
#[cfg(test)]
struct FixtureTable {
    rows: Vec<(usize, usize, usize, usize)>,
}

// A plain note, not documentation.
#[cfg(test)]
fn other_fixture() -> usize {
    let table = [11, 21, 31, 41, 51, 61];
    table.iter().sum()
}

/// Documented production function.
pub fn other_production_value(input: usize) -> usize {
    input.saturating_mul(3).saturating_add(2)
}
`;
    const chunks = await chunker.chunk(code, "src/lib.rs", "rust");
    const isTestChunk = (chunkType: string | undefined) => chunkType === "test" || chunkType === "test_setup";
    const docs = ["Documented test module.", "Documented fixture.", "Documented test impl.", "Documented test struct."];

    for (const chunk of chunks.filter((candidate) => !isTestChunk(candidate.metadata.chunkType))) {
      for (const doc of docs) {
        expect(chunk.content, `${chunk.metadata.chunkType} ${chunk.startLine}`).not.toContain(doc);
      }
    }
    // Rows of `/// Documented test module.`, `/** Documented fixture. */`,
    // `/// Documented test impl.` and `/// Documented test struct.`.
    for (const row of [5, 15, 23, 31]) {
      const owner = chunks.find(
        (chunk) => isTestChunk(chunk.metadata.chunkType) && chunk.startLine <= row && row <= chunk.endLine,
      );
      expect(owner, `doc row ${row}`).toBeDefined();
    }
    expect(chunkHolding(chunks, "fn fixture()")?.content).toContain("Documented fixture.");
    expect(chunkHolding(chunks, "struct FixtureTable")?.content).toContain("Documented test struct.");
    // A plain comment is not documentation, and a production item keeps today's range.
    expect(chunkHolding(chunks, "fn other_fixture()")?.content).not.toContain("A plain note");
    expect(chunkHolding(chunks, "pub fn other_production_value")?.startLine).toBe(45);
  });

  it("keeps the attribute rows above a test-only module inside its test scope, out of the production remainder", async () => {
    const code = `pub fn production_value(input: usize) -> usize {
    input.saturating_mul(2).saturating_add(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_works() {
        assert_eq!(2 + 2, 4);
    }
}

#[allow(dead_code)]
#[cfg(all(test, feature = "slow"))]
mod slow {
    #[test]
    fn slow_add() {
        assert_eq!(40 + 2, 42);
    }
}
`;
    const chunks = await chunker.chunk(code, "src/lib.rs", "rust");
    const isTestChunk = (chunkType: string | undefined) => chunkType === "test" || chunkType === "test_setup";

    for (const chunk of chunks.filter((candidate) => !isTestChunk(candidate.metadata.chunkType))) {
      expect(chunk.content, `${chunk.metadata.chunkType} ${chunk.startLine}`).not.toContain("#[cfg(test)]");
      expect(chunk.content, `${chunk.metadata.chunkType} ${chunk.startLine}`).not.toContain("cfg(all(test");
    }
    // Rows 5 (`#[cfg(test)]`), 15 (`#[allow(dead_code)]`) and 16 (`#[cfg(all(test, …))]`).
    for (const row of [5, 15, 16]) {
      const owner = chunks.find(
        (chunk) => chunk.metadata.chunkType === "test_setup" && chunk.startLine <= row && row <= chunk.endLine,
      );
      expect(owner, `attribute row ${row}`).toBeDefined();
    }
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

  // INVARIANT CHANGED (bd tea-rags-mcp-52wk3.9): an inline test node never
  // yields a production chunk. A top-level test-only `const` used to stay in
  // the production module remainder with its generic label; it is now its own
  // `test_setup` chunk, ided under the file subject. (`use` still never joins
  // any chunk.)
  it("chunks a top-level test-only const as its own test setup, out of the module remainder", async () => {
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

    expect(holder?.metadata.chunkType).toBe("test_setup");
    expect(holder?.metadata.symbolId).toBe("lib.FIXTURE_TABLE");
    expect(holder?.startLine).toBe(1);
    expect(
      chunks.filter((chunk) => !isTestChunk(chunk) && chunk.content.includes("FIXTURE_TABLE")).map((c) => c.content),
    ).toEqual([]);
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

  // The module remainder (top-level rows no chunk carries — here a struct under
  // the 50-char chunk floor) is emitted by the engine
  // (`TreeSitterChunker#withModuleRemainder`); the Rust
  // `moduleRemainderChunkType` hook types it `test_setup` in a test-only file.
  it("types the module remainder of a test-only file as test setup", async () => {
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

    expect(chunks.find((chunk) => chunk.content.includes("pub struct Fixture"))?.metadata.chunkType).toBe("test_setup");
    expect(chunks.find((chunk) => chunk.content.includes("pub fn make_fixture"))?.metadata.chunkType).toBe(
      "test_setup",
    );
  });

  it("types the remainder holding a fixture under the chunk floor as test setup", async () => {
    const code = `#![cfg(test)]

use super::*;

fn base() -> u64 {
    3
}

fn shared() -> u64 {
    sq(3)
}

#[test]
fn squares_three() {
    assert_eq!(shared(), sq(base()));
}
`;
    const chunks = await chunker.chunk(code, "src/foo/helpers.rs", "rust");

    expect(chunks.find((chunk) => chunk.content.includes("fn shared()"))?.metadata.chunkType).toBe("test_setup");
    expect(chunks.find((chunk) => chunk.content.includes("fn base()"))?.metadata.chunkType).toBe("test_setup");
  });

  it("keeps the module remainder of a file without a test-only cfg a production block", async () => {
    const code = `#![allow(dead_code)]
use std::vec::Vec;

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
  });

  it("keeps production chunk types when the file has no inner test-only cfg", async () => {
    const chunks = await chunker.chunk(BODY, "src/foo/helpers.rs", "rust");
    const typeOf = (text: string) => chunks.find((chunk) => chunk.content.includes(text))?.metadata.chunkType;

    expect(typeOf("pub fn make_fixture")).toBe("function");
    expect(typeOf("fn new()")).not.toMatch(/^test/);
    expect(typeOf("fn uses_fixture()")).toBe("test");
  });
});

// A claimed test item nested in a non-test module hangs under the module path
// the engine composes for its relabelled leaves (`inner.accelerates_from_idle`,
// `outer::deep.deep_test_runs_fine`), not under the file subject.
describe("TreeSitterChunker — Rust test items nested in a non-test module", () => {
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    const config: ChunkerConfig = { chunkSize: 500, chunkOverlap: 50, maxChunkSize: 1000 };
    chunker = new TreeSitterChunker(config, new DefaultSymbolIdComposer(), new LanguageFactory());
  });

  const ENGINE_RS = `pub mod inner {
    pub struct Engine { pub speed: u64 }
    impl Engine { pub fn accelerate(&mut self, delta: u64) -> u64 { self.speed += delta; self.speed } }
    #[cfg(test)]
    impl Engine { pub fn idle_for_tests() -> Self { Engine { speed: 0 } } }
    #[cfg(test)]
    fn engine_fixture_with_speed(speed: u64) -> Engine { Engine { speed } }
    #[test]
    fn accelerates_from_idle() { let mut e = engine_fixture_with_speed(0); assert_eq!(e.accelerate(3), 3); }
    #[cfg(test)]
    mod tests { #[test] fn it_works() { assert_eq!(super::engine_fixture_with_speed(1).speed, 1); } }
}

pub mod outer {
    pub mod deep {
        pub fn production_value(input: u64) -> u64 { input.saturating_mul(2).saturating_add(1) }
        #[cfg(test)]
        impl Probe { pub fn probe_for_tests() -> Self { Probe { speed: 0, label: String::new() } } }
        #[test]
        fn deep_test_runs_fine() { assert_eq!(super::deep::production_value(1), 3); }
    }
}
`;

  const byId = <T extends { metadata: { symbolId?: string } }>(chunks: T[], id: string): T | undefined =>
    chunks.find((chunk) => chunk.metadata.symbolId === id);

  it("ids a claimed test-only impl under its enclosing module, as the engine ids the module's test leaves", async () => {
    const chunks = await chunker.chunk(ENGINE_RS, "src/engine.rs", "rust");

    expect(byId(chunks, "inner.Engine")?.metadata.chunkType).toBe("test_setup");
    expect(byId(chunks, "inner.Engine")?.metadata.parentSymbolId).toBe("inner");
    expect(byId(chunks, "inner.engine_fixture_with_speed")?.metadata.chunkType).toBe("test_setup");
    expect(byId(chunks, "inner.accelerates_from_idle")?.metadata.chunkType).toBe("test");
    expect(byId(chunks, "inner::tests.it_works")?.metadata.chunkType).toBe("test");
    expect(chunks.some((chunk) => chunk.metadata.symbolId?.startsWith("engine."))).toBe(false);
  });

  it("keeps the attribute rows of a module's test members out of its production remainder (52wk3.9)", async () => {
    const code = `pub mod inner {
    pub struct Engine { pub speed: u64 }
    #[cfg(test)]
    impl Engine { pub fn idle_for_tests() -> Self { Engine { speed: 0 } } }
    #[cfg(test)]
    fn engine_fixture_with_speed(speed: u64) -> Engine { Engine { speed } }
    #[test]
    fn accelerates_from_idle() { assert_eq!(engine_fixture_with_speed(0).speed, 0); }
    #[test] fn same_line() { assert_eq!(1, 1); }
    pub fn prod(input: usize) -> usize { input.saturating_mul(2).saturating_add(1) }
}
`;
    const chunks = await chunker.chunk(code, "src/engine.rs", "rust");

    const production = chunks.filter((chunk) => !isTestChunk(chunk)).map((chunk) => chunk.content);
    expect(production.filter((content) => content.includes("#[test]"))).toEqual([]);
    expect(production.filter((content) => content.includes("#[cfg(test)]"))).toEqual([]);
    expect(byId(chunks, "inner.accelerates_from_idle")?.content).toContain("#[test]\n");
    expect(byId(chunks, "inner.engine_fixture_with_speed")?.content).toContain("#[cfg(test)]\n");
    // A same-line attribute rides its item's row once, never twice.
    expect(byId(chunks, "inner.same_line")?.content.match(/#\[test\]/g)).toHaveLength(1);
  });

  it("joins two enclosing modules with the engine's scope separator", async () => {
    const chunks = await chunker.chunk(ENGINE_RS, "src/engine.rs", "rust");

    expect(byId(chunks, "outer::deep.Probe")?.metadata.chunkType).toBe("test_setup");
    expect(byId(chunks, "outer::deep.deep_test_runs_fine")?.metadata.chunkType).toBe("test");
  });
});

describe("Rust test files by path", () => {
  it("classifies tests.rs — the body of `#[cfg(test)] mod tests;` — as a test file", () => {
    expect(classify("src/foo/tests.rs").isTest).toBe(true);
  });
});

describe("TreeSitterChunker — a short Rust inline test node never becomes production code (52wk3.9)", () => {
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    const config: ChunkerConfig = { chunkSize: 500, chunkOverlap: 50, maxChunkSize: 1000 };
    chunker = new TreeSitterChunker(config, new DefaultSymbolIdComposer(), new LanguageFactory());
  });

  const PRODUCTION = `pub fn production_value(input: usize) -> usize {
    input.saturating_mul(2).saturating_add(1)
}

pub fn other_production_value(input: usize) -> usize {
    input.saturating_mul(3).saturating_add(2)
}
`;

  const productionHolding = (chunks: { content: string; metadata: { chunkType?: string } }[], text: string): string[] =>
    chunks.filter((chunk) => !isTestChunk(chunk) && chunk.content.includes(text)).map((c) => c.content);

  it("chunks a short top-level #[cfg(test)] fixture fn as one test setup chunk", async () => {
    const code = `#[cfg(test)]\nfn fixture() -> usize { 7 }\n\n${PRODUCTION}`;
    const chunks = await chunker.chunk(code, "src/lib.rs", "rust");

    const holders = chunks.filter((chunk) => chunk.content.includes("fn fixture"));
    expect(holders.map((c) => [c.metadata.chunkType, c.metadata.symbolId, c.startLine, c.endLine])).toEqual([
      ["test_setup", "lib.fixture", 1, 2],
    ]);
    expect(productionHolding(chunks, "fn fixture")).toEqual([]);
    expect(productionHolding(chunks, "#[cfg(test)]")).toEqual([]);
  });

  it("chunks a short top-level #[cfg(test)] const as one test setup chunk", async () => {
    const code = `#[cfg(test)]\nconst LIMIT: usize = 3;\n\n${PRODUCTION}`;
    const chunks = await chunker.chunk(code, "src/lib.rs", "rust");

    const holders = chunks.filter((chunk) => chunk.content.includes("const LIMIT"));
    expect(holders.map((c) => [c.metadata.chunkType, c.metadata.symbolId, c.startLine, c.endLine])).toEqual([
      ["test_setup", "lib.LIMIT", 1, 2],
    ]);
    expect(productionHolding(chunks, "const LIMIT")).toEqual([]);
    expect(productionHolding(chunks, "#[cfg(test)]")).toEqual([]);
  });

  it("chunks a short top-level #[test] fn as one test chunk", async () => {
    const code = `#[test]\nfn t() {}\n\n${PRODUCTION}`;
    const chunks = await chunker.chunk(code, "src/lib.rs", "rust");

    const holders = chunks.filter((chunk) => chunk.content.includes("fn t()"));
    expect(holders.map((c) => [c.metadata.chunkType, c.metadata.symbolId, c.startLine, c.endLine])).toEqual([
      ["test", "lib.t", 1, 2],
    ]);
    expect(productionHolding(chunks, "#[test]")).toEqual([]);
  });

  it("chunks a short #[cfg(test)] module with no test as one test setup chunk under its module id", async () => {
    const code = `#[cfg(test)]\nmod tests { const X: u8 = 1; }\n\n${PRODUCTION}`;
    const chunks = await chunker.chunk(code, "src/lib.rs", "rust");

    const holders = chunks.filter((chunk) => chunk.content.includes("const X"));
    expect(holders.map((c) => [c.metadata.chunkType, c.metadata.symbolId])).toEqual([["test_setup", "lib.tests"]]);
    expect(productionHolding(chunks, "const X")).toEqual([]);
    expect(productionHolding(chunks, "mod tests")).toEqual([]);
  });

  it("keeps a short production fn and const exactly as before", async () => {
    const code = `fn seven() -> usize { 7 }\n\nconst LIMIT: usize = 3;\n\n${PRODUCTION}`;
    const chunks = await chunker.chunk(code, "src/lib.rs", "rust");

    expect(
      chunks.map((c) => ({
        chunkType: c.metadata.chunkType,
        symbolId: c.metadata.symbolId,
        startLine: c.startLine,
        endLine: c.endLine,
      })),
    ).toEqual(SHORT_PRODUCTION_BASELINE);
  });
});

describe("TreeSitterChunker — a test-only declaration inside a non-test module (52wk3.9)", () => {
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    const config: ChunkerConfig = { chunkSize: 500, chunkOverlap: 50, maxChunkSize: 1000 };
    chunker = new TreeSitterChunker(config, new DefaultSymbolIdComposer(), new LanguageFactory());
  });

  const TEST_ONLY_DECLARATIONS = `pub mod inner {
    #[cfg(test)]
    const LIMIT: usize = 3;
    #[cfg(test)]
    static COUNTER: u8 = 0;
    #[cfg(test)]
    type Alias = u8;
    #[cfg(test)]
    union Bits { a: u8, b: i8 }
    pub fn prod(input: usize) -> usize { input.saturating_mul(2).saturating_add(1) }
}
`;

  const productionHolding = (chunks: { content: string; metadata: { chunkType?: string } }[], text: string): string[] =>
    chunks.filter((chunk) => !isTestChunk(chunk) && chunk.content.includes(text)).map((c) => c.content);

  it("chunks each short test-only const, static, type and union as test setup under the module path", async () => {
    const chunks = await chunker.chunk(TEST_ONLY_DECLARATIONS, "src/lib.rs", "rust");

    // The engine composes a non-method leaf under its module with the Rust
    // namespace separator (symbolid-convention: `Outer::Inner`); a claimed
    // test CONTAINER keeps the kernel's `<module>.<name>` form.
    for (const [marker, id] of [
      ["const LIMIT", "inner::LIMIT"],
      ["static COUNTER", "inner::COUNTER"],
      ["type Alias", "inner::Alias"],
      ["union Bits", "inner::Bits"],
    ] as const) {
      const holders = chunks.filter((chunk) => chunk.content.includes(marker));
      expect(holders.map((c) => [c.metadata.chunkType, c.metadata.symbolId])).toEqual([["test_setup", id]]);
      expect(productionHolding(chunks, marker)).toEqual([]);
    }
    expect(productionHolding(chunks, "#[cfg(test)]")).toEqual([]);
    expect(chunks.find((c) => c.metadata.symbolId === "inner.prod")?.metadata.chunkType).toBe("function");
  });

  it("keeps a module of production declarations exactly as before", async () => {
    const code = TEST_ONLY_DECLARATIONS.replace(/ {4}#\[cfg\(test\)\]\n/g, "");
    const chunks = await chunker.chunk(code, "src/lib.rs", "rust");

    expect(
      chunks.map((c) => ({
        chunkType: c.metadata.chunkType,
        symbolId: c.metadata.symbolId,
        startLine: c.startLine,
        endLine: c.endLine,
        content: c.content,
      })),
    ).toEqual(PRODUCTION_MODULE_BASELINE);
  });
});

/** Output of the production-declarations module before the child-candidate change, recorded on its base commit. */
const PRODUCTION_MODULE_BASELINE = [
  {
    chunkType: "function",
    symbolId: "inner.prod",
    startLine: 6,
    endLine: 6,
    content: "pub mod inner {\npub fn prod(input: usize) -> usize { input.saturating_mul(2).saturating_add(1) }",
  },
  {
    chunkType: "block",
    symbolId: "inner",
    startLine: 1,
    endLine: 7,
    content:
      "pub mod inner {\n    const LIMIT: usize = 3;\n    static COUNTER: u8 = 0;\n    type Alias = u8;\n    union Bits { a: u8, b: i8 }\n}",
  },
];

/** Output of the short-production fixture before bd tea-rags-mcp-52wk3.9, recorded on the base commit. */
const SHORT_PRODUCTION_BASELINE = [
  { chunkType: "function", symbolId: "production_value", startLine: 1, endLine: 7 },
  { chunkType: "function", symbolId: "other_production_value", startLine: 9, endLine: 11 },
];
