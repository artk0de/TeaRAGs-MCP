/**
 * Rust type-abstractness census (bd tea-rags-mcp-r8hme.8). A trait is abstract;
 * a struct, enum or union is concrete. An `impl` block implements a type
 * declared elsewhere and counts as neither.
 */
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import { typeAbstractnessOf } from "../../__helpers__/type-abstractness.js";
import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";

const censusOf = (src: string) => typeAbstractnessOf(new RustLanguage(), RustLang, src, "src/a.rs", "rust");

describe("Rust walker — type-abstractness census", () => {
  it("reads traits as abstract and structs, enums and unions as concrete", () => {
    const src = [
      "pub trait Store { fn get(&self) -> i32; }",
      "pub struct Engine;",
      "enum Kind { A }",
      "union Bits { a: u8 }",
      "impl Store for Engine { fn get(&self) -> i32 { 1 } }",
      "",
    ].join("\n");

    expect(censusOf(src)).toEqual({ abstractTypeCount: 1, concreteTypeCount: 3 });
  });
});
