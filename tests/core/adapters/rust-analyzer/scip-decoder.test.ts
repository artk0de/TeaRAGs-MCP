import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createRustAnalyzerScipIndex,
  decodeRustAnalyzerScip,
  scipSymbolPackage,
} from "../../../../src/core/adapters/rust-analyzer/index.js";

// tests/fixtures/rust-analyzer-scip/mini/index.scip was produced ONCE by
// `rust-analyzer scip <mini> --config-path <no-exec> --exclude-vendored-libraries`
// (rust-analyzer 2026-10-18) and is committed next to the crate it indexes.
const FIXTURE = join(import.meta.dirname, "../../../fixtures/rust-analyzer-scip/mini/index.scip");

function miniIndex() {
  return createRustAnalyzerScipIndex(decodeRustAnalyzerScip(readFileSync(FIXTURE)), "mini-identity");
}

describe("decodeRustAnalyzerScip + createRustAnalyzerScipIndex", () => {
  it("answers an in-project method call with its definition (1-based line)", () => {
    // src/main.rs:7 `    counter.bump(2);` — `bump` starts at UTF-16 column 12.
    const def = miniIndex().definitionAt("src/main.rs", 7, 12);
    expect(def).toMatchObject({ inProject: true, relPath: "src/shape.rs", line: 6, package: "mini" });
    expect(def?.symbol).toContain("impl#[Counter]bump().");
  });

  it("answers an in-project type reference with the struct definition", () => {
    // src/main.rs:6 `    let mut counter = Counter { total: 0 };`
    expect(miniIndex().definitionAt("src/main.rs", 6, 22)).toMatchObject({
      inProject: true,
      relPath: "src/shape.rs",
      line: 1,
    });
  });

  it("answers a std call with the std-family package and no project location", () => {
    // src/main.rs:9 `    v.push(1);`
    const def = miniIndex().definitionAt("src/main.rs", 9, 6);
    expect(def?.inProject).toBe(false);
    // `Vec::push` is defined in `alloc`; rust-analyzer names the defining crate, not the `std` re-export.
    expect(def?.package).toBe("alloc");
    expect(def?.relPath).toBeUndefined();
    expect(def?.symbol).toContain("push().");
  });

  it("resolves a local binding inside its own document", () => {
    // src/main.rs:7 `counter` at column 4 → `let mut counter` on line 6.
    expect(miniIndex().definitionAt("src/main.rs", 7, 4)).toMatchObject({
      inProject: true,
      relPath: "src/main.rs",
      line: 6,
      package: "",
    });
  });

  it("returns null where no reference occurrence starts", () => {
    const index = miniIndex();
    expect(index.definitionAt("src/main.rs", 7, 13)).toBeNull();
    expect(index.definitionAt("src/main.rs", 1, 0)).toBeNull();
    expect(index.definitionAt("src/missing.rs", 7, 12)).toBeNull();
  });

  it("keeps the identity it was built with", () => {
    expect(miniIndex().identity).toBe("mini-identity");
  });

  it("round-trips through JSON (the cache form)", () => {
    const data = decodeRustAnalyzerScip(readFileSync(FIXTURE));
    const revived = createRustAnalyzerScipIndex(JSON.parse(JSON.stringify(data)), "x");
    expect(revived.definitionAt("src/main.rs", 7, 12)).toEqual(miniIndex().definitionAt("src/main.rs", 7, 12));
  });

  it("rejects bytes that are not a SCIP index", () => {
    expect(() => decodeRustAnalyzerScip(Uint8Array.from([0x0f]))).toThrow();
  });
});

describe("scipSymbolPackage", () => {
  it("reads the package field of a global symbol", () => {
    expect(scipSymbolPackage("rust-analyzer cargo std 1.88.0 vec/Vec#push().")).toBe("std");
    expect(scipSymbolPackage("rust-analyzer cargo regex-syntax 0.8.5 ast/Ast#")).toBe("regex-syntax");
  });

  it("is empty for a local or malformed symbol", () => {
    expect(scipSymbolPackage("local 3")).toBe("");
    expect(scipSymbolPackage("garbage")).toBe("");
  });
});
