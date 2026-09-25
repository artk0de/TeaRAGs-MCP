/**
 * Rust declared visibility (bd tea-rags-mcp-jwjyr.1). Any `pub` form — `pub`,
 * `pub(crate)`, `pub(super)`, `pub(in path)` — → public; no `pub` → private
 * (module-private: the declaring module and its descendants). Two positions take
 * no `pub` yet are as visible as their trait: a method inside a `trait` and a
 * method of an `impl Trait for Type`. Recording those as private would drop
 * every legal call through the trait, so they are public.
 */
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import { declaredVisibilityOf } from "../../__helpers__/declared-visibility.js";
import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";

const visibilityOf = (src: string) => declaredVisibilityOf(new RustLanguage(), RustLang, src, "src/a.rs", "rust");

describe("Rust walker — declared visibility", () => {
  it("maps every pub form to public and a bare item to private", () => {
    const src = [
      "pub struct S;",
      "struct Hidden;",
      "pub fn open() {}",
      "fn closed() {}",
      "impl S {",
      "    pub(crate) fn crate_wide(&self) {}",
      "    fn own(&self) {}",
      "}",
      "",
    ].join("\n");
    expect(visibilityOf(src)).toEqual({
      S: "public",
      Hidden: "private",
      open: "public",
      closed: "private",
      "S#crate_wide": "public",
      "S#own": "private",
    });
  });

  it("treats trait methods and trait-impl methods as public", () => {
    const src = [
      "pub trait T {",
      "    fn required(&self);",
      "    fn provided(&self) {}",
      "}",
      "impl T for S {",
      "    fn required(&self) {}",
      "}",
      "",
    ].join("\n");
    const vis = visibilityOf(src);
    expect(vis.T).toBe("public");
    expect(vis["T#provided"]).toBe("public");
    expect(vis["S#required"]).toBe("public");
    expect(Object.values(vis)).not.toContain("private");
  });
});
