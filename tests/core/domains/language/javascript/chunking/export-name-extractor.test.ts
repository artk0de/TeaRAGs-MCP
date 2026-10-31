import { describe, expect, it } from "vitest";

import type { AstNode } from "../../../../../../src/core/contracts/types/ast.js";
import { jsExportNameExtractor } from "../../../../../../src/core/domains/language/javascript/chunking/name-extractor.js";

const CODE = "export class Widget {}";

function node(type: string, children: { type: string; name?: [number, number] }[] = []): AstNode {
  return {
    type,
    namedChildren: children.map((child) => ({
      type: child.type,
      childForFieldName: (field: string) =>
        field === "name" && child.name ? { startIndex: child.name[0], endIndex: child.name[1] } : null,
    })),
  } as unknown as AstNode;
}

describe("jsExportNameExtractor", () => {
  it("names an export_statement after the class or function declaration it exports", () => {
    expect(jsExportNameExtractor(node("export_statement", [{ type: "class_declaration", name: [13, 19] }]), CODE)).toBe(
      "Widget",
    );
  });

  it("leaves every other node type to the engine's default extraction", () => {
    expect(jsExportNameExtractor(node("class_declaration"), CODE)).toBeUndefined();
  });

  it("abstains when the export wraps no named declaration (re-export, lexical declaration)", () => {
    expect(jsExportNameExtractor(node("export_statement", [{ type: "lexical_declaration" }]), CODE)).toBeUndefined();
    expect(jsExportNameExtractor(node("export_statement"), CODE)).toBeUndefined();
  });

  it("abstains when the exported declaration carries no name field (default-exported anonymous class)", () => {
    expect(jsExportNameExtractor(node("export_statement", [{ type: "class_declaration" }]), CODE)).toBeUndefined();
  });
});
