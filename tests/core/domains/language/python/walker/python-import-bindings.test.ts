/**
 * Import bindings on `ImportRef` (E2 seam 1, bd tea-rags-mcp-9fgdi). The walker
 * used to keep only the module text, so `from .models import Device` told a
 * resolver nothing about `Device` — the import-match strategy was left matching
 * a receiver against the module's last segment. These are the names the new
 * `importedName` strategy resolves through.
 *
 * `importText` is asserted in EVERY case: it is consumed by the file-edge
 * mapper, the external vocabulary and two persisted payload keys, and this task
 * must not move it by a byte.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import { extractFromPythonFile } from "../../../../../../src/core/domains/language/python/walker/walker.js";

function importsOf(src: string, relPath = "pkg/a.py") {
  const parser = new Parser();
  parser.setLanguage(PyLang as unknown as Parser.Language);
  const tree = parser.parse(src);
  return extractFromPythonFile({
    tree,
    code: src,
    relPath,
    language: "python",
    chunks: [],
  }).imports;
}

describe("collectPythonImports — importText is unchanged", () => {
  it("keeps the exact module text for every dialect", () => {
    expect(importsOf("import a.b\n").map((i) => i.importText)).toEqual(["a.b"]);
    expect(importsOf("import a.b as x\n").map((i) => i.importText)).toEqual(["a.b"]);
    expect(importsOf("from a import b, c\n").map((i) => i.importText)).toEqual(["a"]);
    expect(importsOf("from a import *\n").map((i) => i.importText)).toEqual(["a"]);
    expect(importsOf("from . import x\n").map((i) => i.importText)).toEqual(["."]);
    expect(importsOf("from .a import b\n").map((i) => i.importText)).toEqual([".a"]);
    expect(importsOf("from ..pkg.mod import b\n").map((i) => i.importText)).toEqual(["..pkg.mod"]);
    expect(
      importsOf("import a, b\n")
        .map((i) => i.importText)
        .sort(),
    ).toEqual(["a", "b"]);
  });
});

describe("collectPythonImports — importedNames / importedBindings", () => {
  it("`import a.b` binds the TOP package, not the submodule", () => {
    const [imp] = importsOf("import a.b\n");
    expect(imp.importedNames).toEqual(["a"]);
    expect(imp.importedBindings).toEqual({ a: "a.b" });
  });

  it("`import a` binds itself", () => {
    const [imp] = importsOf("import a\n");
    expect(imp.importedNames).toEqual(["a"]);
    expect(imp.importedBindings).toEqual({ a: "a" });
  });

  it("`import a.b as x` binds the alias to the SUBMODULE", () => {
    const [imp] = importsOf("import a.b as x\n");
    expect(imp.importedNames).toEqual(["x"]);
    expect(imp.importedBindings).toEqual({ x: "a.b" });
  });

  it("`import numpy as np` binds np → numpy", () => {
    const [imp] = importsOf("import numpy as np\n");
    expect(imp.importedBindings).toEqual({ np: "numpy" });
  });

  it("`import a, b` yields one ref per target, each with its own binding", () => {
    const imps = importsOf("import a, b\n")
      .slice()
      .sort((l, r) => l.importText.localeCompare(r.importText));
    expect(imps.map((i) => i.importedBindings)).toEqual([{ a: "a" }, { b: "b" }]);
  });

  it("`from a import b, c` binds both names identically", () => {
    const [imp] = importsOf("from a import b, c\n");
    expect(imp.importedNames).toEqual(["b", "c"]);
    expect(imp.importedBindings).toEqual({ b: "b", c: "c" });
  });

  it("`from a import b as c` maps the LOCAL name to the EXPORTED one", () => {
    const [imp] = importsOf("from a import b as c\n");
    expect(imp.importedNames).toEqual(["c"]);
    expect(imp.importedBindings).toEqual({ c: "b" });
  });

  it("`from a import *` names the star and binds no member", () => {
    const [imp] = importsOf("from a import *\n");
    expect(imp.importedNames).toEqual(["*"]);
    expect(imp.importedBindings).toBeUndefined();
  });

  it("`from . import x` keeps the package-relative name", () => {
    const [imp] = importsOf("from . import x\n", "pkg/__init__.py");
    expect(imp.importText).toBe(".");
    expect(imp.importedNames).toEqual(["x"]);
    expect(imp.importedBindings).toEqual({ x: "x" });
  });

  it("`from .models import Device, Rack as R` mixes plain and aliased", () => {
    const [imp] = importsOf("from .models import Device, Rack as R\n", "dcim/views.py");
    expect(imp.importText).toBe(".models");
    expect(imp.importedNames).toEqual(["Device", "R"]);
    expect(imp.importedBindings).toEqual({ Device: "Device", R: "Rack" });
  });

  it("parenthesised multi-line imports bind every name", () => {
    const src = "from .models import (\n    Device,\n    Rack,\n)\n";
    const [imp] = importsOf(src, "dcim/views.py");
    expect(imp.importedNames).toEqual(["Device", "Rack"]);
  });

  it("a bare side-effect import omits both channels", () => {
    const [imp] = importsOf("from a import *\n");
    expect(imp.importedBindings).toBeUndefined();
  });
});
