/**
 * Python walker inheritanceEdges tests (CHA cone-unification Slice 2) —
 * mirrors tests/core/domains/language/ruby/walker-inheritance-edges.test.ts.
 *
 * Python has no include/extend/prepend distinction (the C3 MRO is linearized
 * at runtime), so EVERY base class is emitted as kind `super`. Multiple
 * inheritance (`class C(A, B)`) emits one edge per base with declaration-order
 * `ordinal`. The legacy single-base `classExtends` forward path stays intact.
 */

import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import { extractFromPythonFile } from "../../../../../../src/core/domains/language/python/walker/walker.js";

function parse(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(PyLang as unknown as Parser.Language);
  return parser.parse(src);
}

function edges(src: string): string[] {
  const out = extractFromPythonFile({ tree: parse(src), code: src, relPath: "x.py", language: "python", chunks: [] });
  return (out.inheritanceEdges ?? []).map((e) => `${e.source}:${e.ancestor}:${e.kind}`);
}

describe("Python walker inheritanceEdges (Slice 2)", () => {
  it("captures a single base as kind super", () => {
    expect(edges("class Dog(Animal):\n    pass\n")).toEqual(["Dog:Animal:super"]);
  });

  it("captures multiple bases as kind super in declaration order", () => {
    expect(edges("class C(A, M):\n    pass\n")).toEqual(["C:A:super", "C:M:super"]);
  });

  it("ordinal reflects declaration order across all bases", () => {
    const src = "class C(A, B, D):\n    pass\n";
    const out = extractFromPythonFile({ tree: parse(src), code: src, relPath: "x.py", language: "python", chunks: [] });
    const sorted = (out.inheritanceEdges ?? []).slice().sort((a, b) => a.ordinal - b.ordinal);
    expect(sorted.map((e) => `${e.ancestor}:${e.ordinal}`)).toEqual(["A:0", "B:1", "D:2"]);
  });

  it("emits nothing for a class with no bases", () => {
    expect(edges("class Plain:\n    pass\n")).toEqual([]);
  });

  it("treats an explicit object base the same as any other base", () => {
    // `object` is external/builtin; the Ruby walker emits external ancestors
    // verbatim and lets resolution drop them — Python mirrors that.
    expect(edges("class Thing(object):\n    pass\n")).toEqual(["Thing:object:super"]);
  });

  it("captures a qualified (nested / module) base name verbatim", () => {
    expect(edges("class User(db.Model):\n    pass\n")).toEqual(["User:db.Model:super"]);
  });

  it("qualifies the source by enclosing class scope with the `.` separator", () => {
    const src = "class Outer:\n    class Inner(Base):\n        pass\n";
    expect(edges(src)).toEqual(["Outer.Inner:Base:super"]);
  });

  it("captures a nested-class base name verbatim", () => {
    expect(edges("class Widget(Outer.Mixin):\n    pass\n")).toEqual(["Widget:Outer.Mixin:super"]);
  });

  it("still populates the legacy classExtends Record (phased forward path — not removed)", () => {
    // The resolver (python-super / python-local-binding) walks the single-base
    // classExtends chain — it MUST keep working alongside inheritanceEdges.
    const src = "class C(A, M):\n    pass\n";
    const out = extractFromPythonFile({ tree: parse(src), code: src, relPath: "x.py", language: "python", chunks: [] });
    expect(out.classExtends?.["C"]).toEqual("A");
  });
});

/**
 * Generic bases (bd tea-rags-mcp-wz956). polar declares every repository base
 * as a `subscript` node — `class AccountRepository(RepositoryBase[Account])` —
 * and the identifier/attribute/dotted_name filter skipped that node type
 * entirely, so such a file emitted NO `inheritanceEdges` at all. An ABSENT
 * `inheritanceEdges` is the migration signal `inheritance-edges.ts` reads: it
 * falls back to lifting the legacy Records, and the Python `classAncestors`
 * keys are `<relPath>::<fq>` with `::`-qualified values, so every lifted row is
 * junk `include` noise (bd tea-rags-mcp-m1sf0). Unwrapping the subscript is
 * what keeps such a file on the unified path.
 */
describe("Python walker inheritanceEdges — subscript (generic) bases", () => {
  it("unwraps a generic base to its value child", () => {
    expect(edges("class C(Base[Event]):\n    pass\n")).toEqual(["C:Base:super"]);
  });

  it("unwraps a qualified generic base", () => {
    expect(edges("class C(mod.Base[Event]):\n    pass\n")).toEqual(["C:mod.Base:super"]);
  });

  it("keeps declaration-order ordinals across mixed plain and generic bases", () => {
    const src = "class C(Mixin[A], Plain, Base[A, B]):\n    pass\n";
    const out = extractFromPythonFile({ tree: parse(src), code: src, relPath: "x.py", language: "python", chunks: [] });
    const sorted = (out.inheritanceEdges ?? []).slice().sort((a, b) => a.ordinal - b.ordinal);
    expect(sorted.map((e) => `${e.ancestor}:${e.ordinal}`)).toEqual(["Mixin:0", "Plain:1", "Base:2"]);
  });

  it("emits inheritanceEdges for a file whose classes have ONLY generic bases", () => {
    // PRESENCE of the field is what suppresses the legacy classAncestors lift.
    const src = "class AccountRepository(RepositoryBase[Account], Mixin[Account]):\n    pass\n";
    const out = extractFromPythonFile({ tree: parse(src), code: src, relPath: "r.py", language: "python", chunks: [] });
    expect(out.inheritanceEdges).toBeDefined();
    expect(out.classAncestors).toBeDefined();
  });
});
