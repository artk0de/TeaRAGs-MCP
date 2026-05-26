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

// bd tea-rags-mcp-q1pl — local binding emission. The Rust resolver's
// `resolveByLocalType` branch (`localBindings[receiver]`) was dead in
// production because the walker never produced `localBindings`. These
// tests pin the three walker-only sources: typed `let`, associated-fn
// constructors (`Foo::new()`), and parameter type annotations.
describe("extractFromRustFile — localBindings", () => {
  it("records typed `let x: Foo` → { x: 'Foo' }", () => {
    const src = ["fn run() {", "  let x: Engine = make();", "}", ""].join("\n");
    const r = extractFromRustFile({
      tree: parse(src),
      code: src,
      relPath: "main.rs",
      language: "rust",
      chunks: [{ symbolId: "run", scope: [], startLine: 1, endLine: 3 }],
    });
    expect(r.chunks[0].localBindings).toEqual({ x: "Engine" });
  });

  it("strips reference from typed `let x: &mut Bar` → { x: 'Bar' }", () => {
    const src = ["fn run() {", "  let x: &mut Bar = make();", "}", ""].join("\n");
    const r = extractFromRustFile({
      tree: parse(src),
      code: src,
      relPath: "main.rs",
      language: "rust",
      chunks: [{ symbolId: "run", scope: [], startLine: 1, endLine: 3 }],
    });
    expect(r.chunks[0].localBindings).toEqual({ x: "Bar" });
  });

  it("unwraps generic in typed `let v: Vec<Thing>` → { v: 'Vec' }", () => {
    const src = ["fn run() {", "  let v: Vec<Thing> = make();", "}", ""].join("\n");
    const r = extractFromRustFile({
      tree: parse(src),
      code: src,
      relPath: "main.rs",
      language: "rust",
      chunks: [{ symbolId: "run", scope: [], startLine: 1, endLine: 3 }],
    });
    expect(r.chunks[0].localBindings).toEqual({ v: "Vec" });
  });

  it("records associated-fn constructor `let y = Worker::new()` → { y: 'Worker' }", () => {
    const src = ["fn run() {", "  let y = Worker::new();", "}", ""].join("\n");
    const r = extractFromRustFile({
      tree: parse(src),
      code: src,
      relPath: "main.rs",
      language: "rust",
      chunks: [{ symbolId: "run", scope: [], startLine: 1, endLine: 3 }],
    });
    expect(r.chunks[0].localBindings).toEqual({ y: "Worker" });
  });

  it("records `Foo::from(...)` and `Foo::default()` associated-fn constructors", () => {
    const src = ["fn run() {", "  let z = Helper::from(3);", "  let w = Other::default();", "}", ""].join("\n");
    const r = extractFromRustFile({
      tree: parse(src),
      code: src,
      relPath: "main.rs",
      language: "rust",
      chunks: [{ symbolId: "run", scope: [], startLine: 1, endLine: 4 }],
    });
    expect(r.chunks[0].localBindings).toEqual({ z: "Helper", w: "Other" });
  });

  it("skips non-constructor assoc fn `let q = Worker::query()` (not a ctor name)", () => {
    const src = ["fn run() {", "  let q = Worker::query();", "}", ""].join("\n");
    const r = extractFromRustFile({
      tree: parse(src),
      code: src,
      relPath: "main.rs",
      language: "rust",
      chunks: [{ symbolId: "run", scope: [], startLine: 1, endLine: 3 }],
    });
    expect(r.chunks[0].localBindings).toBeUndefined();
  });

  it("skips non-CapWords assoc-fn receiver `let m = mymod::new()`", () => {
    const src = ["fn run() {", "  let m = mymod::new();", "}", ""].join("\n");
    const r = extractFromRustFile({
      tree: parse(src),
      code: src,
      relPath: "main.rs",
      language: "rust",
      chunks: [{ symbolId: "run", scope: [], startLine: 1, endLine: 3 }],
    });
    expect(r.chunks[0].localBindings).toBeUndefined();
  });

  it("skips untyped `let x = build()` (return type unknown)", () => {
    const src = ["fn run() {", "  let x = build();", "}", ""].join("\n");
    const r = extractFromRustFile({
      tree: parse(src),
      code: src,
      relPath: "main.rs",
      language: "rust",
      chunks: [{ symbolId: "run", scope: [], startLine: 1, endLine: 3 }],
    });
    expect(r.chunks[0].localBindings).toBeUndefined();
  });

  it("records parameter type annotations `fn bar(&self, p: Foo, q: &mut Bar, v: Vec<T>)`", () => {
    const src = ["fn bar(&self, p: Foo, q: &mut Bar, v: Vec<Thing>) {", "  p.go();", "}", ""].join("\n");
    const r = extractFromRustFile({
      tree: parse(src),
      code: src,
      relPath: "main.rs",
      language: "rust",
      chunks: [{ symbolId: "Worker#bar", scope: ["Worker"], startLine: 1, endLine: 3 }],
    });
    expect(r.chunks[0].localBindings).toEqual({ p: "Foo", q: "Bar", v: "Vec" });
  });

  it("attributes bindings to the innermost function chunk only", () => {
    const src = [
      "fn outer() {", //         1
      "  let a: Alpha = m();", // 2
      "}", //                    3
      "fn inner() {", //         4
      "  let b: Beta = m();", // 5
      "}", //                    6
      "",
    ].join("\n");
    const r = extractFromRustFile({
      tree: parse(src),
      code: src,
      relPath: "main.rs",
      language: "rust",
      chunks: [
        { symbolId: "outer", scope: [], startLine: 1, endLine: 3 },
        { symbolId: "inner", scope: [], startLine: 4, endLine: 6 },
      ],
    });
    expect(r.chunks[0].localBindings).toEqual({ a: "Alpha" });
    expect(r.chunks[1].localBindings).toEqual({ b: "Beta" });
  });
});

