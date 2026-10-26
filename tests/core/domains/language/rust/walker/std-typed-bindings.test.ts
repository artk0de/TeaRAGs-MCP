import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";

function bindingsOf(src: string) {
  const p = new Parser();
  p.setLanguage(RustLang);
  const extraction = new RustLanguage().walker.walk({
    tree: p.parse(src),
    code: src,
    relPath: "svc.rs",
    language: "rust",
    chunks: [{ symbolId: "f", startLine: 1, endLine: src.split("\n").length, scope: [] }],
  });
  return extraction.chunks[0]?.localBindings ?? {};
}

// bd tea-rags-mcp-s3i8m.3 — a primitive / str / slice annotation is a known
// type: the receiver is std's, and the resolver must see that to classify it.
describe("Rust walker — primitive and slice bindings", () => {
  it("binds params and typed lets annotated with primitives, str and slices", () => {
    const src = [
      "fn f(lib: &str, key: &[u8], n: usize, flag: bool) {",
      "    let buf: [u8; 4] = [0; 4];",
      "    let s: &mut str = x;",
      "}",
    ].join("\n");
    const bindings = bindingsOf(src);
    expect(bindings.lib?.[0]?.type).toBe("str");
    expect(bindings.key?.[0]?.type).toBe("[u8]");
    expect(bindings.n?.[0]?.type).toBe("usize");
    expect(bindings.flag?.[0]?.type).toBe("bool");
    expect(bindings.buf?.[0]?.type).toBe("[u8]");
    expect(bindings.s?.[0]?.type).toBe("str");
  });
});
