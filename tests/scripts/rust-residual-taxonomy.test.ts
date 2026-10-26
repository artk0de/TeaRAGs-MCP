import type Parser from "tree-sitter";
import { beforeAll, describe, expect, it } from "vitest";

import {
  buildRustResidualTaxonomyReport,
  classifyRustResidualSite,
  createRustResidualParser,
  memberOverlapsStd,
  RUST_RESIDUAL_CATEGORIES,
  type RustResidualCategory,
  type RustResidualClassifiedSite,
  type RustResidualSite,
} from "../../scripts/lib/rust-residual-taxonomy.js";

/**
 * bd tea-rags-mcp-s3i8m.1 — every `missWithInProjectDef` Rust call site sorted
 * by mechanism. One fixture per category; the call is located the way the
 * walker records it: 1-based line, 0-based column of the call EXPRESSION start.
 */
describe("rust residual taxonomy", () => {
  let parser: Parser;

  beforeAll(async () => {
    parser = await createRustResidualParser();
  });

  function siteAt(source: string, callStart: string, member: string, receiver: string | null): RustResidualSite {
    const offset = source.indexOf(callStart);
    if (offset < 0) throw new Error(`missing fixture text: ${callStart}`);
    const before = source.slice(0, offset).split("\n");
    return {
      relPath: "src/lib.rs",
      startLine: before.length,
      startColumn: before[before.length - 1].length,
      receiver,
      member,
    };
  }

  function categoryOf(
    source: string,
    callStart: string,
    member: string,
    receiver: string | null,
  ): RustResidualCategory {
    const tree = parser.parse(source);
    return classifyRustResidualSite(tree.rootNode, siteAt(source, callStart, member, receiver)).category;
  }

  describe("bare calls", () => {
    it("a closure bound by let is a local callable", () => {
      const src = "fn f() {\n    let run = |x: u8| x;\n    run(1);\n}\n";
      expect(categoryOf(src, "run(1)", "run", null)).toBe("bare.localCallable");
    });

    it("a callable fn parameter is a local callable", () => {
      const src = "fn f(cb: fn(u8)) {\n    cb(1);\n}\n";
      expect(categoryOf(src, "cb(1)", "cb", null)).toBe("bare.localCallable");
    });

    it("a name a `use` declaration brings in is use-imported", () => {
      const src = "use crate::util::helper as h;\nfn f() {\n    h();\n}\n";
      expect(categoryOf(src, "h()", "h", null)).toBe("bare.useImported");
    });

    it("a macro invocation is macro-adjacent", () => {
      const src = "fn f() {\n    my_macro!(1);\n}\n";
      expect(categoryOf(src, "my_macro!(1)", "my_macro", null)).toBe("bare.macro");
    });

    it("a bare name with no local or use binding is other", () => {
      const src = "fn f() {\n    helper();\n}\n";
      expect(categoryOf(src, "helper()", "helper", null)).toBe("bare.other");
    });
  });

  describe("qualified paths", () => {
    it("Self:: / super:: / crate:: / module paths", () => {
      const src = "fn f() {\n    Self::build();\n    crate::a::run();\n    util::go();\n}\n";
      expect(categoryOf(src, "Self::build()", "build", "Self")).toBe("path.selfModule");
      expect(categoryOf(src, "crate::a::run()", "run", "crate::a")).toBe("path.selfModule");
      expect(categoryOf(src, "util::go()", "go", "util")).toBe("path.selfModule");
    });

    it("UFCS and a generic parameter's associated fn", () => {
      const src = "fn f<T: Make>() {\n    <T as Make>::make();\n    T::other();\n}\n";
      expect(categoryOf(src, "<T as Make>::make()", "make", "<T as Make>")).toBe("path.genericOrTrait");
      expect(categoryOf(src, "T::other()", "other", "T")).toBe("path.genericOrTrait");
    });

    it("an enum variant or tuple-struct constructor", () => {
      const src = "fn f() {\n    Shape::Circle(1);\n}\n";
      expect(categoryOf(src, "Shape::Circle(1)", "Circle", "Shape")).toBe("path.variantCtor");
    });

    it("a concrete type's associated fn", () => {
      const src = "fn f() {\n    Config::load();\n}\n";
      expect(categoryOf(src, "Config::load()", "load", "Config")).toBe("path.concreteType");
    });
  });

  describe("method receivers rooted at an identifier", () => {
    it("a param typed by a generic T, impl Trait or dyn Trait", () => {
      const src = "fn f<T: Go>(a: T, b: &dyn Go, c: impl Go) {\n    a.go();\n    b.go();\n    c.go();\n}\n";
      expect(categoryOf(src, "a.go()", "go", "a")).toBe("binding.paramGenericOrTrait");
      expect(categoryOf(src, "b.go()", "go", "b")).toBe("binding.paramGenericOrTrait");
      expect(categoryOf(src, "c.go()", "go", "c")).toBe("binding.paramGenericOrTrait");
    });

    it("an impl-level generic types a method's param", () => {
      const src = "impl<K: Go> Holder<K> {\n    fn f(&self, k: K) {\n        k.go();\n    }\n}\n";
      expect(categoryOf(src, "k.go()", "go", "k")).toBe("binding.paramGenericOrTrait");
    });

    it("a param with a concrete type", () => {
      const src = "fn f(a: &mut Engine) {\n    a.go();\n}\n";
      expect(categoryOf(src, "a.go()", "go", "a")).toBe("binding.paramConcrete");
    });

    it("a let with a type annotation", () => {
      const src = "fn f() {\n    let mut a: Engine = make();\n    a.go();\n}\n";
      expect(categoryOf(src, "a.go()", "go", "a")).toBe("binding.letAnnotated");
    });

    it("a let bound from a constructor or struct literal", () => {
      const src = "fn f() {\n    let a = Engine::new();\n    a.go();\n    let b = Engine { x: 1 };\n    b.go();\n}\n";
      expect(categoryOf(src, "a.go()", "go", "a")).toBe("binding.letCtor");
      expect(categoryOf(src, "b.go()", "go", "b")).toBe("binding.letCtor");
    });

    it("a let bound from a method or free-fn call result", () => {
      const src = "fn f(x: X) {\n    let a = x.engine()?;\n    a.go();\n    let b = make_engine();\n    b.go();\n}\n";
      expect(categoryOf(src, "a.go()", "go", "a")).toBe("binding.letCallResult");
      expect(categoryOf(src, "b.go()", "go", "b")).toBe("binding.letCallResult");
    });

    it("a let bound from a macro", () => {
      const src = "fn f() {\n    let a = make!(1);\n    a.go();\n}\n";
      expect(categoryOf(src, "a.go()", "go", "a")).toBe("binding.letMacro");
    });

    it("pattern bindings: if-let, while-let, match arm, for, closure param, destructure", () => {
      const src = [
        "fn f(o: Option<E>, v: Vec<E>, m: M) {",
        "    if let Some(a) = o { a.go(); }",
        "    while let Some(b) = it.next() { b.go(); }",
        "    match m { M::One(c) => c.go(), _ => {} }",
        "    for d in v { d.go(); }",
        "    let k = |e: E| e.go();",
        "    let (g, h) = pair;",
        "    g.go();",
        "}",
        "",
      ].join("\n");
      for (const name of ["a", "b", "c", "d", "e", "g"]) {
        expect(categoryOf(src, `${name}.go()`, "go", name)).toBe("binding.pattern");
      }
    });

    it("an outer binding mentioned only in a match-arm body is not a match-arm pattern", () => {
      const src =
        "fn f(m: M) {\n    let w = make();\n    match m {\n        M::One(c) => w.go(),\n        _ => {}\n    }\n}\n";
      expect(categoryOf(src, "w.go()", "go", "w")).toBe("binding.letCallResult");
    });

    it("an identifier with no local binding is a static / const / global", () => {
      const src = "fn f() {\n    REGISTRY.go();\n}\n";
      expect(categoryOf(src, "REGISTRY.go()", "go", "REGISTRY")).toBe("binding.notLocal");
    });

    it("the nearest binding wins over a shadowed outer one", () => {
      const src = "fn f(a: &dyn Go) {\n    let a = Engine::new();\n    a.go();\n}\n";
      expect(categoryOf(src, "a.go()", "go", "a")).toBe("binding.letCtor");
    });
  });

  describe("compound receivers", () => {
    it("self, self.field chains, local field chains and call chains", () => {
      const src =
        "impl S {\n    fn f(&self, x: X) {\n        self.go();\n        self.a.b.go();\n        x.inner.go();\n        x.make().go();\n    }\n}\n";
      expect(categoryOf(src, "self.go()", "go", "self")).toBe("method.self");
      expect(categoryOf(src, "self.a.b.go()", "go", "self.a.b")).toBe("method.selfField");
      expect(categoryOf(src, "x.inner.go()", "go", "x.inner")).toBe("method.localFieldChain");
      expect(categoryOf(src, "x.make().go()", "go", "x.make()")).toBe("method.callChain");
    });

    it("index, wrapped (deref / paren / ref / try) and macro-result receivers", () => {
      const src = "fn f(v: V) {\n    v[0].go();\n    (*v).go();\n    v?.go();\n    vec![1].go();\n}\n";
      expect(categoryOf(src, "v[0].go()", "go", "v[0]")).toBe("method.indexed");
      expect(categoryOf(src, "(*v).go()", "go", "(*v)")).toBe("method.wrapped");
      expect(categoryOf(src, "v?.go()", "go", "v?")).toBe("method.wrapped");
      expect(categoryOf(src, "vec![1].go()", "go", "vec![1]")).toBe("method.macroResult");
    });

    it("a path value receiver is a static / const", () => {
      const src = "fn f() {\n    config::GLOBAL.go();\n}\n";
      expect(categoryOf(src, "config::GLOBAL.go()", "go", "config::GLOBAL")).toBe("method.pathValue");
    });
  });

  it("a site whose call node is not at the recorded position is unknown with a reason", () => {
    const tree = parser.parse("fn f() {}\n");
    const result = classifyRustResidualSite(tree.rootNode, {
      relPath: "src/lib.rs",
      startLine: 1,
      startColumn: 3,
      receiver: "a",
      member: "go",
    });
    expect(result.category).toBe("unknown");
    expect(result.reason).toBe("callNotLocated");
  });

  it("maps each spec-named mechanism to its bead, and leaves the rest visibly unmapped", () => {
    const beadsOf = (category: RustResidualCategory) => RUST_RESIDUAL_CATEGORIES[category].beads;
    expect(beadsOf("bare.localCallable")).toEqual(["tea-rags-mcp-2g2og.25"]);
    expect(beadsOf("bare.useImported")).toEqual(["tea-rags-mcp-sjego", "tea-rags-mcp-2g2og.16"]);
    expect(beadsOf("bare.macro")).toEqual(["tea-rags-mcp-2g2og.21"]);
    expect(beadsOf("path.selfModule")).toEqual(["tea-rags-mcp-2g2og.20"]);
    expect(beadsOf("path.genericOrTrait")).toEqual(["tea-rags-mcp-2g2og.17"]);
    expect(beadsOf("path.variantCtor")).toEqual(["tea-rags-mcp-2g2og.22"]);
    expect(beadsOf("binding.paramGenericOrTrait")).toEqual(["tea-rags-mcp-f6di2", "tea-rags-mcp-n1q1n"]);
    expect(beadsOf("binding.letCallResult")).toEqual(["tea-rags-mcp-2g2og.24"]);
    expect(beadsOf("binding.pattern")).toEqual(["tea-rags-mcp-2g2og.18"]);
    expect(beadsOf("binding.notLocal")).toEqual(["tea-rags-mcp-2g2og.22"]);
    expect(beadsOf("method.selfField")).toEqual(["tea-rags-mcp-2g2og.24"]);
    expect(beadsOf("method.callChain")).toEqual(["tea-rags-mcp-2g2og.24"]);
    expect(beadsOf("method.indexed")).toEqual(["tea-rags-mcp-2g2og.19"]);
    expect(beadsOf("method.wrapped")).toEqual(["tea-rags-mcp-2g2og.18", "tea-rags-mcp-2g2og.19"]);
    // A category no mechanism bead covers yet says so instead of borrowing an id.
    expect(beadsOf("binding.paramConcrete")).toEqual([]);
    expect(beadsOf("unknown")).toEqual([]);
  });

  describe("std overlap axis", () => {
    it("flags members std/core/alloc types or traits declare", () => {
      for (const member of ["push", "iter", "unwrap", "clone", "insert", "as_ref", "to_string", "lock", "borrow_mut"]) {
        expect(memberOverlapsStd(member), member).toBe(true);
      }
    });

    it("leaves project-specific names alone", () => {
      for (const member of ["resolve_symbol", "render_frame", "go"]) {
        expect(memberOverlapsStd(member), member).toBe(false);
      }
    });
  });

  describe("report", () => {
    it("counts categories, shares, std overlap and samples deterministically by stride", () => {
      const classified = Array.from(
        { length: 30 },
        (_, i): RustResidualClassifiedSite => ({
          site: {
            relPath: `src/f${String(i).padStart(2, "0")}.rs`,
            startLine: i + 1,
            startColumn: 0,
            receiver: "a",
            member: i % 2 === 0 ? "push" : "go",
          },
          category: i < 20 ? "binding.notLocal" : "method.self",
          sourceLine: `line ${i}`,
        }),
      );
      const report = buildRustResidualTaxonomyReport("demo", classified, 5);
      expect(report.total).toBe(30);
      const notLocal = report.categories.find((c) => c.category === "binding.notLocal");
      expect(notLocal).toMatchObject({
        count: 20,
        stdOverlap: 10,
        beads: RUST_RESIDUAL_CATEGORIES["binding.notLocal"].beads,
      });
      expect(notLocal?.share).toBeCloseTo(20 / 30);
      expect(notLocal?.samples.map((s) => s.relPath)).toEqual([
        "src/f00.rs",
        "src/f04.rs",
        "src/f08.rs",
        "src/f12.rs",
        "src/f16.rs",
      ]);
      expect(report.categories[0].category).toBe("binding.notLocal");
    });
  });
});
