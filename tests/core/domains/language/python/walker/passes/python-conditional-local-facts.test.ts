/**
 * A local assigned from a conditional expression whose two arms construct
 * DIFFERENT classes (bd tea-rags-mcp-m99j1.1.77).
 *
 * `x = A(...) if c else B(...)` is `A | B` spelled as a value. The local is
 * published exactly as an annotated `x: A | B` is (bd tea-rags-mcp-m99j1.1.30):
 * a `local` type fact whose ref is the union of the arms, each qualified through
 * the declaring file's imports, so the resolver's placed-union rules decide
 * placement and fan. An arm the plain-RHS rule cannot type leaves the local
 * exactly as it was before.
 *
 * django `views/i18n.py`:
 * `response = HttpResponseRedirect(next) if next else HttpResponse(status=204)`.
 *
 * Run through `PythonLanguage`'s COMPOSED walker: the fact is a facet pass, and
 * only the composed walker runs and merges it.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { FileExtraction, LocalBinding } from "../../../../../../../src/core/contracts/types/codegraph.js";
import { PythonLanguage } from "../../../../../../../src/core/domains/language/python/index.js";

const IMPORTS = ["from pkg.http import Redirect, Response", "from pkg import models", ""];

function walk(lines: readonly string[], chunk?: { startLine: number; endLine: number }): FileExtraction {
  const src = lines.join("\n");
  const parser = new Parser();
  parser.setLanguage(PyLang);
  return new PythonLanguage().walker.walk({
    tree: parser.parse(src),
    code: src,
    relPath: "pkg/views.py",
    language: "python",
    chunks: chunk === undefined ? [] : [{ symbolId: "run", ...chunk, scope: [] }],
  });
}

/** The bindings of `name` in a `def run(c, n):` whose body is `body`. */
function bindingsIn(name: string, ...body: readonly string[]): LocalBinding[] | undefined {
  const lines = [...IMPORTS, "def run(c, n):", ...body.map((l) => `    ${l}`)];
  const out = walk(lines, { startLine: IMPORTS.length + 1, endLine: lines.length });
  return out.chunks[0]?.localBindings?.[name];
}

const DEF_LINE = IMPORTS.length + 1;

describe("a local assigned from a conditional with two differently constructed arms", () => {
  it("binds the local to the union of both arms, qualified by the file's imports", () => {
    expect(bindingsIn("r", "r = Redirect(n) if c else Response(status=204)", "r.set_cookie()")).toEqual([
      {
        line: DEF_LINE + 1,
        type: "",
        typeRef: {
          form: "union",
          members: [
            { form: "instance", name: "pkg.http::Redirect" },
            { form: "instance", name: "pkg.http::Response" },
          ],
        },
      },
    ]);
  });

  it("qualifies a module-attribute spelling through the module import", () => {
    expect(bindingsIn("f", "f = models.DateTimeField() if c else models.DateField()")?.[0]?.typeRef).toEqual({
      form: "union",
      members: [
        { form: "instance", name: "pkg.models::DateTimeField" },
        { form: "instance", name: "pkg.models::DateField" },
      ],
    });
  });

  it("keeps a same-file class arm bare, for the resolver to place by the bare rules", () => {
    expect(bindingsIn("w", "w = Local() if c else Response()")?.[0]?.typeRef).toEqual({
      form: "union",
      members: [
        { form: "instance", name: "Local" },
        { form: "instance", name: "pkg.http::Response" },
      ],
    });
  });

  it("binds the one class, spelled as written, when both arms construct the same class", () => {
    expect(bindingsIn("r", "r = Response(1) if c else Response(2)")).toEqual([
      { line: DEF_LINE + 1, type: "Response" },
    ]);
    expect(bindingsIn("f", "f = models.DateField(1) if c else models.DateField()")).toEqual([
      { line: DEF_LINE + 1, type: "models.DateField" },
    ]);
  });
});

describe("a conditional local with an arm the plain-RHS rule cannot type stays as before", () => {
  it("leaves the local unbound when one arm calls a function", () => {
    expect(bindingsIn("r", "r = Redirect(n) if c else make_response(n)")).toBeUndefined();
  });

  it("leaves the local unbound when one arm is not a call", () => {
    expect(bindingsIn("r", "r = Redirect(n) if c else n")).toBeUndefined();
    expect(bindingsIn("r", "r = Redirect(n) if c else (Response() if n else Redirect(c))")).toBeUndefined();
  });

  it("keeps the None-arm reading of m99j1.1.71 (the walker's own binding)", () => {
    expect(bindingsIn("r", "r = Redirect(n) if c else None")).toEqual([
      { line: DEF_LINE + 1, type: "Redirect", endLine: DEF_LINE + 1 },
    ]);
  });

  it("lets an annotation win over the arms", () => {
    expect(bindingsIn("r", "r: Response = Redirect(n) if c else Response()")).toEqual([
      { line: DEF_LINE + 1, type: "Response", endLine: DEF_LINE + 1 },
    ]);
  });
});

describe("a conditional with two differently constructed arms outside a function local", () => {
  it("publishes no module value and no local for a module-scope assignment", () => {
    const out = walk([...IMPORTS, "r = Redirect(1) if C else Response()", "r.go()"], {
      startLine: 1,
      endLine: IMPORTS.length + 2,
    });
    expect(out.chunks[0]?.localBindings?.["r"]).toBeUndefined();
    expect(out.moduleValueTypes).toBeUndefined();
  });

  it("types no field — a field type carries no union", () => {
    const out = walk([
      ...IMPORTS,
      "class C:",
      "    def __init__(self, c):",
      "        self.r = Redirect(1) if c else Response()",
    ]);
    expect(out.classFieldTypes).toBeUndefined();
  });
});
