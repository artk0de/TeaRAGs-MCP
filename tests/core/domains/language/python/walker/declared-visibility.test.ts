/**
 * Python declared visibility (bd tea-rags-mcp-jwjyr.1). Python has no access
 * keyword; the one access rule the INTERPRETER enforces is name mangling: a
 * method named `__name` (not a dunder) inside a class body is rewritten to
 * `_Class__name`, so it is reachable by that spelling only from inside a class
 * of the same name → private. A single-underscore `_name` is a convention the
 * runtime ignores and stays unrecorded, as does every other def: recording
 * `public` for them would add no fact the narrower could use.
 */
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import { declaredVisibilityOf } from "../../__helpers__/declared-visibility.js";
import { PythonLanguage } from "../../../../../../src/core/domains/language/python/index.js";

const visibilityOf = (src: string) => declaredVisibilityOf(new PythonLanguage(), PyLang, src, "app/a.py", "python");

describe("Python walker — declared visibility", () => {
  it("marks only a name-mangled method private", () => {
    const src = [
      "class A:",
      "    def __mangled(self): pass",
      "    def _convention(self): pass",
      "    def __init__(self): pass",
      "    def plain(self): pass",
      "    @staticmethod",
      "    def __static_mangled(): pass",
      "",
    ].join("\n");
    expect(visibilityOf(src)).toEqual({ "A#__mangled": "private", "A.__static_mangled": "private" });
  });

  it("does not mark a module-level `__name` function — mangling happens only in a class body", () => {
    const src = ["def __module_level(): pass", ""].join("\n");
    expect(visibilityOf(src)).toEqual({});
  });
});
