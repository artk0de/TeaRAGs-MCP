import Parser from "tree-sitter";
import Ruby from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { materializeTree } from "../../../../../../src/core/domains/ingest/pipeline/chunker/materialize.js";

const SRC = `module M\n  class C < Base\n    def run(x, y = {})\n      acc = x.map { |z| z.to_s.strip }\n      helper(acc)\n    end\n  end\nend\n`;

function parse(code: string): Parser.SyntaxNode {
  const p = new Parser();
  p.setLanguage(Ruby as unknown as Parser.Language);
  return p.parse(code).rootNode;
}

// fingerprint that exercises EVERY AstNode accessor including the fragile ones
function fp(n: {
  type: string;
  startIndex: number;
  endIndex: number;
  text: string;
  childForFieldName: (f: string) => unknown;
  parent: unknown;
  namedChildCount: number;
  previousNamedSibling: unknown;
  children: readonly unknown[];
}): string {
  const fields = ["name", "body", "superclass", "parameters", "method", "receiver", "left", "right", "value"]
    .map((f) => (n.childForFieldName(f) as { type: string } | null)?.type ?? "_")
    .join(",");
  const parts = [
    `${n.type}:${n.startIndex}:${n.endIndex}:t=${n.text.length}:[${fields}]` +
      `:p=${(n.parent as { type: string } | null)?.type ?? "_"}` +
      `:pns=${(n.previousNamedSibling as { type: string } | null)?.type ?? "_"}:nc=${n.namedChildCount}`,
  ];
  for (const c of n.children) parts.push(fp(c as never));
  return parts.join("|");
}

describe("materializeTree", () => {
  it("is byte-stable across N materializations of the same native tree", () => {
    const root = parse(SRC);
    const fps = Array.from({ length: 30 }, () => fp(materializeTree(root, SRC) as never));
    expect(new Set(fps).size, `non-deterministic: ${new Set(fps).size} distinct`).toBe(1);
  });

  it("mirrors the native tree's used accessors (text via slice, fields, parent back-ref)", () => {
    const root = parse(SRC);
    const ast = materializeTree(root, SRC);
    expect(ast.type).toBe("program");
    const mod = ast.namedChild(0)!;
    expect(mod.type).toBe("module");
    expect(mod.childForFieldName("name")!.text).toBe("M");
    const cls = mod.childForFieldName("body")!.namedChild(0)!;
    expect(cls.type).toBe("class");
    expect(cls.childForFieldName("superclass")!.text).toContain("Base");
    // parent back-reference + text-on-demand correctness
    expect(cls.parent!.type).toBe("body_statement");
    expect(ast.text).toBe(SRC);
  });
});
