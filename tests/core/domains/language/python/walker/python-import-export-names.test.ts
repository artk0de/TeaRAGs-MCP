/**
 * bd tea-rags-mcp-r8hme.2 — the Python walker records the names an import takes
 * from the target module (`importedExportNames`): the imported spelling for
 * `from m import a as b`, `*` for a star import and for `import m`, which binds
 * the whole module. Python has no separate re-export syntax, so the detector
 * reads a package `__init__.py`'s imported names as what the package exposes.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import { extractFromPythonFile } from "../../../../../../src/core/domains/language/python/walker/walker.js";

function importsOf(src: string) {
  const parser = new Parser();
  parser.setLanguage(PyLang);
  return extractFromPythonFile({
    tree: parser.parse(src),
    code: src,
    relPath: "pkg/a.py",
    language: "python",
    chunks: [],
  }).imports;
}

describe("collectPythonImports — importedExportNames", () => {
  it("records each imported name by its source spelling", () => {
    const [imp] = importsOf("from pkg.core import a, b as c\n");
    expect(imp?.importedExportNames).toEqual(["a", "b"]);
  });

  it("records `*` for a star import", () => {
    expect(importsOf("from pkg.core import *\n")[0]?.importedExportNames).toEqual(["*"]);
  });

  it("records `*` for `import m`, which binds the whole module", () => {
    expect(importsOf("import pkg.core\n")[0]?.importedExportNames).toEqual(["*"]);
    expect(importsOf("import pkg.core as core\n")[0]?.importedExportNames).toEqual(["*"]);
  });

  it("records the names of a relative from-import", () => {
    expect(importsOf("from . import x, y\n")[0]?.importedExportNames).toEqual(["x", "y"]);
  });
});
