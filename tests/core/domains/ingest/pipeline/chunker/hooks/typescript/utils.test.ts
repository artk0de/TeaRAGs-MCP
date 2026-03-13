import Parser from "tree-sitter";
import { beforeAll, describe, expect, it } from "vitest";

import { findClassBody } from "../../../../../../../../src/core/domains/ingest/pipeline/chunker/hooks/typescript/utils.js";

let tsLang: unknown;

beforeAll(async () => {
  const tsModule = await import("tree-sitter-typescript");
  tsLang = (tsModule.default as any)?.typescript ?? (tsModule as any).typescript;
});

function parse(code: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(tsLang as any);
  return parser.parse(code);
}

describe("findClassBody", () => {
  it("returns the class_body node from a class declaration", () => {
    const code = "class Foo { x: number; }";
    const tree = parse(code);
    const classDecl = tree.rootNode.namedChildren.find((c) => c.type === "class_declaration");
    expect(classDecl).toBeDefined();

    const body = findClassBody(classDecl!);
    expect(body).not.toBeNull();
    expect(body!.type).toBe("class_body");
  });

  it("returns null when container has no class_body child", () => {
    // An interface_declaration has no class_body child
    const code = "interface Bar { x: number; }";
    const tree = parse(code);
    const ifaceDecl = tree.rootNode.namedChildren.find((c) => c.type === "interface_declaration");
    expect(ifaceDecl).toBeDefined();

    const result = findClassBody(ifaceDecl!);
    expect(result).toBeNull();
  });
});
