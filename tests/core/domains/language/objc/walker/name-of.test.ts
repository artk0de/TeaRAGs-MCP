import Parser from "tree-sitter";
import ObjcLang from "tree-sitter-objc";
import { describe, expect, it } from "vitest";

import { objcNameOf } from "../../../../../../src/core/domains/language/objc/walker/name-of.js";

describe("Objective-C function names", () => {
  it.each(["void greet(int count) { consume(count); }", "char *greet(const char *value) { return value; }"])(
    "names the function rather than a parameter in %s",
    (code) => {
      const parser = new Parser();
      parser.setLanguage(ObjcLang);
      const declaration = parser.parse(code).rootNode.namedChildren[0];
      expect(objcNameOf(declaration)).toEqual({ name: "greet", descendsInto: false });
    },
  );
});
