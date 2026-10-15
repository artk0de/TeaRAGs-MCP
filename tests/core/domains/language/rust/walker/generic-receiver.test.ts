import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import { extractFromRustFile } from "../../../../../../src/core/domains/language/rust/walker/walker.js";

function parse(src: string) {
  const parser = new Parser();
  parser.setLanguage(RustLang);
  return parser.parse(src);
}

describe("Rust walker — generic and turbofish receiver facts (2g2og.6)", () => {
  it("records a borrowed generic parameter's single trait bound as an upper-bound receiver type", () => {
    const src = ["fn run<T: Worker>(value: &T) {", "  value.run();", "}", ""].join("\n");
    const extraction = extractFromRustFile({
      tree: parse(src),
      code: src,
      relPath: "src/main.rs",
      language: "rust",
      chunks: [{ symbolId: "run", scope: [], startLine: 1, endLine: 3 }],
    });
    expect(extraction.chunks[0].localBindings).toEqual({
      value: [{ line: 1, type: "T", typeRef: { form: "instance", name: "Worker", upperBound: true } }],
    });
  });

  it("records a turbofish constructor binding as the constructed instance type", () => {
    const src = ["fn run() {", "  let parser = Parser::<Token>::new();", "  parser.parse();", "}", ""].join("\n");
    const extraction = extractFromRustFile({
      tree: parse(src),
      code: src,
      relPath: "src/main.rs",
      language: "rust",
      chunks: [{ symbolId: "run", scope: [], startLine: 1, endLine: 4 }],
    });
    expect(extraction.chunks[0].localBindings).toEqual({ parser: [{ line: 2, type: "Parser" }] });
  });
});
