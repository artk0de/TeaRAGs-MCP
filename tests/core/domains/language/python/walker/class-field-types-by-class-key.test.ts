/**
 * The run-global, class-key-addressed field channel (R4a, bd tea-rags-mcp-f0xaa).
 *
 * `classFieldTypes` is keyed by a class's SHORT name and rides the per-file
 * extraction, so a base class's fields are unreachable from a subclass in
 * another file — the MRO fold `pythonInheritedMemberType` walks had nothing to
 * read on polar, where `SyncServiceBase.__init__` assigns `self.client` once and
 * 60-odd subclasses call it. `classFieldTypesByClassKey` is the same facts under
 * the `<relPath>::<dotted class FQ>` address `classAncestors` already uses, so a
 * linearized ancestor key looks up directly.
 *
 * Both producers are pinned here: the native walker (constructor-call RHS) and
 * the annotation facet pass (an annotated `__init__` parameter assigned to a
 * field — the shape that carried polar's hole and that the walker declines
 * because the RHS is not a call).
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { PythonLanguage } from "../../../../../../src/core/domains/language/python/index.js";
import { extractFromPythonFile } from "../../../../../../src/core/domains/language/python/walker/walker.js";

function parse(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(PyLang as unknown as Parser.Language);
  return parser.parse(src);
}

/** The native monolith alone — no facet passes. */
function native(src: string, relPath = "svc/base.py"): FileExtraction {
  return extractFromPythonFile({ tree: parse(src), code: src, relPath, language: "python", chunks: [] });
}

/** The COMPOSED walker — monolith, then the type-fact facet, then the merge. */
function composed(src: string, relPath = "svc/base.py"): FileExtraction {
  const chunks = [{ symbolId: "SyncServiceBase#__init__", startLine: 1, endLine: 40, scope: ["SyncServiceBase"] }];
  return new PythonLanguage().walker.walk({ tree: parse(src), code: src, relPath, language: "python", chunks });
}

describe("the native walker's class-key-addressed field channel", () => {
  it("keys a constructor-assigned field by file and dotted class FQ", () => {
    const out = native(["class Svc:", "    def __init__(self):", "        self.repo = Repo()"].join("\n"));
    expect(out.classFieldTypesByClassKey).toEqual({ "svc/base.py::Svc": { repo: "Repo" } });
    // The short-name channel is unchanged — the qualified one is additive.
    expect(out.classFieldTypes).toEqual({ Svc: { repo: "Repo" } });
  });

  it("spells a nested class the way classAncestors does — every named container", () => {
    const out = native(
      [
        "class Outer:",
        "    class Inner:",
        "        def __init__(self):",
        "            self.repo = Repo()",
        "",
        "def build():",
        "    class Local:",
        "        def __init__(self):",
        "            self.conn = Conn()",
      ].join("\n"),
    );
    expect(out.classFieldTypesByClassKey).toEqual({
      "svc/base.py::Outer.Inner": { repo: "Repo" },
      "svc/base.py::build.Local": { conn: "Conn" },
    });
  });

  it("attributes a field to the INNERMOST enclosing class", () => {
    const out = native(
      [
        "class Outer:",
        "    def setup(self):",
        "        self.outer_field = Repo()",
        "",
        "    class Inner:",
        "        def setup(self):",
        "            self.inner_field = Conn()",
      ].join("\n"),
    );
    expect(out.classFieldTypesByClassKey).toEqual({
      "svc/base.py::Outer": { outer_field: "Repo" },
      "svc/base.py::Outer.Inner": { inner_field: "Conn" },
    });
  });

  it("writes nothing for a module-level self assignment or an empty file", () => {
    expect(native("def go(self):\n    self.repo = Repo()\n").classFieldTypesByClassKey).toBeUndefined();
    expect(native("x = 1\n").classFieldTypesByClassKey).toBeUndefined();
  });
});

describe("an annotated __init__ parameter assigned to a field", () => {
  const POLAR = [
    "from polar.client import SyncClientBase",
    "",
    "class SyncServiceBase:",
    "    def __init__(self, client: SyncClientBase, tag, raw: object) -> None:",
    "        self.client = client",
    "        self.tag = tag",
    "        self.name = raw.name",
    "",
  ].join("\n");

  it("types the field from the parameter's annotation, on BOTH channels", () => {
    const out = composed(POLAR);
    expect(out.classFieldTypes?.SyncServiceBase?.client).toBe("SyncClientBase");
    expect(out.classFieldTypesByClassKey?.["svc/base.py::SyncServiceBase"]?.client).toBe("SyncClientBase");
  });

  it("records nothing for an UNANNOTATED parameter", () => {
    const out = composed(POLAR);
    expect(out.classFieldTypes?.SyncServiceBase?.tag).toBeUndefined();
    expect(out.classFieldTypesByClassKey?.["svc/base.py::SyncServiceBase"]?.tag).toBeUndefined();
  });

  it("records nothing for an attribute CHAIN off a parameter — one hop only", () => {
    const out = composed(POLAR);
    expect(out.classFieldTypes?.SyncServiceBase?.name).toBeUndefined();
    expect(out.classFieldTypesByClassKey?.["svc/base.py::SyncServiceBase"]?.name).toBeUndefined();
  });

  it("takes any method, not only __init__", () => {
    const src = ["class Svc:", "    def attach(self, conn: Conn) -> None:", "        self.conn = conn", ""].join("\n");
    expect(composed(src).classFieldTypesByClassKey?.["svc/base.py::Svc"]?.conn).toBe("Conn");
  });

  it("declines a parameter whose annotation has no single nominal arm", () => {
    const src = [
      "class Svc:",
      "    def attach(self, conn: Union[Conn, Other]) -> None:",
      "        self.conn = conn",
      "",
    ].join("\n");
    expect(composed(src).classFieldTypesByClassKey?.["svc/base.py::Svc"]?.conn).toBeUndefined();
  });

  it("keeps the walker's constructor answer when both producers speak", () => {
    const src = [
      "class Svc:",
      "    def __init__(self, conn: Annotated) -> None:",
      "        self.conn = Conn()",
      "        self.conn = conn",
      "",
    ].join("\n");
    expect(composed(src).classFieldTypesByClassKey?.["svc/base.py::Svc"]?.conn).toBe("Conn");
  });
});
