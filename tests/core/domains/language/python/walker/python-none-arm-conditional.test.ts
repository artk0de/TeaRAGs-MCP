/**
 * A conditional expression with a `None` arm (bd tea-rags-mcp-m99j1.1.71).
 *
 * `X(...) if c else None` / `None if c else X(...)` is `Optional[X]` spelled as
 * a value. For a member call the binding reads as its non-`None` arm, the way an
 * annotated `Optional[X]` already does. The other arm is read by the rule that
 * reads a plain right-hand side, so an arm that rule cannot type leaves the
 * binding exactly as it was before.
 *
 * django `contrib/gis/geos/geometry.py`:
 * `self._cs = GEOSCoordSeq(capi.get_cs(self.ptr), self.hasz) if self.has_cs else None`.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { ChunkExtraction, FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { extractFromPythonFile } from "../../../../../../src/core/domains/language/python/walker/walker.js";

function extract(lines: readonly string[], chunkEnd?: number): FileExtraction {
  const src = lines.join("\n");
  const parser = new Parser();
  parser.setLanguage(PyLang);
  return extractFromPythonFile({
    tree: parser.parse(src),
    code: src,
    relPath: "app/svc.py",
    language: "python",
    chunks: chunkEnd === undefined ? [] : [{ symbolId: "run", startLine: 1, endLine: chunkEnd, scope: [] }],
  });
}

/** `class C:` with an `__init__` whose body is `line`. */
function inInit(line: string): FileExtraction {
  return extract(["class C:", "    def __init__(self, c, ptr):", `        ${line}`]);
}

/** The one chunk of a `def run(c):` whose body is `lines`. */
function inDef(...lines: readonly string[]): ChunkExtraction {
  const all = ["def run(c, ptr):", ...lines.map((l) => `    ${l}`)];
  return extract(all, all.length).chunks[0];
}

describe("a field assigned from a conditional with a None arm", () => {
  it("types the field as the constructed class when None is the ELSE arm", () => {
    const out = inInit("self._cs = GEOSCoordSeq(ptr, True) if c else None");
    expect(out.classFieldTypes).toEqual({ C: { _cs: "GEOSCoordSeq" } });
    expect(out.classFieldTypesByClassKey).toEqual({ "app/svc.py::C": { _cs: "GEOSCoordSeq" } });
  });

  it("types the field as the constructed class when None is the THEN arm", () => {
    expect(inInit("self._cs = None if c else GEOSCoordSeq(ptr)").classFieldTypes).toEqual({
      C: { _cs: "GEOSCoordSeq" },
    });
  });

  it("records the callee of a non-constructor call arm for the resolver to fold", () => {
    const out = inInit("self.repo = make_repo(ptr) if c else None");
    expect(out.classFieldCallResults).toEqual({ "app/svc.py::C": { repo: "make_repo" } });
    expect(out.classFieldTypes).toBeUndefined();
  });

  it("leaves the field untyped when the non-None arm is no call", () => {
    const out = inInit("self.x = ptr if c else None");
    expect(out.classFieldTypes).toBeUndefined();
    expect(out.classFieldCallResults).toBeUndefined();
  });

  it("leaves the field untyped when BOTH arms are None", () => {
    expect(inInit("self.x = None if c else None").classFieldTypes).toBeUndefined();
  });
});

describe("a local assigned from a conditional with a None arm", () => {
  it("binds the local to the constructed class", () => {
    const chunk = inDef("cs = GEOSCoordSeq(ptr) if c else None", "cs.clone()");
    expect(chunk.localBindings?.cs).toEqual([{ line: 2, type: "GEOSCoordSeq", endLine: 2 }]);
  });

  it("binds the local when None is the THEN arm", () => {
    const chunk = inDef("cs = None if c else GEOSCoordSeq(ptr)", "cs.clone()");
    expect(chunk.localBindings?.cs).toEqual([{ line: 2, type: "GEOSCoordSeq", endLine: 2 }]);
  });

  it("records the callee of a non-constructor call arm as a call-result binding", () => {
    const chunk = inDef("repo = make_repo(ptr) if c else None", "repo.save()");
    expect(chunk.localBindings?.repo).toBeUndefined();
    expect(chunk.callResultBindings?.repo).toEqual([{ line: 2, callee: "make_repo" }]);
  });

  it("binds nothing when the non-None arm is no call", () => {
    const chunk = inDef("x = ptr if c else None", "x.clone()");
    expect(chunk.localBindings?.x).toBeUndefined();
    expect(chunk.callResultBindings?.x).toBeUndefined();
  });

  it("binds nothing for a ternary with two different constructors", () => {
    const chunk = inDef("x = Alpha() if c else Beta()", "x.clone()");
    expect(chunk.localBindings?.x).toBeUndefined();
  });
});
