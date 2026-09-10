/**
 * What the class-BODY field pass stays SILENT about (bd tea-rags-mcp-xpl83, E3
 * increment 1).
 *
 * The emit rule is project-class EVIDENCE, and the silence is the load-bearing
 * half: a fact naming a class the project does not declare resolves EXTERNAL,
 * which makes `chainType` DROP the call where it currently falls through to a
 * later strategy. Emitting a guess there would trade 141 recovered netbox rows
 * for an unknown number of newly-dropped ones.
 *
 * The other half is that a class body holds far more than assignments —
 * docstrings, `pass`, method definitions, decorated attributes — and every one
 * of them has to leave both channels untouched.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { extractFromPythonFile } from "../../../../../../src/core/domains/language/python/walker/walker.js";

function parse(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(PyLang as unknown as Parser.Language);
  return parser.parse(src);
}

function native(lines: readonly string[], relPath = "app/models.py"): FileExtraction {
  const src = lines.join("\n");
  return extractFromPythonFile({ tree: parse(src), code: src, relPath, language: "python", chunks: [] });
}

describe("the class-body field pass emits only on project-class evidence", () => {
  it("stays silent on `as_manager()` called on a name this file neither declares nor imports", () => {
    const out = native(["class Site(Model):", '    """A site."""', "    objects = MysteryQuerySet.as_manager()"]);

    expect(out.classFieldTypes).toBeUndefined();
    expect(out.classFieldTypesByClassKey).toBeUndefined();
  });

  it("walks past everything in a class body that is not an assignment", () => {
    const out = native([
      "from app.querysets import SiteQuerySet",
      "",
      "class Site(Model):",
      '    """The docstring is an expression statement, not an assignment."""',
      "    pass",
      "",
      "    def save(self):",
      "        # a local, not class state",
      "        objects = SiteQuerySet.as_manager()",
      "        return objects",
      "",
      "    objects = SiteQuerySet.as_manager()",
    ]);

    // Exactly one fact: the class-body binding, not the method-local one.
    expect(out.classFieldTypes).toEqual({ Site: { objects: "SiteQuerySet" } });
    expect(out.classFieldTypesByClassKey).toEqual({ "app/models.py::Site": { objects: "SiteQuerySet" } });
  });

  it("emits nothing for a class body that binds no attribute at all", () => {
    const out = native(["class Empty:", '    """Nothing here."""']);

    expect(out.classFieldTypesByClassKey).toBeUndefined();
  });
});
