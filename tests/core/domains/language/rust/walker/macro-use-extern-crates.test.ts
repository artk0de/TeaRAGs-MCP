/**
 * bd tea-rags-mcp-s3i8m.4 (B2) — the walker records every
 * `#[macro_use] extern crate <name> [as alias];` of a file in SOURCE ORDER on
 * `FileExtraction.rustMacroUseCrates`: the crate name, the alias when renamed,
 * the macro names a `#[macro_use(a, b)]` list restricts it to, and the line.
 * An `extern crate` without the attribute, `extern crate self` and a nested
 * declaration (Rust admits macro-loading `extern crate` at the crate root only)
 * record nothing.
 */
import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import { materializeTree } from "../../../../../../src/core/adapters/tree-sitter/materialize.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";

function macroUseCratesOf(code: string) {
  const language = new RustLanguage();
  const parser = new Parser();
  parser.setLanguage(RustLang);
  const tree = { rootNode: materializeTree(parser.parse(code).rootNode, code) };
  const chunks = collectSymbols(tree, language.walker.nameOf, "::", false, new DefaultSymbolIdComposer());
  return language.walker.walk({ tree, code, relPath: "src/lib.rs", language: "rust", chunks }).rustMacroUseCrates;
}

describe("Rust walker — #[macro_use] extern crate (s3i8m.4 B2)", () => {
  it("records each macro_use crate in source order with its line", () => {
    const code = [
      "#[macro_use]",
      "extern crate tikv_util;",
      "extern crate libc;",
      "#[macro_use]",
      '#[cfg(feature = "slog")]',
      "extern crate slog;",
      "",
    ].join("\n");
    expect(macroUseCratesOf(code)).toEqual([
      { crateName: "tikv_util", line: 2 },
      { crateName: "slog", line: 6 },
    ]);
  });

  it("keeps the alias of a renamed crate and the macro list of a restricted import", () => {
    const code = ["#[macro_use(warn, info)]", "extern crate slog_global as sg;", ""].join("\n");
    expect(macroUseCratesOf(code)).toEqual([
      { crateName: "slog_global", alias: "sg", macros: ["warn", "info"], line: 2 },
    ]);
  });

  it("records nothing for a file without macro_use crates, for `extern crate self` and nested declarations", () => {
    const code = [
      "extern crate libc;",
      "#[macro_use]",
      "extern crate self as me;",
      "mod inner {",
      "    #[macro_use]",
      "    extern crate nested;",
      "}",
      "#[macro_use]",
      "mod macros;",
      "",
    ].join("\n");
    expect(macroUseCratesOf(code)).toBeUndefined();
  });
});
