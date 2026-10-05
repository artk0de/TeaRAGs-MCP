/**
 * Django association fields type the class-body attribute with the MODEL they
 * point at (bd tea-rags-mcp-m99j1.1.51).
 *
 * `author = models.ForeignKey(Author, on_delete=CASCADE)` makes `book.author`
 * an `Author` instance — Django's descriptor returns the related object, never
 * the field. The vocabulary declares `ForeignKey` / `OneToOneField` under the
 * `associationFields` facet; the walker reads the FIRST argument (or `to=`):
 * a class name, a string reference `"Author"` / `"app_label.Author"`, or
 * `"self"`. `ManyToManyField` yields a related MANAGER, not the model, and is
 * never typed as the model. Gated on a declared `django`.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { CallContext, FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { PythonCallResolver } from "../../../../../../src/core/domains/language/python/resolver/python-resolver.js";
import { extractFromPythonFile } from "../../../../../../src/core/domains/language/python/walker/walker.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const DJANGO = new Set(["django"]);

function parse(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(PyLang);
  return parser.parse(src);
}

function walk(lines: readonly string[], declaredDependencies?: ReadonlySet<string>): FileExtraction {
  const src = lines.join("\n");
  return extractFromPythonFile({
    tree: parse(src),
    code: src,
    relPath: "library/models.py",
    language: "python",
    chunks: [],
    declaredDependencies,
  });
}

const MODELS = [
  "from django.db import models",
  "from django.db.models import ForeignKey",
  "from people.models import Author",
  "",
  "class Publisher(models.Model):",
  "    pass",
  "",
  "class Book(models.Model):",
  "    author = ForeignKey(Author, on_delete=models.CASCADE)",
  "    publisher = models.ForeignKey('Publisher', on_delete=models.CASCADE)",
  "    editor = models.OneToOneField(to='people.Author', on_delete=models.CASCADE)",
  "    parent = models.ForeignKey('self', null=True, on_delete=models.CASCADE)",
  "    tags = models.ManyToManyField(Author)",
  "    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)",
];

describe("Django association fields in a class body", () => {
  it("types ForeignKey / OneToOneField by their first argument (name, string, app label, self)", () => {
    const out = walk(MODELS, DJANGO);
    expect(out.classFieldTypesByClassKey?.["library/models.py::Book"]).toEqual({
      author: "Author",
      publisher: "Publisher",
      editor: "Author",
      parent: "Book",
    });
    expect(out.classFieldTypes?.Book).toEqual({
      author: "Author",
      publisher: "Publisher",
      editor: "Author",
      parent: "Book",
    });
  });

  it("never types ManyToManyField as the model — it is a related manager", () => {
    const fields = walk(MODELS, DJANGO).classFieldTypesByClassKey?.["library/models.py::Book"] ?? {};
    expect(fields.tags).toBeUndefined();
  });

  it("emits nothing where a manifest exists and does not declare django", () => {
    const fields = walk(MODELS, new Set(["flask"])).classFieldTypesByClassKey?.["library/models.py::Book"] ?? {};
    expect(fields.author).not.toBe("Author");
    expect(fields.publisher).toBeUndefined();
    expect(fields.parent).toBeUndefined();
  });

  it("book.author.name_display() resolves on Author#name_display", () => {
    const out = walk(MODELS, DJANGO);
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("people/models.py", [
      { symbolId: "Author", fqName: "Author", shortName: "Author", relPath: "people/models.py", scope: [] },
      {
        symbolId: "Author#name_display",
        fqName: "Author#name_display",
        shortName: "name_display",
        relPath: "people/models.py",
        scope: ["Author"],
      },
    ]);
    table.upsertFile("library/models.py", [
      { symbolId: "Book", fqName: "Book", shortName: "Book", relPath: "library/models.py", scope: [] },
      { symbolId: "Publisher", fqName: "Publisher", shortName: "Publisher", relPath: "library/models.py", scope: [] },
      { symbolId: "show", fqName: "show", shortName: "show", relPath: "library/models.py", scope: [] },
    ]);
    const ctx: CallContext = {
      callerFile: "library/models.py",
      callerScope: ["show"],
      imports: out.imports ?? [],
      symbolTable: table,
      localBindings: { book: [{ line: 1, type: "Book" }] },
      classFieldTypes: out.classFieldTypes,
      classFieldTypesByClassKey: out.classFieldTypesByClassKey,
      classAncestors: out.classAncestors,
    };
    const target = new PythonCallResolver().resolve(
      { callText: "book.author.name_display()", receiver: "book.author", member: "name_display", startLine: 20 },
      ctx,
    );
    expect(target).toEqual({ targetRelPath: "people/models.py", targetSymbolId: "Author#name_display" });
  });
});
