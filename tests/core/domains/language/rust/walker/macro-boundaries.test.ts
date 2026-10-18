import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { materializeTree } from "../../../../../../src/core/domains/ingest/pipeline/chunker/materialize.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";

function extract(src: string): FileExtraction {
  const language = new RustLanguage();
  const parser = new Parser();
  parser.setLanguage(RustLang);
  const rootNode = materializeTree(parser.parse(src).rootNode, src);
  const tree = { rootNode };
  const chunks = collectSymbols(
    tree,
    (node) => language.walker.nameOf(node),
    language.kernel.scopeSeparator ?? ".",
    language.kernel.disambiguateOverloads ?? false,
    new DefaultSymbolIdComposer(),
  );
  return language.walker.walk({ tree, code: src, relPath: "src/macros.rs", language: "rust", chunks });
}

describe("Rust macro boundaries", () => {
  it("keeps macro definitions as one stable symbol boundary without promoting body tokens", () => {
    const extraction = extract(
      ["macro_rules! emit_value {", '    ($value:expr) => { println!("value: {}", $value); };', "}"].join("\n"),
    );

    expect(extraction.chunks.map(({ symbolId }) => symbolId)).toEqual(["emit_value"]);
    expect(extraction.chunks[0]).toMatchObject({ symbolId: "emit_value", startLine: 1, endLine: 3 });
    expect(extraction.chunks[0].calls).toEqual([]);
  });

  it("captures invocation syntax but does not synthesize expansion symbols or calls from its body", () => {
    const extraction = extract(
      [
        "macro_rules! emit_value {",
        '    ($value:expr) => { println!("value: {}", $value); };',
        "}",
        "fn run() {",
        "    emit_value!(42);",
        "}",
      ].join("\n"),
    );

    expect(extraction.chunks.map(({ symbolId }) => symbolId)).toEqual(["emit_value", "run"]);
    expect(extraction.chunks.find(({ symbolId }) => symbolId === "emit_value")?.calls).toEqual([]);
    expect(extraction.chunks.find(({ symbolId }) => symbolId === "run")?.calls).toEqual([
      { callText: "emit_value!(42)", receiver: null, member: "emit_value", startLine: 5, startColumn: 4 },
    ]);
  });
});
