/**
 * `fileIsInertForExtraction` — the pre-materialization gate
 * (bd tea-rags-mcp-1v12o.2.4, E6.1 FIX B).
 *
 * netbox ships `extras/data/un_locode.py`: 111,557 lines and 6.2 MB of a single
 * data table, no def, no class, no call, no import. Materializing it cost 5.33 s
 * of netbox's 11.6 s pass 1 and ~800 MB of live heap to produce an extraction
 * with nothing in it. The predicate asks the NATIVE tree — before the
 * materializer allocates a JS node per syntax node — whether the file contains
 * any node type the language's walker can turn into output.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import { fileIsInertForExtraction } from "../../../src/core/infra/extraction-fast-path.js";

/** The Python walker's own list, as `PythonLanguage` declares it. */
const PYTHON_TYPES = [
  "function_definition",
  "class_definition",
  "call",
  "import_statement",
  "import_from_statement",
  "future_import_statement",
] as const;

function root(src: string): Parser.SyntaxNode {
  const parser = new Parser();
  parser.setLanguage(PyLang as unknown as Parser.Language);
  return parser.parse(src).rootNode;
}

describe("fileIsInertForExtraction", () => {
  it("calls a pure data module inert", () => {
    const src = ["CODES = {", '    "AD": "Andorra",', '    "AE": "United Arab Emirates",', "}", ""].join("\n");
    expect(fileIsInertForExtraction(root(src), PYTHON_TYPES)).toBe(true);
  });

  it("calls an empty file inert", () => {
    expect(fileIsInertForExtraction(root(""), PYTHON_TYPES)).toBe(true);
    expect(fileIsInertForExtraction(root("# just a comment\n"), PYTHON_TYPES)).toBe(true);
  });

  it("does not call a file with a single call inert", () => {
    expect(fileIsInertForExtraction(root("configure()\n"), PYTHON_TYPES)).toBe(false);
  });

  it("does not call a file with a single def inert", () => {
    expect(fileIsInertForExtraction(root("def run():\n    pass\n"), PYTHON_TYPES)).toBe(false);
  });

  it("does not call a file with a single class inert", () => {
    expect(fileIsInertForExtraction(root("class Thing:\n    pass\n"), PYTHON_TYPES)).toBe(false);
  });

  it("does not call a file with a single import inert", () => {
    expect(fileIsInertForExtraction(root("import os\n"), PYTHON_TYPES)).toBe(false);
    expect(fileIsInertForExtraction(root("from os import path\n"), PYTHON_TYPES)).toBe(false);
  });

  it("does not call a `from __future__` import inert", () => {
    // Its own grammar node, which is why the list names it separately.
    expect(fileIsInertForExtraction(root("from __future__ import annotations\n"), PYTHON_TYPES)).toBe(false);
  });

  it("walks every file of a language that declares no list", () => {
    expect(fileIsInertForExtraction(root("CODES = {}\n"), undefined)).toBe(false);
  });
});
