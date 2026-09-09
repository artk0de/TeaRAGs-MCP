/**
 * Python walker `classAncestors` channel (bd tea-rags-mcp-y4hro, seam 4 Task 2).
 *
 * Three things this channel does that `classExtends` does not, each one a
 * measured miss family on netbox / polar: EVERY base rather than the first, a
 * `subscript` base (`RepositoryBase[Account]` — a node type the old filter
 * skipped entirely, so those classes recorded NO base at all), and a
 * FILE-QUALIFIED key so two `Base` classes in two files do not conflate in the
 * run-global map.
 *
 * The base VALUES carry the DEFINING file's import binding, which is what makes
 * a linearization caller-independent and therefore memoizable once per run.
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

function extract(src: string, relPath = "x.py") {
  return extractFromPythonFile({ tree: parse(src), code: src, relPath, language: "python", chunks: [] });
}

function ancestorsOf(src: string, relPath = "x.py"): Record<string, readonly string[]> {
  return extract(src, relPath).classAncestors ?? {};
}

function basesOf(src: string, key = "x.py::C"): readonly string[] {
  return ancestorsOf(src)[key] ?? [];
}

describe("collectPythonImports — the binding shapes qualification reads", () => {
  // `importedBindings[local] === importText` is the discriminator: an `import`
  // statement binds a MODULE PATH (and the value equals the module text), a
  // `from` statement binds an EXPORTED NAME (and it does not).
  const firstImport = (src: string) => extract(src).imports[0];

  it("binds a module path for every `import` form, so the value === importText", () => {
    for (const [src, local] of [
      ["import a\n", "a"],
      ["import a.b\n", "a"],
      ["import a.b as c\n", "c"],
    ] as const) {
      const imp = firstImport(src);
      expect(imp.importedBindings?.[local], src).toBe(imp.importText);
    }
  });

  it("binds an exported name for every `from` form, so the value !== importText", () => {
    for (const [src, local, exported] of [
      ["from a.b import C\n", "C", "C"],
      ["from a.b import C as D\n", "D", "C"],
      ["from . import x\n", "x", "x"],
      ["from .mod import Y\n", "Y", "Y"],
    ] as const) {
      const imp = firstImport(src);
      expect(imp.importedBindings?.[local], src).toBe(exported);
      expect(imp.importedBindings?.[local], src).not.toBe(imp.importText);
    }
  });

  it("`import a.b` binds only the FIRST segment, to the whole path", () => {
    const imp = firstImport("import a.b\n");
    expect(imp.importedNames).toEqual(["a"]);
    expect(imp.importedBindings).toEqual({ a: "a.b" });
  });
});

describe("extractFromPythonFile — classAncestors emission", () => {
  it("records EVERY base in declaration order, not just the first", () => {
    expect(basesOf("class C(A, M):\n    pass\n")).toEqual(["A", "M"]);
  });

  it("accepts a subscript base by taking its value child (polar's repositories)", () => {
    expect(basesOf("class C(Base[T], Mixin[T, U]):\n    pass\n")).toEqual(["Base", "Mixin"]);
  });

  it("keys by relPath and the dotted class FQ", () => {
    expect(ancestorsOf("class C(A):\n    pass\n", "pkg/mod.py")).toEqual({ "pkg/mod.py::C": ["A"] });
  });

  it("keys a nested class by its dotted FQ", () => {
    const src = "class Outer:\n    class Inner(Base):\n        pass\n";
    expect(ancestorsOf(src)).toEqual({ "x.py::Outer.Inner": ["Base"] });
  });

  it("emits no entry for a class with no bases or an `object`-only base", () => {
    expect(ancestorsOf("class C:\n    pass\n")).toEqual({});
    expect(ancestorsOf("class C(object):\n    pass\n")).toEqual({});
  });

  it("skips a metaclass keyword argument", () => {
    expect(basesOf("class C(Base, metaclass=Meta):\n    pass\n")).toEqual(["Base"]);
  });

  it("leaves classAncestors undefined when the file declares no hierarchy", () => {
    expect(extract("def f():\n    pass\n").classAncestors).toBeUndefined();
  });

  it("leaves the single-base classExtends channel exactly as it was", () => {
    expect(extract("class C(A, M):\n    pass\n").classExtends).toEqual({ C: "A" });
  });
});

describe("extractFromPythonFile — base spellings carry the DEFINING file's import binding", () => {
  it("qualifies a `from a.b import Base` base with its module", () => {
    expect(basesOf("from a.b import Base\nclass C(Base):\n    pass\n")).toEqual(["a.b::Base"]);
  });

  it("keeps the leading dots of a relative import", () => {
    expect(basesOf("from .base import Base\nclass C(Base):\n    pass\n")).toEqual([".base::Base"]);
  });

  it("follows an alias back to the EXPORTED name", () => {
    expect(basesOf("from a.b import C as D\nclass C(D):\n    pass\n")).toEqual(["a.b::C"]);
  });

  it("resolves a dotted base through an aliased module import", () => {
    expect(basesOf("import django.db as db\nclass C(db.Model):\n    pass\n")).toEqual(["django.db::Model"]);
  });

  it("resolves a dotted base through a from-imported submodule", () => {
    expect(basesOf("from django import db\nclass C(db.Model):\n    pass\n")).toEqual(["django.db::Model"]);
  });

  it("does not double the module when an unaliased `import a.b` binds only `a`", () => {
    expect(basesOf("import a.b\nclass C(a.b.Model):\n    pass\n")).toEqual(["a.b::Model"]);
  });

  it("does not double a single-segment module either (`import db` + `db.Model`)", () => {
    // The plan's draft snippet emitted `db.db::Model` here: a module-path
    // binding has to be recognised even when the path carries no dot.
    expect(basesOf("import db\nclass C(db.Model):\n    pass\n")).toEqual(["db::Model"]);
  });

  it("joins a package-relative `from . import x` without doubling the dot", () => {
    expect(basesOf("from . import x\nclass C(x.Y):\n    pass\n")).toEqual([".x::Y"]);
  });

  it("leaves a base with no import binding bare — same file, or a builtin", () => {
    expect(basesOf("class C(Base):\n    pass\n")).toEqual(["Base"]);
  });

  it("strips the subscript before qualifying", () => {
    expect(basesOf("from a.b import Base\nclass C(Base[T]):\n    pass\n")).toEqual(["a.b::Base"]);
  });
});
