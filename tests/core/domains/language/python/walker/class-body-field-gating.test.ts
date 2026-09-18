/**
 * The class-body manager arm under the declared-dependency gate
 * (bd tea-rags-mcp-w205u.1).
 *
 * The pass has two arms and they rest on different evidence, so only one of them
 * is a framework's. `objects = SiteQuerySet.as_manager()` is evidence ONLY
 * because Django says that classmethod exposes the queryset's members — outside
 * Django the dotted call says nothing, so the arm activates off the project's own
 * manifests, exactly as a Ruby gem grammar activates off the Gemfile.
 * `objects = SiteManager()` is evidence because the name is a class the file
 * declares, which is true in any Python project; gating THAT on Django was
 * measured and cost polar — no Django, no `as_manager` — 8 real edges, so it
 * stays language-level.
 *
 * The no-manifest rule is the one every existing caller depends on: a fixture, a
 * spike or a test that threads no dependency set keeps the full vocabulary.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { extractFromPythonFile } from "../../../../../../src/core/domains/language/python/walker/walker.js";

const MODEL = [
  "from app.querysets import SiteQuerySet",
  "",
  "class SiteManager:",
  "    def for_user(self, user):",
  "        return self",
  "",
  "class Site(Model):",
  "    objects = SiteManager()",
  "    raw = SiteQuerySet.as_manager()",
];

function parse(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(PyLang);
  return parser.parse(src);
}

function native(lines: readonly string[], declaredDependencies?: ReadonlySet<string>): FileExtraction {
  const src = lines.join("\n");
  return extractFromPythonFile({
    tree: parse(src),
    code: src,
    relPath: "app/models.py",
    language: "python",
    chunks: [],
    declaredDependencies,
  });
}

describe("class-body manager typing under the dependency gate", () => {
  it("types both arms when the project declares django", () => {
    const out = native(MODEL, new Set(["django", "psycopg"]));
    expect(out.classFieldTypes).toEqual({ Site: { objects: "SiteManager", raw: "SiteQuerySet" } });
    expect(out.classFieldTypesByClassKey).toEqual({
      "app/models.py::Site": { objects: "SiteManager", raw: "SiteQuerySet" },
    });
  });

  it("drops the as_manager arm when a manifest exists and does not declare django", () => {
    const out = native(MODEL, new Set(["flask", "httpx"]));
    expect(out.classFieldTypes).toEqual({ Site: { objects: "SiteManager" } });
    expect(out.classFieldTypesByClassKey).toEqual({ "app/models.py::Site": { objects: "SiteManager" } });
  });

  it("keeps the bare-construction arm for a project that declares nothing at all", () => {
    const out = native(MODEL, new Set<string>());
    expect(out.classFieldTypes).toEqual({ Site: { objects: "SiteManager" } });
  });

  it("types both arms when NO manifest was found anywhere in the project", () => {
    const out = native(MODEL, undefined);
    expect(out.classFieldTypes).toEqual({ Site: { objects: "SiteManager", raw: "SiteQuerySet" } });
  });

  it("never touches a field the constructor binds", () => {
    const out = native(
      [
        "class SiteManager:",
        "    pass",
        "",
        "class Site:",
        "    def __init__(self):",
        "        self.helper = SiteManager()",
      ],
      new Set(["flask"]),
    );
    expect(out.classFieldTypes).toEqual({ Site: { helper: "SiteManager" } });
  });
});
