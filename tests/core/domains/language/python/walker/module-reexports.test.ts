/**
 * The `moduleReexports` channel (bd tea-rags-mcp-xpl83.3, E3 increment 2).
 *
 * netbox's `core/models/__init__.py` declares nothing and star-imports six
 * sibling modules; every caller writes `from core.models import ObjectType`.
 * The import mapper answers `core/models/__init__.py` — correct, and useless to
 * a question that ends "which file DECLARES `ObjectType`", because netbox also
 * declares an `ObjectType` in `netbox/graphql/types.py` and the disambiguation
 * filters to zero.
 *
 * The channel is what lets the mapper walk the second hop. It records every
 * `import_from_statement` in the file — a plain module re-exporting is legal
 * Python too — and the consumer only follows it when the mapped file declares
 * nothing under the name.
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

function native(lines: readonly string[], relPath = "core/models/__init__.py"): FileExtraction {
  const src = lines.join("\n");
  return extractFromPythonFile({ tree: parse(src), code: src, relPath, language: "python", chunks: [] });
}

describe("moduleReexports — one entry per name a `from` statement binds", () => {
  it("records a relative re-export under the name it binds", () => {
    expect(native(["from .object_types import ObjectType"]).moduleReexports).toEqual([
      { exportedName: "ObjectType", sourceModule: ".object_types", sourceName: "ObjectType" },
    ]);
  });

  it("records an alias under the LOCAL name and keeps the exported one as the source", () => {
    expect(native(["from .object_types import ObjectType as ContentType"]).moduleReexports).toEqual([
      { exportedName: "ContentType", sourceModule: ".object_types", sourceName: "ObjectType" },
    ]);
  });

  it("records an absolute re-export verbatim", () => {
    expect(native(["from core.models.object_types import ObjectType"]).moduleReexports).toEqual([
      { exportedName: "ObjectType", sourceModule: "core.models.object_types", sourceName: "ObjectType" },
    ]);
  });

  it("records a star as the `*` name with no source name", () => {
    expect(native(["from .object_types import *  # isort: split", "", "from .jobs import *"]).moduleReexports).toEqual([
      { exportedName: "*", sourceModule: ".object_types" },
      { exportedName: "*", sourceModule: ".jobs" },
    ]);
  });

  it("records every name of a multi-name statement", () => {
    expect(native(["from .data import DataFile, DataSource as Source"]).moduleReexports).toEqual([
      { exportedName: "DataFile", sourceModule: ".data", sourceName: "DataFile" },
      { exportedName: "Source", sourceModule: ".data", sourceName: "DataSource" },
    ]);
  });

  it("keeps the dot prefix of a parent-package import", () => {
    expect(native(["from ..jobs import Job"], "core/models/nested/__init__.py").moduleReexports).toEqual([
      { exportedName: "Job", sourceModule: "..jobs", sourceName: "Job" },
    ]);
  });

  it("records `from . import <submodule>` — the package itself is the source", () => {
    expect(native(["from . import object_types"]).moduleReexports).toEqual([
      { exportedName: "object_types", sourceModule: ".", sourceName: "object_types" },
    ]);
  });

  it("ignores a plain `import` statement — it binds a module, not a re-exported name", () => {
    expect(native(["import core.models.object_types", "import os.path as p"]).moduleReexports).toBeUndefined();
  });

  it("leaves the channel absent for a file with no `from` import", () => {
    expect(native(["class ObjectType:", "    pass"]).moduleReexports).toBeUndefined();
  });
});
