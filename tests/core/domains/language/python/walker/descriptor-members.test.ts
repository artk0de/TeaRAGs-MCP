/**
 * P3 descriptors, walker half (bd tea-rags-mcp-m99j1.1.20, Task 18).
 *
 * A def decorated with a DESCRIPTOR decorator is an attribute holding its
 * return, so the walker records that return as the class FIELD it reads as —
 * the same `classFieldTypes` / `classFieldTypesByClassKey` channels a
 * `self.x = Foo()` assignment writes. Which decorators qualify is the
 * vocabulary's: `property` and `functools.cached_property` are the language's,
 * a framework contributes its own spelling only where the project declares it.
 * A decorator is matched by the QUALIFIED name the file's imports give it, so a
 * project's own `cached_property` is not Django's.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { PythonLanguage } from "../../../../../../src/core/domains/language/python/index.js";

function walk(relPath: string, lines: readonly string[], declaredDependencies?: ReadonlySet<string>): FileExtraction {
  const src = lines.join("\n");
  const parser = new Parser();
  parser.setLanguage(PyLang);
  return new PythonLanguage().walker.walk({
    tree: parser.parse(src),
    code: src,
    relPath,
    language: "python",
    chunks: [],
    ...(declaredDependencies === undefined ? {} : { declaredDependencies }),
  });
}

const EXPR = "app/expressions.py";

describe("Python descriptor members — a descriptor def is the field it reads as", () => {
  it("`@property` / `@functools.cached_property` with a return annotation → field of that type", () => {
    const ext = walk(EXPR, [
      "import functools",
      "from app.fields import Field",
      "",
      "class Expr:",
      "    @property",
      "    def prop_field(self) -> Field:",
      "        return self._f",
      "",
      "    @functools.cached_property",
      "    def output_field(self) -> Field:",
      "        return self._f",
    ]);
    expect(ext.classFieldTypes?.Expr).toEqual({ prop_field: "Field", output_field: "Field" });
    expect(ext.classFieldTypesByClassKey?.[`${EXPR}::Expr`]).toEqual({ prop_field: "Field", output_field: "Field" });
  });

  it("`from functools import cached_property` + an unannotated `return Field()` → the inferred class", () => {
    const ext = walk(EXPR, [
      "from functools import cached_property",
      "from app.fields import Field",
      "",
      "class Expr:",
      "    @cached_property",
      "    def output_field(self):",
      "        return Field()",
    ]);
    expect(ext.classFieldTypes?.Expr).toEqual({ output_field: "Field" });
  });

  it("a plain method, and a decorator outside the vocabulary, record no field", () => {
    const ext = walk(EXPR, [
      "from app.fields import Field",
      "from app.cache import cached_property",
      "",
      "class Expr:",
      "    def method_field(self) -> Field:",
      "        return Field()",
      "",
      "    @cached_property",
      "    def homegrown(self) -> Field:",
      "        return Field()",
    ]);
    expect(ext.classFieldTypes?.Expr).toBeUndefined();
  });

  it("Django's `cached_property` counts only where the project declares Django", () => {
    const lines = [
      "from django.utils.functional import cached_property",
      "from app.fields import Field",
      "",
      "class Expr:",
      "    @cached_property",
      "    def output_field(self) -> Field:",
      "        return Field()",
    ];
    expect(walk(EXPR, lines, new Set(["django"])).classFieldTypes?.Expr).toEqual({ output_field: "Field" });
    expect(walk(EXPR, lines, new Set(["requests"])).classFieldTypes?.Expr).toBeUndefined();
  });

  it("Werkzeug's `cached_property` counts where the project declares Werkzeug", () => {
    const lines = [
      "from werkzeug.utils import cached_property",
      "from app.fields import Field",
      "",
      "class Expr:",
      "    @cached_property",
      "    def output_field(self) -> Field:",
      "        return Field()",
    ];
    expect(walk(EXPR, lines, new Set(["werkzeug"])).classFieldTypes?.Expr).toEqual({ output_field: "Field" });
  });

  it("an assigned field of the same name outranks the descriptor", () => {
    const ext = walk(EXPR, [
      "from app.fields import Field, CharField",
      "",
      "class Expr:",
      "    def __init__(self):",
      "        self.output_field = CharField()",
      "",
      "    @property",
      "    def output_field(self) -> Field:",
      "        return Field()",
    ]);
    expect(ext.classFieldTypes?.Expr).toEqual({ output_field: "CharField" });
  });

  it("a union return names no single field type and records nothing", () => {
    const ext = walk(EXPR, [
      "from app.fields import Field, CharField",
      "",
      "class Expr:",
      "    @property",
      "    def output_field(self) -> Field | CharField:",
      "        return Field()",
    ]);
    expect(ext.classFieldTypes?.Expr).toBeUndefined();
  });

  describe("SQLAlchemy descriptors count only where the project declares SQLAlchemy (bd tea-rags-mcp-m99j1.1.50)", () => {
    const sqlalchemy = new Set(["sqlalchemy"]);
    const model = (decorator: string, imports: readonly string[]): readonly string[] => [
      ...imports,
      "from app.discount import Discount",
      "",
      "class Checkout:",
      `    ${decorator}`,
      "    def discount(cls) -> Mapped[Discount | None]:",
      "        return relationship()",
    ];

    it("`@declared_attr` from `sqlalchemy.orm` over `Mapped[Discount | None]` → field Discount", () => {
      const lines = model("@declared_attr", ["from sqlalchemy.orm import Mapped, declared_attr, relationship"]);
      expect(walk(EXPR, lines, sqlalchemy).classFieldTypes?.Checkout).toEqual({ discount: "Discount" });
    });

    it("the attribute form `@declared_attr.directive` qualifies", () => {
      const lines = model("@declared_attr.directive", [
        "from sqlalchemy.orm import Mapped, declared_attr, relationship",
      ]);
      expect(walk(EXPR, lines, sqlalchemy).classFieldTypes?.Checkout).toEqual({ discount: "Discount" });
    });

    it("the legacy `sqlalchemy.ext.declarative.declared_attr` qualifies", () => {
      const lines = model("@declared_attr", [
        "from sqlalchemy.ext.declarative import declared_attr",
        "from sqlalchemy.orm import Mapped, relationship",
      ]);
      expect(walk(EXPR, lines, sqlalchemy).classFieldTypes?.Checkout).toEqual({ discount: "Discount" });
    });

    it("`@hybrid_property` from `sqlalchemy.ext.hybrid` qualifies", () => {
      const lines = [
        "from sqlalchemy.ext.hybrid import hybrid_property",
        "from app.discount import Discount",
        "",
        "class Checkout:",
        "    @hybrid_property",
        "    def discount(self) -> Discount:",
        "        return self._d",
      ];
      expect(walk(EXPR, lines, sqlalchemy).classFieldTypes?.Checkout).toEqual({ discount: "Discount" });
    });

    it("records nothing where SQLAlchemy is not declared", () => {
      const lines = model("@declared_attr", ["from sqlalchemy.orm import Mapped, declared_attr, relationship"]);
      expect(walk(EXPR, lines, new Set(["flask"])).classFieldTypes?.Checkout).toBeUndefined();
    });
  });
});
