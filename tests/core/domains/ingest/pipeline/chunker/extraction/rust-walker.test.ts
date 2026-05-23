import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import { extractFromRustFile } from "../../../../../../../src/core/domains/ingest/pipeline/chunker/extraction/rust-walker.js";

function parse(src: string) {
  const p = new Parser();
  p.setLanguage(RustLang as unknown as Parser.Language);
  return p.parse(src);
}

describe("extractFromRustFile — imports", () => {
  it("captures `use foo::bar;`", () => {
    const src = "use foo::bar;\nfn main() {}\n";
    const r = extractFromRustFile({ tree: parse(src), code: src, relPath: "main.rs", language: "rust", chunks: [] });
    expect(r.imports.map((i) => i.importText)).toEqual(["foo::bar"]);
  });

  it("captures `use crate::foo;`", () => {
    const src = "use crate::foo;\nfn main() {}\n";
    const r = extractFromRustFile({ tree: parse(src), code: src, relPath: "main.rs", language: "rust", chunks: [] });
    expect(r.imports.map((i) => i.importText)).toEqual(["crate::foo"]);
  });

  it("captures `use super::foo::Bar;`", () => {
    const src = "use super::foo::Bar;\nfn main() {}\n";
    const r = extractFromRustFile({ tree: parse(src), code: src, relPath: "x.rs", language: "rust", chunks: [] });
    expect(r.imports.map((i) => i.importText)).toEqual(["super::foo::Bar"]);
  });

  it("captures grouped `use foo::{bar, baz};`", () => {
    const src = "use foo::{bar, baz};\nfn main() {}\n";
    const r = extractFromRustFile({ tree: parse(src), code: src, relPath: "x.rs", language: "rust", chunks: [] });
    // tree-sitter-rust preserves the brace-list form
    expect(r.imports[0].importText).toContain("foo");
    expect(r.imports[0].importText).toContain("bar");
  });
});

describe("extractFromRustFile — calls", () => {
  it("captures scoped call `foo::bar()`", () => {
    const src = "fn main() { foo::bar(); }\n";
    const r = extractFromRustFile({
      tree: parse(src),
      code: src,
      relPath: "main.rs",
      language: "rust",
      chunks: [{ symbolId: "main", scope: [], startLine: 1, endLine: 1 }],
    });
    const c = r.chunks[0].calls[0];
    expect(c.receiver).toBe("foo");
    expect(c.member).toBe("bar");
  });

  it("captures method call `obj.method()`", () => {
    const src = "fn main() { let x = obj; x.method(); }\n";
    const r = extractFromRustFile({
      tree: parse(src),
      code: src,
      relPath: "main.rs",
      language: "rust",
      chunks: [{ symbolId: "main", scope: [], startLine: 1, endLine: 1 }],
    });
    const c = r.chunks[0].calls[0];
    expect(c.receiver).toBe("x");
    expect(c.member).toBe("method");
  });

  it("captures bare function calls", () => {
    const src = "fn main() { go(); }\n";
    const r = extractFromRustFile({
      tree: parse(src),
      code: src,
      relPath: "main.rs",
      language: "rust",
      chunks: [{ symbolId: "main", scope: [], startLine: 1, endLine: 1 }],
    });
    const c = r.chunks[0].calls[0];
    expect(c.receiver).toBeNull();
    expect(c.member).toBe("go");
  });
});

describe("extractFromRustFile — edge cases", () => {
  it("empty file returns empty extraction", () => {
    const r = extractFromRustFile({ tree: parse(""), code: "", relPath: "x.rs", language: "rust", chunks: [] });
    expect(r.imports).toEqual([]);
  });

  it("ignores comments", () => {
    const src = "// use fake::foo;\nuse real::foo;\nfn main() {}\n";
    const r = extractFromRustFile({ tree: parse(src), code: src, relPath: "x.rs", language: "rust", chunks: [] });
    expect(r.imports.map((i) => i.importText)).toEqual(["real::foo"]);
  });
});

