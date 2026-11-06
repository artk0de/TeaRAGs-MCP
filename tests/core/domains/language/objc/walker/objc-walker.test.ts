import Parser from "tree-sitter";
import ObjcLang from "tree-sitter-objc";
import { describe, expect, it } from "vitest";

import { extractFromObjcFile } from "../../../../../../src/core/domains/language/objc/walker/walker.js";

function parse(src: string) {
  const parser = new Parser();
  parser.setLanguage(ObjcLang);
  return parser.parse(src);
}

const src = `#import "User.h"
@implementation User
- (NSString *)greet:(NSString *)who {
  return [Bar make:who];
}
+ (instancetype)build {
  return [self new];
}
@end
`;

describe("extractFromObjcFile", () => {
  it("records #import paths and message sends", () => {
    const result = extractFromObjcFile({
      tree: parse(src),
      code: src,
      relPath: "User.m",
      language: "objc",
      chunks: [{ symbolId: "User#greet", scope: ["User"], startLine: 3, endLine: 5 }],
    });
    expect(result.imports.map((item) => item.importText)).toEqual(["User.h"]);
    expect(result.chunks[0].calls.map((call) => [call.receiver, call.member])).toEqual([["Bar", "make"]]);
    expect(result.chunks[0].symbolKind).toBe("method");
  });
});
