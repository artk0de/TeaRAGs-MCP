/**
 * Imports under `if TYPE_CHECKING:` (bd tea-rags-mcp-r8hme.12 follow-up). The
 * guard is `False` at runtime, so what it imports is loaded only by a type
 * checker: no runtime file dependency, and a "cycle" through it is no cycle.
 * The walker keeps the import on `imports[]` — its bindings still type
 * annotations for the resolver — and flags it `typeOnly`, which routes its file
 * edge to the type-only table instead of the runtime file graph.
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

const typeOnlyByModule = (src: string) =>
  Object.fromEntries(importsOf(src).map((i) => [i.importText, i.typeOnly === true]));

describe("collectPythonImports — `if TYPE_CHECKING:` imports are type-only", () => {
  it("flags both import dialects under a bare or a qualified TYPE_CHECKING guard", () => {
    const src = [
      "from typing import TYPE_CHECKING",
      "import typing",
      "if TYPE_CHECKING:",
      "    from .models import Device",
      "    import pkg.proto",
      "if typing.TYPE_CHECKING:",
      "    from .views import View",
      "",
    ].join("\n");
    expect(typeOnlyByModule(src)).toEqual({
      typing: false,
      ".models": true,
      "pkg.proto": true,
      ".views": true,
    });
  });

  it("keeps the binding a type-only import introduces, so annotations still resolve", () => {
    const [, imp] = importsOf("from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    from .models import Device\n");
    expect(imp).toMatchObject({ importText: ".models", importedNames: ["Device"], typeOnly: true });
  });

  it("leaves the else branch, an unrelated guard and a nested function import at runtime", () => {
    const src = [
      "from typing import TYPE_CHECKING",
      "if TYPE_CHECKING:",
      "    from .a import A",
      "else:",
      "    from .b import B",
      "if DEBUG:",
      "    from .c import C",
      "def f():",
      "    from .d import D",
      "",
    ].join("\n");
    expect(typeOnlyByModule(src)).toEqual({ typing: false, ".a": true, ".b": false, ".c": false, ".d": false });
    expect(Object.keys(importsOf(src)[2] ?? {})).not.toContain("typeOnly");
  });
});