// Exercises both `collectRustCalls` branches plus the scoped_identifier
// path/name pairing — distinct from the simpler scoped/field tests above
// because we co-locate multiple call shapes inside one chunk to verify
// the per-node dispatch picks the right receiver/member for each.
describe("extractFromRustFile — call dispatch branches", () => {
  it("handles scoped_identifier, field_expression, and identifier calls in the same body", () => {
    const src = [
      "fn main() {",
      "  foo::bar::baz();", // scoped_identifier with multi-segment path
      "  self.method();", //   field_expression with value=self
      "  go();", //            plain identifier
      "}",
      "",
    ].join("\n");
    const r = extractFromRustFile({
      tree: parse(src),
      code: src,
      relPath: "main.rs",
      language: "rust",
      chunks: [{ symbolId: "main", scope: [], startLine: 1, endLine: 5 }],
    });
    const byMember = new Map(r.chunks[0].calls.map((c) => [c.member, c]));
    // scoped_identifier path: receiver is the full path text, member is `name`.
    expect(byMember.get("baz")?.receiver).toBe("foo::bar");
    // field_expression path: receiver is value text, member is field text.
    expect(byMember.get("method")?.receiver).toBe("self");
    // identifier path: receiver is null, member is the function name.
    expect(byMember.get("go")?.receiver).toBeNull();
  });

  it("handles method-chain field_expression where value is itself a call", () => {
    // The `value` of the outer field_expression is the nested call_expression
    // text — covers the value.text branch when the receiver is not a simple
    // identifier.
    const src = "fn main() { build().run(); }\n";
    const r = extractFromRustFile({
      tree: parse(src),
      code: src,
      relPath: "main.rs",
      language: "rust",
      chunks: [{ symbolId: "main", scope: [], startLine: 1, endLine: 1 }],
    });
    const run = r.chunks[0].calls.find((c) => c.member === "run");
    expect(run?.receiver).toBe("build()");
  });
});

// bd tea-rags-mcp-jyzb — macro_rules! definitions and macro_invocation
// call sites. macro_invocation appears for `println!()`, `assert!()`,
// and user-defined `my_macro!()` — receiver is null, member is the
// macro name. macro_rules! definitions emit no calls but ARE captured
// as symbols by the provider (see provider.test.ts).
describe("extractFromRustFile — macros", () => {
  it("captures `my_macro!()` invocations as bare calls", () => {
    const src = "fn main() {\n  my_macro!();\n}\n";
    const r = extractFromRustFile({
      tree: parse(src),
      code: src,
      relPath: "main.rs",
      language: "rust",
      chunks: [{ symbolId: "main", scope: [], startLine: 1, endLine: 3 }],
    });
    const macro = r.chunks[0].calls.find((c) => c.member === "my_macro");
    expect(macro).toBeDefined();
    expect(macro?.receiver).toBeNull();
  });

  it("captures `println!()` macro invocations", () => {
    const src = 'fn main() {\n  println!("hi");\n}\n';
    const r = extractFromRustFile({
      tree: parse(src),
      code: src,
      relPath: "main.rs",
      language: "rust",
      chunks: [{ symbolId: "main", scope: [], startLine: 1, endLine: 3 }],
    });
    const macro = r.chunks[0].calls.find((c) => c.member === "println");
    expect(macro).toBeDefined();
    expect(macro?.receiver).toBeNull();
  });

  it("captures scoped macro invocations `std::println!()` with receiver=path, member=name", () => {
    // scoped_identifier branch (rust-walker.ts lines 82-87): the macro
    // name is the `name` child, the namespace path lives on the `path`
    // child. Receiver renders as the full path text.
    const src = 'fn main() {\n  std::println!("hi");\n}\n';
    const r = extractFromRustFile({
      tree: parse(src),
      code: src,
      relPath: "main.rs",
      language: "rust",
      chunks: [{ symbolId: "main", scope: [], startLine: 1, endLine: 3 }],
    });
    const macro = r.chunks[0].calls.find((c) => c.member === "println");
    expect(macro).toBeDefined();
    expect(macro?.receiver).toBe("std");
  });

  it("captures multi-segment scoped macro invocations `foo::bar::baz!()`", () => {
    const src = "fn main() {\n  foo::bar::baz!();\n}\n";
    const r = extractFromRustFile({
      tree: parse(src),
      code: src,
      relPath: "main.rs",
      language: "rust",
      chunks: [{ symbolId: "main", scope: [], startLine: 1, endLine: 3 }],
    });
    const macro = r.chunks[0].calls.find((c) => c.member === "baz");
    expect(macro).toBeDefined();
    expect(macro?.receiver).toBe("foo::bar");
  });
});
