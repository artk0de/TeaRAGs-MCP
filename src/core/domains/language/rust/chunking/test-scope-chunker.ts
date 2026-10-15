/**
 * Rust attribute-based test scope chunking.
 *
 * Rust has no test DSL call to read. A `#[cfg(test)] mod` is the scope root,
 * `#[test]` (and the common attribute variants) marks an example function,
 * and the remaining direct items in the test module are setup/context. The
 * neutral kernel still owns chunk shape, ids, packing and line ranges.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type {
  BodyChunkResult,
  ChunkingHook,
  HookContext,
  TestExample,
  TestScope,
  TestScopeLine,
} from "../../../../contracts/types/chunker.js";
import { produceTestScopeChunks } from "../../kernel/index.js";
import { hasCfgTestAttribute, isRustTestFunction, isRustTestModule, leadingRustAttributes } from "./test-dsl-filter.js";

function nodeName(node: AstNode, code: string): string {
  const identifier = node.childForFieldName("name") ?? node.namedChildren.find((child) => child.type === "identifier");
  return identifier ? code.substring(identifier.startIndex, identifier.endIndex) : node.type;
}

function attributeStartLine(node: AstNode, code: string): number {
  const lines = code.split("\n");
  let start = node.startPosition.row + 1;
  for (let row = node.startPosition.row - 1; row >= 0; row--) {
    const text = lines[row]?.trim() ?? "";
    if (text.startsWith("#[") && text.endsWith("]")) {
      start = row + 1;
      continue;
    }
    if (text.length > 0) break;
  }
  return start;
}

function sourceText(node: AstNode, code: string): string {
  const lines = code.split("\n");
  const start = attributeStartLine(node, code);
  const end = node.endPosition.row + 1;
  return lines
    .slice(start - 1, end)
    .join("\n")
    .trim();
}

function sourceLine(node: AstNode, code: string): TestScopeLine {
  return {
    text: sourceText(node, code),
    sourceLine: attributeStartLine(node, code),
  };
}

function exampleOf(node: AstNode, code: string): TestExample {
  const startLine = attributeStartLine(node, code);
  return {
    name: nodeName(node, code),
    text: sourceText(node, code),
    startLine,
    endLine: node.endPosition.row + 1,
  };
}

function directDeclarations(node: AstNode): AstNode[] {
  const body = node.childForFieldName("body");
  if (body) return [...body.namedChildren];
  const declarationList = node.namedChildren.find((child) => child.type === "declaration_list");
  return declarationList ? [...declarationList.namedChildren] : [];
}

function buildRustScope(node: AstNode, code: string, pathPrefix = ""): TestScope {
  const localName = nodeName(node, code);
  const name = pathPrefix ? `${pathPrefix}.${localName}` : localName;
  const otherLines: TestScopeLine[] = [];
  const examples: TestExample[] = [];
  const children: TestScope[] = [];

  for (const child of directDeclarations(node)) {
    if (child.type === "attribute_item") continue;

    if (child.type === "mod_item") {
      children.push(buildRustScope(child, code, name));
      continue;
    }

    if (child.type === "function_item") {
      if (isRustTestFunction(child, code)) examples.push(exampleOf(child, code));
      else otherLines.push(sourceLine(child, code));
      continue;
    }

    // Constants, helper declarations and non-test statements are setup/context
    // owned by this scope. Attribute siblings are folded into their item above.
    otherLines.push(sourceLine(child, code));
  }

  return {
    name,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    setupLines: [],
    otherLines,
    examples,
    children,
  };
}

export function buildRustTestScope(containerNode: AstNode, code: string): TestScope {
  return buildRustScope(containerNode, code);
}

export function rustTestScopeChunks(
  containerNode: AstNode,
  code: string,
  filePath: string,
  config: { maxChunkSize: number; bodyChunkPrefixLength?: number },
): BodyChunkResult[] {
  const topLevelName = filePath.replace(/\\/g, "/").split("/").at(-1)?.replace(/\.rs$/, "") || "rust";
  return produceTestScopeChunks(buildRustTestScope(containerNode, code), topLevelName, config);
}

export const rustTestScopeChunkerHook: ChunkingHook = {
  name: "rust-test-scope-chunker",

  process(ctx: HookContext): void {
    if (ctx.containerNode.type !== "mod_item") return;
    if (!hasCfgTestAttribute(ctx.containerNode, ctx.code) && !isRustTestModule(ctx.containerNode, ctx.code)) return;

    const chunks = rustTestScopeChunks(ctx.containerNode, ctx.code, ctx.filePath, ctx.config);
    if (chunks.length === 0) return;
    ctx.bodyChunks = chunks;
    ctx.skipChildren = true;
  },
};

export function rustTestFunctionAttributes(node: AstNode, code: string): string[] {
  return leadingRustAttributes(node, code);
}

export function rustTestSourceText(node: AstNode, code: string): string {
  return sourceText(node, code);
}
