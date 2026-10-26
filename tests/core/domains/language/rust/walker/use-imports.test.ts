/**
 * bd tea-rags-mcp-s3i8m letCall S4a — the walker carries every `use` statement's
 * importText on `FileExtraction.rustUseImports`, the same set `ctx.imports`
 * exposes, absent when the file has none.
 */
import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import { materializeTree } from "../../../../../../src/core/adapters/tree-sitter/materialize.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";

function walk(code: string) {
  const language = new RustLanguage();
  const parser = new Parser();
  parser.setLanguage(RustLang);
  const tree = { rootNode: materializeTree(parser.parse(code).rootNode, code) };
  const chunks = collectSymbols(tree, language.walker.nameOf, "::", false, new DefaultSymbolIdComposer());
  return language.walker.walk({ tree, code, relPath: "src/lib.rs", language: "rust", chunks });
}

describe("Rust walker — per-file use imports (s3i8m letCall S4a)", () => {
  it("records the importText of every use statement, matching the imports list", () => {
    const out = walk("use std::fmt;\nuse crate::a::{b, c};\nfn f() {}\n");
    expect(out.rustUseImports?.length).toBeGreaterThan(0);
    expect(out.rustUseImports).toEqual(out.imports?.map((i) => i.importText));
  });

  it("leaves the field absent for a file without use statements", () => {
    const out = walk("fn f() {}\n");
    expect(out.rustUseImports).toBeUndefined();
  });
});
