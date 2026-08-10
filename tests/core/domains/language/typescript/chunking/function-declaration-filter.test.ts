/**
 * The TypeScript declaration filter + chunk classifier pair (bd
 * tea-rags-mcp-grz07).
 *
 * `symbolid-lockstep.test.ts` pins the end-to-end result — that the chunker and
 * `cg_symbols` name the same node identically. This file pins the two
 * collaborators' own contracts, because each answers a question the other cannot
 * and the engine calls them at different moments: the filter decides whether
 * `findChunkableNodes` CLAIMS a declaration (and therefore whether the walk
 * keeps descending through it), the classifier decides what the claimed node is
 * NAMED.
 */

import Parser from "tree-sitter";
import TsLang from "tree-sitter-typescript";
import { describe, expect, it } from "vitest";

import type { AstNode } from "../../../../../../src/core/contracts/types/ast.js";
import {
  typescriptChunkClassifier,
  typescriptFunctionDeclarationFilterHook,
} from "../../../../../../src/core/domains/language/typescript/chunking/index.js";
import { materializeTree } from "../../../../../../src/core/infra/materialize.js";

function parse(src: string): AstNode {
  const parser = new Parser();
  parser.setLanguage(TsLang.typescript as unknown as Parser.Language);
  return materializeTree(parser.parse(src).rootNode, src);
}

/** The first node of `type` in `src`. */
function firstNode(src: string, type: string): AstNode {
  const found: AstNode[] = [];
  const walk = (n: AstNode): void => {
    if (n.type === type) found.push(n);
    for (const child of n.children) walk(child);
  };
  walk(parse(src));
  if (found.length === 0) throw new Error(`no ${type} in source`);
  return found[0];
}

const filter = (src: string, type = "lexical_declaration"): boolean | undefined =>
  typescriptFunctionDeclarationFilterHook.filterNode?.(firstNode(src, type), src, "src/subject.ts");

describe("typescriptFunctionDeclarationFilterHook (bd tea-rags-mcp-grz07)", () => {
  it("keeps a declaration binding a module-level function", () => {
    expect(filter("export const send = (body: string) => body;\n")).toBe(true);
    expect(filter("const legacy = function () {\n  return 1;\n};\n")).toBe(true);
    expect(filter("var older = function () {\n  return 1;\n};\n", "variable_declaration")).toBe(true);
  });

  it("REJECTS a const-object namespace so the walk descends to its methods", () => {
    // Returning `false` rather than abstaining is what preserves the descent bd
    // tea-rags-mcp-62hzr depends on: the member arrives at the chunker as a
    // top-level `method_definition` only because nothing claims the declaration
    // wrapping it.
    expect(filter("export const Grouper = {\n  group(a: number) {\n    return a;\n  },\n};\n")).toBe(false);
  });

  it("REJECTS a data-only declaration and one bound to a call", () => {
    expect(filter("export const PALETTE = { red: '#f00' };\n")).toBe(false);
    expect(filter("export const t = useTranslation();\n")).toBe(false);
  });

  it("REJECTS a function-scoped const arrow", () => {
    const nested = "export function render(id: string): void {\n  const handler = () => id;\n  handler();\n}\n";
    expect(filter(nested)).toBe(false);
  });

  it("abstains on every node type it does not own", () => {
    // `undefined`, not `false` — the engine takes the FIRST non-undefined
    // verdict, so an opinion here would override the sibling filter hooks.
    const src = "export function plain(): void {}\nexport class Widget {}\n";
    expect(
      typescriptFunctionDeclarationFilterHook.filterNode?.(firstNode(src, "function_declaration"), src, "a.ts"),
    ).toBe(undefined);
    expect(typescriptFunctionDeclarationFilterHook.filterNode?.(firstNode(src, "class_declaration"), src, "a.ts")).toBe(
      undefined,
    );
  });

  it("is filter-only — `process` claims no container", () => {
    // Writing `ctx.bodyChunks` would short-circuit the rest of the hook chain
    // (`.claude/rules/chunker-hooks.md`). The no-op is the contract.
    const ctx = { bodyChunks: [] as unknown[] };
    expect(() => {
      typescriptFunctionDeclarationFilterHook.process(ctx as never);
    }).not.toThrow();
    expect(ctx.bodyChunks).toEqual([]);
  });
});

describe("typescriptChunkClassifier (bd tea-rags-mcp-grz07)", () => {
  it("emits one chunk per module-level function declarator", () => {
    const src = "export const send = (body: string) => body;\n";
    expect(typescriptChunkClassifier.classifyNode(firstNode(src, "lexical_declaration"))).toEqual({
      kind: "emit",
      chunks: [{ name: "send", symbolId: "send", chunkType: "function" }],
    });
  });

  it("emits one chunk per name in a comma list", () => {
    // A `lexical_declaration` carries no `name` field, so without the
    // classifier the engine would emit ONE anonymous `block` chunk for the whole
    // statement rather than a named chunk per declared function.
    const src = "const first = () => 1,\n  second = function () {\n    return 2;\n  };\n";
    expect(typescriptChunkClassifier.classifyNode(firstNode(src, "lexical_declaration"))).toEqual({
      kind: "emit",
      chunks: [
        { name: "first", symbolId: "first", chunkType: "function" },
        { name: "second", symbolId: "second", chunkType: "function" },
      ],
    });
  });

  it("passes through a declaration that declares no module-level function", () => {
    // Unreachable through the engine today, because the filter never lets such a
    // node be claimed — and that is exactly why it is asserted here. The two
    // collaborators are independently addressable, so the classifier must not
    // rely on the filter having run to stay correct.
    expect(
      typescriptChunkClassifier.classifyNode(
        firstNode("export const PALETTE = { red: '#f00' };\n", "lexical_declaration"),
      ),
    ).toEqual({
      kind: "passthrough",
    });
  });

  it("passes through every node type it does not own", () => {
    const src = "export function plain(): void {}\nexport class Widget {\n  run(): void {}\n}\n";
    for (const type of ["function_declaration", "class_declaration", "method_definition"]) {
      expect(typescriptChunkClassifier.classifyNode(firstNode(src, type))).toEqual({ kind: "passthrough" });
    }
  });
});
