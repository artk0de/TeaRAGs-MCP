/**
 * Class-BODY field facts (bd tea-rags-mcp-xpl83, E3 increment 1).
 *
 * Every existing field collector reads `self.<field> = …` inside a method,
 * which is where Python binds INSTANCE state. Django binds a model's manager in
 * the CLASS BODY instead — `objects = ObjectTypeManager()` on `ObjectType`,
 * `objects = RestrictedQuerySet.as_manager()` on `NetBoxModel` — so nothing read
 * it and `<Model>.objects` stayed untyped on hop 1 of the chain fold. 141 of
 * netbox's 148 `chain` misses are that one shape.
 *
 * The emit rule is PROJECT-CLASS evidence, not a naming convention: the RHS must
 * name a class this file declares, or (for Django's own `as_manager` verb) a
 * name an import bound. Everything else stays SILENT rather than emitting an
 * external fact — a fact that resolves external makes `chainType` DROP where the
 * call currently falls through to a later strategy.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { extractFromPythonFile } from "../../../../../../src/core/domains/language/python/walker/walker.js";

function parse(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(PyLang);
  return parser.parse(src);
}

function native(lines: readonly string[], relPath = "app/models.py"): FileExtraction {
  const src = lines.join("\n");
  return extractFromPythonFile({ tree: parse(src), code: src, relPath, language: "python", chunks: [] });
}

describe("class-body manager attributes become field facts", () => {
  it("types `objects = <QuerySet>.as_manager()` as the queryset", () => {
    const out = native([
      "from app.querysets import SiteQuerySet",
      "",
      "class Site(Model):",
      "    objects = SiteQuerySet.as_manager()",
    ]);
    expect(out.classFieldTypes).toEqual({ Site: { objects: "SiteQuerySet" } });
    expect(out.classFieldTypesByClassKey).toEqual({ "app/models.py::Site": { objects: "SiteQuerySet" } });
  });

  it("types `objects = <Manager>()` when the manager is declared in this file", () => {
    const out = native([
      "class ObjectTypeManager(models.Manager):",
      "    def get_for_model(self, model):",
      "        return None",
      "",
      "class ObjectType(Model):",
      "    objects = ObjectTypeManager()",
    ]);
    expect(out.classFieldTypes).toEqual({ ObjectType: { objects: "ObjectTypeManager" } });
    expect(out.classFieldTypesByClassKey).toEqual({ "app/models.py::ObjectType": { objects: "ObjectTypeManager" } });
  });

  it("keeps the field name verbatim — netbox spells one of them `_objects_raw`", () => {
    const out = native([
      "class TreeManager(models.Manager):",
      "    pass",
      "",
      "class ModuleBay(Model):",
      "    _objects_raw = TreeManager()",
    ]);
    expect(out.classFieldTypes).toEqual({ ModuleBay: { _objects_raw: "TreeManager" } });
  });

  it("says NOTHING for Django's own default manager", () => {
    const out = native(["class X(Model):", "    objects = models.Manager()"]);
    expect(out.classFieldTypes).toBeUndefined();
    expect(out.classFieldTypesByClassKey).toBeUndefined();
  });

  it("says NOTHING for a field constructor", () => {
    const out = native(["class X(Model):", "    name = models.CharField(max_length=10)"]);
    expect(out.classFieldTypes).toBeUndefined();
  });

  it("records a bare ctor whose name an import bound, leaving the project test to the mapper", () => {
    // WIDENED by bd tea-rags-mcp-w205u, E4.6c: this used to assert silence on
    // the ground that "an import binding alone is not project evidence". True of
    // the walker in isolation, false of the pipeline — the fact is emitted as a
    // NAME and `resolveTypeFile` refuses one that maps outside the project. The
    // row that forced it is polar's `_client = SlackClient()` in
    // `polar/integrations/slack/service.py` (8 rows), which is spelled exactly
    // like the Django case below and differs only in where the import lands.
    const out = native(["from django.db.models import CharField", "", "class X(Model):", "    name = CharField()"]);
    expect(out.classFieldTypes).toEqual({ X: { name: "CharField" } });
  });

  it("says NOTHING for `from_queryset(…)()`, a literal, or a non-identifier LHS", () => {
    expect(native(["class X(Model):", "    objects = Manager.from_queryset(RQS)()"]).classFieldTypes).toBeUndefined();
    expect(native(["class X(Model):", "    objects = []"]).classFieldTypes).toBeUndefined();
    expect(native(["class X(Model):", "    Meta.objects = X()"]).classFieldTypes).toBeUndefined();
  });

  it("reads a CLASS BODY only — an assignment inside a method is not one", () => {
    const out = native([
      "class FooManager:",
      "    pass",
      "",
      "class X(Model):",
      "    def build(self):",
      "        objects = FooManager()",
      "        return objects",
    ]);
    expect(out.classFieldTypes).toBeUndefined();
  });

  it("attributes a nested class body to the INNERMOST class, class-key spelled by scope", () => {
    const out = native([
      "class FooManager:",
      "    pass",
      "",
      "class Outer:",
      "    class Inner(Model):",
      "        objects = FooManager()",
    ]);
    expect(out.classFieldTypes).toEqual({ Inner: { objects: "FooManager" } });
    expect(out.classFieldTypesByClassKey).toEqual({ "app/models.py::Outer.Inner": { objects: "FooManager" } });
  });

  it("yields to an explicit `self.<field>` assignment for the same field", () => {
    const out = native([
      "class FooManager:",
      "    pass",
      "",
      "class Real:",
      "    pass",
      "",
      "class X(Model):",
      "    objects = FooManager()",
      "",
      "    def __init__(self):",
      "        self.objects = Real()",
    ]);
    // A constructor assignment is the narrower statement about an instance.
    expect(out.classFieldTypes).toEqual({ X: { objects: "Real" } });
  });

  it("leaves every pre-existing `self.<field>` fact untouched", () => {
    const out = native(["class Svc:", "    def __init__(self):", "        self.repo = Repo()"], "svc/base.py");
    expect(out.classFieldTypes).toEqual({ Svc: { repo: "Repo" } });
    expect(out.classFieldTypesByClassKey).toEqual({ "svc/base.py::Svc": { repo: "Repo" } });
  });
});
