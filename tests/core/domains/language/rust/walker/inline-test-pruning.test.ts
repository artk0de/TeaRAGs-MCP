/**
 * Inline tests stay out of the codegraph (plan 2026-11-02 Task 5): nothing the
 * Rust walker extracts — call, import, binding, declaration, chunk — may
 * originate inside a test-only subtree, while production extraction in the
 * same file stays exactly what it was.
 */
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import { walkedExtractionOf, type WalkedTreeForm } from "../../__helpers__/walked-extraction.js";
import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";

const extract = (src: string, form: WalkedTreeForm) =>
  walkedExtractionOf(new RustLanguage(), RustLang, { src, relPath: "src/lib.rs", languageId: "rust", form });

const MIXED = [
  "use crate::util::helper;",
  "",
  "pub fn add(a: i32, b: i32) -> i32 {",
  "    helper(a) + b",
  "}",
  "",
  "#[cfg(test)]",
  "mod tests {",
  "    use super::*;",
  "    struct Fixture { probe: Probe }",
  "    impl Drop for Fixture { fn drop(&mut self) {} }",
  "    #[test]",
  "    fn t() {",
  "        let fixture = Fixture::new();",
  "        add(1, 2);",
  "    }",
  "}",
  "",
  "#[test]",
  "fn standalone() {",
  "    add(3, 4);",
  "}",
  "",
].join("\n");

describe.each<WalkedTreeForm>(["native", "materialized"])("Rust walker prunes inline tests (%s tree)", (form) => {
  it("emits no chunk, call, import, binding or declaration from inside a test-only subtree", () => {
    const serialized = JSON.stringify(extract(MIXED, form));
    for (const fromTests of ["tests", "standalone", "super::*", "add(1, 2)", "add(3, 4)", "Fixture", "Probe", "Drop"]) {
      expect(serialized).not.toContain(fromTests);
    }
  });

  it("keeps the production import and call of the same file", () => {
    const extraction = extract(MIXED, form);
    expect(extraction.imports.map((entry) => entry.importText)).toEqual(["crate::util::helper"]);
    expect(extraction.chunks.map((chunk) => chunk.symbolId)).toEqual(["add"]);
    expect(extraction.chunks[0].calls.map((call) => call.callText)).toEqual(["helper(a)"]);
  });

  it("extracts nothing from a file whose root is `#![cfg(test)]`", () => {
    const src = ["#![cfg(test)]", "use super::*;", "fn helper_for_tests() { other(); }", ""].join("\n");
    const extraction = extract(src, form);
    expect(extraction.imports).toEqual([]);
    expect(extraction.chunks).toEqual([]);
  });
});
