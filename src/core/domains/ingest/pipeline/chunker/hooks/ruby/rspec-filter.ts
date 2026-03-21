/**
 * RSpec Filter Hook — Filters `call` AST nodes for RSpec-specific chunking.
 *
 * When `call` is added to Ruby's chunkableTypes, every method call becomes
 * a candidate chunk. This hook rejects non-RSpec calls and accepts only
 * known RSpec DSL methods (describe, context, it, etc.) in spec files.
 *
 * Shoulda one-liners (`it { is_expected.to ... }`) are rejected — they're
 * too small for individual chunks and belong in the body "matchers" group.
 */

import type Parser from "tree-sitter";

import type { ChunkingHook, HookContext } from "../types.js";

/** Methods that create describe/context containers */
const RSPEC_CONTAINER_METHODS = new Set([
  "describe",
  "context",
  "feature",
  "shared_examples",
  "shared_context",
  "shared_examples_for",
]);

/** Methods that create individual test examples */
const RSPEC_EXAMPLE_METHODS = new Set([
  "it",
  "specify",
  "example",
  "scenario",
  "its",
  "xit",
  "xspecify",
  "xexample",
  "fit",
  "fspecify",
  "fexample",
]);

/** All RSpec methods accepted as chunkable nodes */
const RSPEC_ALL_METHODS = new Set([...RSPEC_CONTAINER_METHODS, ...RSPEC_EXAMPLE_METHODS]);

export function isRspecFile(filePath: string): boolean {
  return filePath.endsWith("_spec.rb") || /(^|[/\\])spec[/\\]/.test(filePath);
}

function getCallMethodName(node: Parser.SyntaxNode, code: string): string | null {
  if (node.type !== "call") return null;
  const id = node.children.find((c) => c.type === "identifier");
  return id ? code.substring(id.startIndex, id.endIndex) : null;
}

/**
 * Detect shoulda one-liner: `it { ... }` with brace block and no string argument.
 */
function isShouldaOneLiner(node: Parser.SyntaxNode, code: string, methodName: string): boolean {
  if (!RSPEC_EXAMPLE_METHODS.has(methodName)) return false;
  const hasDoBlock = node.children.some((c) => c.type === "do_block");
  if (hasDoBlock) return false; // `it 'x' do ... end` is a real test
  const hasBraceBlock = node.children.some((c) => c.type === "block");
  if (!hasBraceBlock) return false;
  // Check for string argument — if present, it's a real test (`it 'x' { ... }`)
  const args = node.childForFieldName("arguments");
  if (args) {
    const hasStringArg = args.namedChildren.some((c) => c.type === "string" || c.type === "simple_string");
    if (hasStringArg) return false;
  }
  return true;
}

export const rspecFilterHook: ChunkingHook = {
  name: "rspec-filter",

  filterNode(node: Parser.SyntaxNode, code: string, filePath: string): boolean | undefined {
    if (node.type !== "call") return undefined;
    if (!isRspecFile(filePath)) return false;

    const methodName = getCallMethodName(node, code);
    if (!methodName) return false;
    if (!RSPEC_ALL_METHODS.has(methodName)) return false;

    // Reject shoulda one-liners — too small for individual chunks
    if (isShouldaOneLiner(node, code, methodName)) return false;

    return true;
  },

  process(_ctx: HookContext): void {
    // No-op — filterNode handles node filtering, body merging is done by body chunker
  },
};