// bd tea-rags-mcp-q1pl — struct field-type emission for the
// `self.field.method()` resolver path. Keyed by struct name (= the impl
// type name in `callerScope`), field name → declared type.
describe("extractFromRustFile — classFieldTypes", () => {
  it("records `struct S { f: Bar }` → { S: { f: 'Bar' } }", () => {
    const src = ["struct S {", "  f: Bar,", "}", ""].join("\n");
    const r = extractFromRustFile({
      tree: parse(src),
      code: src,
      relPath: "main.rs",
      language: "rust",
      chunks: [],
    });
    expect(r.classFieldTypes).toEqual({ S: { f: "Bar" } });
  });

  it("records multiple fields and strips reference/generic types", () => {
    const src = ["struct Worker {", "  engine: Engine,", "  items: Vec<Thing>,", "  parent: &Owner,", "}", ""].join(
      "\n",
    );
    const r = extractFromRustFile({
      tree: parse(src),
      code: src,
      relPath: "main.rs",
      language: "rust",
      chunks: [],
    });
    expect(r.classFieldTypes).toEqual({ Worker: { engine: "Engine", items: "Vec", parent: "Owner" } });
  });

  it("leaves classFieldTypes undefined for a struct with no fields", () => {
    const src = "struct Empty {}\n";
    const r = extractFromRustFile({
      tree: parse(src),
      code: src,
      relPath: "main.rs",
      language: "rust",
      chunks: [],
    });
    expect(r.classFieldTypes).toBeUndefined();
  });

  it("reduces a scoped field type `f: std::vec::Vec` to its bare last segment 'Vec'", () => {
    const src = ["struct S {", "  f: std::vec::Vec,", "}", ""].join("\n");
    const r = extractFromRustFile({
      tree: parse(src),
      code: src,
      relPath: "main.rs",
      language: "rust",
      chunks: [],
    });
    expect(r.classFieldTypes).toEqual({ S: { f: "Vec" } });
  });

  it("skips fields with no single named base type (tuple type)", () => {
    // `(A, B)` is a `tuple_type` — no single class name to attribute, so the
    // field is dropped and the struct contributes nothing.
    const src = ["struct S {", "  pair: (A, B),", "}", ""].join("\n");
    const r = extractFromRustFile({
      tree: parse(src),
      code: src,
      relPath: "main.rs",
      language: "rust",
      chunks: [],
    });
    expect(r.classFieldTypes).toBeUndefined();
  });
});
