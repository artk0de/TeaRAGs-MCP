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

import type { CallRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import { extractFromPythonFile } from "../../../../../../src/core/domains/language/python/walker/walker.js";
import { classifyReceiverKind } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/receiver-kind.js";

function parse(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(PyLang as unknown as Parser.Language);
  return parser.parse(src);
}

function extract(src: string, relPath = "x.py") {
  return extractFromPythonFile({ tree: parse(src), code: src, relPath, language: "python", chunks: [] });
}

/** Every call in `src`, via a single chunk spanning the whole file. */
function callsIn(src: string): readonly CallRef[] {
  const out = extractFromPythonFile({
    tree: parse(src),
    code: src,
    relPath: "x.py",
    language: "python",
    chunks: [{ symbolId: "whole", startLine: 1, endLine: 10_000, scope: [] }],
  });
  return out.chunks[0]?.calls ?? [];
}

/** The recorded receiver text of the call whose member is `member`. */
function receiverOf(src: string, member: string): string | null | undefined {
  return callsIn(src).find((c) => c.member === member)?.receiver;
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

/**
 * Star-imported bases (bd tea-rags-mcp-4yh64).
 *
 * netbox's `netbox/netbox/models/__init__.py` takes ELEVEN bases from
 * `from netbox.models.features import *`, so every base of `NetBoxFeatureSet`
 * was left bare and the MRO of every model below it stopped one hop in.
 * `from` with a star binds no local name, so the binding table cannot say where
 * the name came from — the file's star modules are the only candidates, and the
 * walker is the one place that knows them for the DEFINING file.
 */
describe("extractFromPythonFile — a bare base under a star import", () => {
  it("offers the star-imported module as an alternative, bare spelling first", () => {
    expect(basesOf("from m.features import *\nclass C(Base):\n    pass\n")).toEqual(["Base|m.features::Base"]);
  });

  it("offers EVERY star import as an alternative, in declaration order", () => {
    expect(basesOf("from a import *\nfrom .b import *\nclass C(Base):\n    pass\n")).toEqual(["Base|a::Base|.b::Base"]);
  });

  it("offers the alternatives for every bare base of a multi-base class", () => {
    expect(basesOf("from a import *\nclass C(X, Y):\n    pass\n")).toEqual(["X|a::X", "Y|a::Y"]);
  });

  it("leaves an import-BOUND base alone even when the file also star-imports", () => {
    expect(basesOf("from a import *\nfrom c.d import Base\nclass C(Base):\n    pass\n")).toEqual(["c.d::Base"]);
  });

  it("leaves a DOTTED base alone — a star import binds names, not module paths", () => {
    expect(basesOf("from a import *\nclass C(mod.Base):\n    pass\n")).toEqual(["mod.Base"]);
  });

  it("leaves a bare base bare when the file star-imports nothing", () => {
    expect(basesOf("from a import b\nclass C(Base):\n    pass\n")).toEqual(["Base"]);
  });

  it("records one alternative per module when the same module is starred twice", () => {
    expect(basesOf("from a import *\nfrom a import *\nclass C(Base):\n    pass\n")).toEqual(["Base|a::Base"]);
  });
});

/**
 * `super()` receiver normalization (bd tea-rags-mcp-ntnke, seam 4 Task 4).
 *
 * `classifyReceiverKind`'s `SUPER_MARKERS` holds `"super"` and `"<super>"`. The
 * walker used to record the verbatim node text `"super()"`, which matches
 * neither, so EVERY `super()` call site was filed under `dynamic` — 1,446 rows
 * on netbox, 1,242 on polar. Normalizing in the walker rather than widening the
 * classifier keeps a shared, language-neutral instrument free of one language's
 * spelling.
 *
 * The explicit two-argument `super(Cls, self)` is deliberately NOT normalized:
 * its first argument names the class the walk starts after, which is not always
 * the enclosing class.
 */
describe("extractFromPythonFile — super() receiver normalization", () => {
  const kindOf = (call: CallRef) => classifyReceiverKind(call, undefined);

  it("records a zero-argument `super()` receiver as the bare text `super`", () => {
    expect(receiverOf("class C(B):\n    def __init__(self):\n        super().__init__()\n", "__init__")).toBe("super");
  });

  it("classifies the normalized receiver as `super`, not `dynamic`", () => {
    const call = callsIn("class C(B):\n    def m(self):\n        super().run()\n").find((c) => c.member === "run");
    expect(call).toBeDefined();
    expect(kindOf(call as CallRef)).toBe("super");
  });

  it("tolerates whitespace between `super` and its empty argument list", () => {
    // Matching on the node SHAPE rather than the text is what makes this work;
    // a `/^super\(\)$/` text probe would miss it.
    expect(receiverOf("class C(B):\n    def m(self):\n        super ().run()\n", "run")).toBe("super");
  });

  it("keeps the two-argument `super(Foo, self)` verbatim, and it stays `dynamic`", () => {
    const src = "class C(B):\n    def m(self):\n        super(Foo, self).run()\n";
    const call = callsIn(src).find((c) => c.member === "run");
    expect(call?.receiver).toBe("super(Foo, self)");
    expect(kindOf(call as CallRef)).toBe("dynamic");
  });

  it("leaves a call on a variable whose name merely STARTS with `super` untouched", () => {
    expect(receiverOf("supervisor.run()\n", "run")).toBe("supervisor");
  });

  it("leaves a call on the result of a non-`super` call untouched", () => {
    expect(receiverOf("make_thing().run()\n", "run")).toBe("make_thing()");
  });

  it("leaves an argument-carrying same-named call untouched when it is not `super`", () => {
    expect(receiverOf("supper().run()\n", "run")).toBe("supper()");
  });

  it("does not touch the inner bare `super()` call itself", () => {
    // `super()` is its own call node with a null receiver — a bareCall, and the
    // normalization only ever rewrites a RECEIVER position.
    const call = callsIn("class C(B):\n    def m(self):\n        super().run()\n").find((c) => c.member === "super");
    expect(call?.receiver).toBeNull();
  });
});
